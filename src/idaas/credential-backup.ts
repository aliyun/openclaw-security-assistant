/**
 * 凭据备份与还原
 *
 * 在 IDaaS 托管前备份明文 API key，并生成独立的 Node.js 还原脚本。
 * 备份文件存储在 {stateDir}/alicloud-idaas/ 目录下（即 ~/.openclaw/alicloud-idaas/），
 * 独立于插件安装目录，确保插件卸载后备份仍然存在。
 *
 * 还原脚本（idaas-restore.mjs）是一个独立的 ESM 脚本，不依赖插件或 Plugin SDK，
 * 可在插件卸载后直接运行 `node ~/.openclaw/alicloud-idaas/idaas-restore.mjs` 还原密钥。
 */

import fs from "node:fs";
import path from "node:path";
import { logDebug, logInfo, logWarn, logError } from "../logger.js";
import { IDAAS_PERSIST_DIR_NAME } from "./idaas-config.js";

/** Backup manifest filename */
const MANIFEST_FILENAME = "manifest.json";

/** Restore script filename */
export const RESTORE_SCRIPT_FILENAME = "idaas-restore.mjs";

// ──────────────── Module switch ────────────────

/**
 * 模块总开关：密钥备份功能默认关闭（disable）。
 *
 * 关闭时 `appendManifestEntries` 与 `writeRestoreScript` 将直接 no-op 返回 true，
 * 不会创建备份目录、manifest.json 或 idaas-restore.mjs，也不会写入任何明文密钥到磁盘。
 *
 * 通过 `setBackupEnabled(true)` 在运行时启用。
 */
let backupEnabled = false;

/** 查询备份功能是否启用 */
export function isBackupEnabled(): boolean {
    return backupEnabled;
}

/** 运行时启用/禁用备份功能 */
export function setBackupEnabled(enabled: boolean): void {
    backupEnabled = enabled;
}

// ──────────────── Types ────────────────

/** Single backup entry */
export type BackupEntry = {
    agentId: string;
    profileId: string;
    provider: string;
    apiKey: string;
    credentialId: string;
    hostedAt: string;
};

/** Backup manifest */
export type BackupManifest = {
    version: 1;
    updatedAt: string;
    entries: BackupEntry[];
};

// ──────────────── Path helpers ────────────────

/** Resolve backup directory path: {stateDir}/alicloud-idaas/ */
function resolveBackupDir(stateDir: string): string {
    return path.join(stateDir, IDAAS_PERSIST_DIR_NAME);
}

/** Resolve manifest file path */
function resolveManifestPath(stateDir: string): string {
    return path.join(resolveBackupDir(stateDir), MANIFEST_FILENAME);
}

/** Resolve restore script path */
function resolveRestoreScriptPath(stateDir: string): string {
    return path.join(resolveBackupDir(stateDir), RESTORE_SCRIPT_FILENAME);
}

// ──────────────── Manifest I/O ────────────────

/**
 * Read existing backup manifest, returns null if not found or invalid.
 */
export function readManifest(stateDir: string): BackupManifest | null {
    const manifestPath = resolveManifestPath(stateDir);
    try {
        const raw = fs.readFileSync(manifestPath, "utf-8");
        const parsed = JSON.parse(raw) as BackupManifest;
        if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
            logWarn("idaas_backup", "manifest_invalid_format", { path: manifestPath });
            return null;
        }
        return parsed;
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        logWarn("idaas_backup", "manifest_read_failed", {
            path: manifestPath,
            error: String(e instanceof Error ? e.message : e),
        });
        return null;
    }
}

/**
 * Append entries to backup manifest (incremental, dedup by agentId+profileId).
 *
 * Creates the backup directory and manifest if they don't exist.
 * File permissions: 0o600 (owner-only read/write for security — manifest contains plaintext keys).
 */
export function appendManifestEntries(stateDir: string, newEntries: BackupEntry[]): boolean {
    if (newEntries.length === 0) return true;

    if (!isBackupEnabled()) {
        logDebug("idaas_backup", "append_skipped_disabled", {
            reason: "credential backup module disabled",
            skippedEntries: newEntries.length,
        });
        return true;
    }

    const backupDir = resolveBackupDir(stateDir);
    const manifestPath = resolveManifestPath(stateDir);

    try {
        // Ensure backup directory exists (owner-only access)
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

        // Read existing manifest or start fresh
        const existing = readManifest(stateDir);
        const entries = existing?.entries ?? [];

        // Dedup: replace existing entries with same agentId+profileId
        for (const newEntry of newEntries) {
            const idx = entries.findIndex(
                (e) => e.agentId === newEntry.agentId && e.profileId === newEntry.profileId,
            );
            if (idx >= 0) {
                entries[idx] = newEntry;
            } else {
                entries.push(newEntry);
            }
        }

        const manifest: BackupManifest = {
            version: 1,
            updatedAt: new Date().toISOString(),
            entries,
        };

        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        });

        logInfo("idaas_backup", "manifest_updated", {
            path: manifestPath,
            totalEntries: entries.length,
            newEntries: newEntries.length,
        });

        return true;
    } catch (e: unknown) {
        logError("idaas_backup", "manifest_write_failed", {
            path: manifestPath,
            error: String(e instanceof Error ? e.message : e),
        });
        return false;
    }
}

// ──────────────── Restore script ────────────────

/**
 * Standalone restore script template.
 *
 * This is a self-contained Node.js ESM script that:
 * 1. Reads the backup manifest (manifest.json in the same directory)
 * 2. For each entry, locates the auth-profiles.json file
 * 3. Checks that the profile is currently managed by idaas (safety check)
 * 4. Restores the plaintext key and removes the keyRef
 *
 * No dependencies on Plugin SDK, IDaaS CLI, or any npm packages.
 */
const RESTORE_SCRIPT = `#!/usr/bin/env node
/**
 * IDaaS Credential Restore Script
 *
 * Restores plaintext API keys from the backup manifest to auth-profiles.json.
 * Run this script after uninstalling the openclaw-security-assistant plugin
 * to recover API key access.
 *
 * Usage:
 *   node idaas-restore.mjs              # restore all backed-up credentials
 *   node idaas-restore.mjs --dry-run    # preview changes without writing
 *
 * Auto-generated by openclaw-security-assistant plugin. Do not edit manually.
 */
import fs from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
// stateDir is the parent of the alicloud-idaas directory (e.g. ~/.openclaw)
const stateDir = path.resolve(__dirname, "..");
const manifestPath = path.join(__dirname, "manifest.json");
const dryRun = process.argv.includes("--dry-run");

function log(msg) {
    const ts = new Date().toISOString();
    console.log(\`[\${ts}] \${msg}\`);
}

function logErr(msg) {
    const ts = new Date().toISOString();
    console.error(\`[\${ts}] ERROR: \${msg}\`);
}

// ── Read manifest ──
let manifest;
try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    manifest = JSON.parse(raw);
} catch (e) {
    logErr(\`Failed to read manifest: \${manifestPath}\`);
    logErr(String(e.message || e));
    process.exit(1);
}

if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    logErr("Invalid manifest format");
    process.exit(1);
}

log(\`Found \${manifest.entries.length} credential(s) to restore\`);
if (dryRun) {
    log("[DRY RUN] No changes will be made");
}

let restored = 0;
let skipped = 0;
let failed = 0;

for (const entry of manifest.entries) {
    const { agentId, profileId, provider, apiKey } = entry;
    const authProfilesPath = path.join(stateDir, "agents", agentId, "agent", "auth-profiles.json");

    log(\`Processing: agent=\${agentId} provider=\${provider} profile=\${profileId}\`);

    // Read auth-profiles.json
    let store;
    try {
        const raw = fs.readFileSync(authProfilesPath, "utf-8");
        store = JSON.parse(raw);
    } catch (e) {
        if (e.code === "ENOENT") {
            log(\`  SKIP: auth-profiles.json not found for agent \${agentId}\`);
            skipped++;
            continue;
        }
        logErr(\`  FAIL: cannot read \${authProfilesPath}: \${e.message}\`);
        failed++;
        continue;
    }

    const profile = store?.profiles?.[profileId];
    if (!profile) {
        log(\`  SKIP: profile \${profileId} not found in auth-profiles.json\`);
        skipped++;
        continue;
    }

    // Safety check: only restore if currently pointing to idaas exec provider
    const keyRef = profile.keyRef;
    if (!keyRef || keyRef.source !== "exec" || keyRef.provider !== "idaas") {
        log(\`  SKIP: profile \${profileId} is not managed by idaas (keyRef=\${JSON.stringify(keyRef)})\`);
        skipped++;
        continue;
    }

    if (dryRun) {
        log(\`  [DRY RUN] Would restore plaintext key for \${provider}/\${profileId}\`);
        restored++;
        continue;
    }

    // Restore: set key to plaintext, remove keyRef
    try {
        profile.key = apiKey;
        delete profile.keyRef;
        fs.writeFileSync(authProfilesPath, JSON.stringify(store, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        });
        log(\`  OK: restored plaintext key for \${provider}/\${profileId}\`);
        restored++;
    } catch (e) {
        logErr(\`  FAIL: cannot write \${authProfilesPath}: \${e.message}\`);
        failed++;
    }
}

// ── Clean up idaas exec provider registration ──
if (restored > 0 && !dryRun) {
    log("");
    log("Cleaning up idaas secrets provider registration...");
    try {
        const result = spawnSync(
            "openclaw",
            ["config", "unset", "secrets.providers.idaas"],
            { encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] },
        );
        if (result.status === 0) {
            log("  OK: removed secrets.providers.idaas from config");
        } else {
            // Non-fatal: provider entry is harmless if it stays
            log(\`  WARN: could not remove secrets.providers.idaas (exit \${result.status}): \${(result.stderr || "").trim()}\`);
        }
    } catch (e) {
        log(\`  WARN: could not remove secrets.providers.idaas: \${e.message}\`);
    }
}

log("");
log(\`Restore complete: \${restored} restored, \${skipped} skipped, \${failed} failed\`);
if (restored > 0 && !dryRun) {
    log("");
    log("Please restart OpenClaw Gateway to apply the restored credentials:");
    log("  openclaw gateway restart");
}
if (failed > 0) {
    process.exit(1);
}
`;

/**
 * Write the standalone restore script to the backup directory.
 *
 * Creates the backup directory if it doesn't exist.
 * Script is set executable (0o755) so it can be run directly on Unix.
 */
export function writeRestoreScript(stateDir: string): boolean {
    if (!isBackupEnabled()) {
        logDebug("idaas_backup", "restore_script_skipped_disabled", {
            reason: "credential backup module disabled",
        });
        return true;
    }

    const backupDir = resolveBackupDir(stateDir);
    const scriptPath = resolveRestoreScriptPath(stateDir);

    try {
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(scriptPath, RESTORE_SCRIPT, { encoding: "utf-8", mode: 0o755 });

        logInfo("idaas_backup", "restore_script_written", { path: scriptPath });
        return true;
    } catch (e: unknown) {
        logError("idaas_backup", "restore_script_write_failed", {
            path: scriptPath,
            error: String(e instanceof Error ? e.message : e),
        });
        return false;
    }
}
