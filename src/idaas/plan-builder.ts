/**
 * Secrets Plan Builder (CLI-based)
 *
 * Constructs and applies SecretsApplyPlan via `openclaw secrets` CLI commands.
 * No dependency on openclaw/plugin-sdk/provider-auth or config-runtime.
 *
 * Compatibility: openclaw >= 2026.2.26 (secrets CLI initial release).
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logDebug, logInfo, logWarn, logError } from "../logger.js";
import { EXEC_RESOLVER_FILENAME } from "./exec-resolver.js";

// ──────────────── Audit types (openclaw secrets audit --json) ────────────────

export type AuditFinding = {
    code: string;
    severity: string;
    file: string;
    jsonPath: string;
    message: string;
    provider?: string;
    profileId?: string;
};

export type AuditReport = {
    version: number;
    status: string;
    resolution: {
        refsChecked: number;
        skippedExecRefs: number;
        resolvabilityComplete: boolean;
    };
    filesScanned: string[];
    summary: {
        plaintextCount: number;
        unresolvedRefCount: number;
        shadowedRefCount: number;
        legacyResidueCount: number;
    };
    findings: AuditFinding[];
};

// ──────────────── Plan types (SecretsApplyPlan format) ────────────────

export type SecretRef = {
    source: "exec";
    provider: string;
    id: string;
};

export type PlanTarget = {
    type: string;
    path: string;
    pathSegments: string[];
    ref: SecretRef;
    agentId: string;
};

export type ExecProviderConfig = {
    source: "exec";
    command: string;
    args: string[];
    timeoutMs: number;
    allowInsecurePath: boolean;
    allowSymlinkCommand: boolean;
};

type SecretsApplyPlan = {
    version: 1;
    protocolVersion: 1;
    generatedAt: string;
    generatedBy: "manual";
    providerUpserts: Record<string, ExecProviderConfig>;
    targets: PlanTarget[];
    options: {
        scrubEnv: boolean;
        scrubAuthProfilesForProviderTargets: boolean;
        scrubLegacyAuthJson: boolean;
    };
};

// ──────────────── CLI timeout ────────────────

const CLI_TIMEOUT_MS = 60_000;

// ──────────────── Known non-secret API key markers ────────────────

/**
 * Known literal markers that are NOT real secrets.
 * Matches the marker set from openclaw's isNonSecretApiKeyMarker.
 */
const KNOWN_MARKERS = new Set([
    "minimax-oauth",
    "ollama-local",
    "custom-local",
    "gcp-vertex-credentials",
    "secretref-managed",
]);

/**
 * Known environment variable names persisted as API key values.
 * This is a conservative whitelist matching openclaw's known provider env var markers.
 *
 * NOTE: Do NOT use a broad ALL_CAPS regex — the original SDK explicitly says
 * "Do not treat arbitrary ALL_CAPS values as markers; only recognize the
 *  known env-var markers we intentionally persist for compatibility."
 */
const KNOWN_ENV_VAR_MARKERS = new Set([
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY",
    "PERPLEXITY_API_KEY",
    "FIREWORKS_API_KEY",
    "NOVITA_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_API_KEY",
    "MINIMAX_CODE_PLAN_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "COHERE_API_KEY",
    "TOGETHER_API_KEY",
    "XAI_API_KEY",
]);

/**
 * Check if an API key value is a known marker (not a real secret).
 *
 * This is a lightweight local reimplementation of isNonSecretApiKeyMarker
 * from openclaw/plugin-sdk/provider-auth. Uses whitelist matching only —
 * no broad regex patterns that could misclassify real API keys.
 */
export function isNonSecretMarker(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return true;
    if (KNOWN_MARKERS.has(trimmed)) return true;
    if (trimmed.startsWith("oauth:")) return true;
    if (trimmed.startsWith("secretref-env:")) return true;
    if (KNOWN_ENV_VAR_MARKERS.has(trimmed)) return true;
    return false;
}

// ──────────────── Audit ────────────────

/**
 * Run `openclaw secrets audit --json` and parse the report.
 */
export function runSecretsAudit(): AuditReport | null {
    logDebug("idaas_plan_builder", "audit_start", {});

    const result = spawnSync("openclaw", ["secrets", "audit", "--json"], {
        encoding: "utf-8",
        timeout: CLI_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
        logError("idaas_plan_builder", "audit_spawn_error", {
            error: result.error.message,
            code: (result.error as NodeJS.ErrnoException).code,
        });
        return null;
    }

    // audit may exit non-zero on findings (exit 1 with --check, exit 2 on unresolved refs),
    // but we still need to parse the JSON output on stdout regardless of exit code
    const stdout = result.stdout?.trim();
    if (!stdout) {
        logWarn("idaas_plan_builder", "audit_empty_output", {
            status: result.status,
            stderr: result.stderr?.trim(),
        });
        return null;
    }

    try {
        const report = JSON.parse(stdout) as AuditReport;
        logDebug("idaas_plan_builder", "audit_complete", {
            status: report.status,
            plaintextCount: report.summary.plaintextCount,
            filesScanned: report.filesScanned.length,
        });
        return report;
    } catch {
        logError("idaas_plan_builder", "audit_parse_error", {
            stdoutPreview: stdout.substring(0, 200),
        });
        return null;
    }
}

/**
 * Extract auth-profile plaintext findings from audit report.
 * Only returns findings with code=PLAINTEXT_FOUND in auth-profiles.json
 * that have both profileId and provider.
 */
export function extractAuthProfileFindings(report: AuditReport): AuditFinding[] {
    return report.findings.filter(
        (f) =>
            f.code === "PLAINTEXT_FOUND" &&
            f.file.endsWith("auth-profiles.json") &&
            typeof f.profileId === "string" &&
            f.profileId.trim().length > 0 &&
            typeof f.provider === "string" &&
            f.provider.trim().length > 0,
    );
}

// ──────────────── Auth-profiles file I/O ────────────────

/**
 * Extract agentId from auth-profiles.json file path.
 *
 * Path format: {stateDir}/agents/{agentId}/agent/auth-profiles.json
 * Example: /Users/xxx/.openclaw/agents/main/agent/auth-profiles.json → "main"
 */
export function extractAgentId(authProfilesPath: string): string | null {
    const match = authProfilesPath.match(/\/agents\/([^/]+)\/agent\/auth-profiles\.json$/);
    return match?.[1] ?? null;
}

/**
 * Read actual API key value from auth-profiles.json for a given profileId.
 *
 * The audit report doesn't expose actual values (security by design),
 * so we read the file directly to get the plaintext key for IDaaS upload.
 */
export function readApiKeyFromStore(
    authProfilesPath: string,
    profileId: string,
): string | null {
    try {
        const raw = fs.readFileSync(authProfilesPath, "utf-8");
        const store = JSON.parse(raw) as Record<string, unknown>;
        const profiles = store.profiles as Record<string, Record<string, unknown>> | undefined;
        if (!profiles) return null;

        const profile = profiles[profileId];
        if (!profile) return null;

        // Only read api_key type profiles with a plaintext key and no existing keyRef
        if (profile.type !== "api_key") return null;
        if (profile.keyRef) return null;

        const key = profile.key;
        if (typeof key !== "string" || !key.trim()) return null;

        return key;
    } catch (e: unknown) {
        logWarn("idaas_plan_builder", "read_store_failed", {
            path: authProfilesPath,
            profileId,
            error: String(e instanceof Error ? e.message : e),
        });
        return null;
    }
}

// ──────────────── Plan construction ────────────────

/**
 * Build exec provider config for the idaas exec secret provider.
 *
 * @param idaasDir - IdaaS 持久化目录（{stateDir}/alicloud-idaas）
 */
export function buildExecProviderConfig(idaasDir: string): ExecProviderConfig {
    const resolverPath = path.join(idaasDir, EXEC_RESOLVER_FILENAME);
    return {
        source: "exec",
        command: process.execPath,
        args: [resolverPath],
        timeoutMs: 30_000,
        allowInsecurePath: true,
        allowSymlinkCommand: true,
    };
}

/**
 * Build a SecretsApplyPlan.
 *
 * Plan format: version=1, protocolVersion=1 (stable since 2026.2.26, never changed).
 */
export function buildPlan(params: {
    targets: PlanTarget[];
    providerConfig: ExecProviderConfig;
}): SecretsApplyPlan {
    return {
        version: 1,
        protocolVersion: 1,
        generatedAt: new Date().toISOString(),
        generatedBy: "manual",
        providerUpserts: {
            idaas: params.providerConfig,
        },
        targets: params.targets,
        options: {
            scrubEnv: true,
            scrubAuthProfilesForProviderTargets: true,
            scrubLegacyAuthJson: true,
        },
    };
}

// ──────────────── Plan apply ────────────────

/**
 * Apply a secrets plan via `openclaw secrets apply` CLI.
 *
 * Version-adaptive --allow-exec handling:
 * - 2026.3.22+: --allow-exec required for exec-containing plans
 * - 2026.2.26-2026.3.21: exec plans accepted without flag (flag didn't exist)
 *
 * Strategy: try with --allow-exec first, fall back without it if flag unknown.
 */
export function applyPlan(planPath: string): { success: boolean; error?: string; output?: string } {
    logDebug("idaas_plan_builder", "apply_start", { planPath });

    // Attempt 1: with --allow-exec (required on 2026.3.22+)
    let result = spawnSync(
        "openclaw",
        ["secrets", "apply", "--from", planPath, "--allow-exec"],
        {
            encoding: "utf-8",
            timeout: CLI_TIMEOUT_MS,
            stdio: ["ignore", "pipe", "pipe"],
        },
    );

    // If --allow-exec is not recognized (pre-2026.3.22), retry without it
    if (
        result.status !== 0 &&
        (result.stderr?.includes("allow-exec") || result.stderr?.includes("Unknown option"))
    ) {
        logDebug("idaas_plan_builder", "apply_retry_without_allow_exec", {});
        result = spawnSync(
            "openclaw",
            ["secrets", "apply", "--from", planPath],
            {
                encoding: "utf-8",
                timeout: CLI_TIMEOUT_MS,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
    }

    if (result.error) {
        logError("idaas_plan_builder", "apply_spawn_error", {
            error: result.error.message,
            code: (result.error as NodeJS.ErrnoException).code,
        });
        return { success: false, error: result.error.message };
    }

    if (result.status !== 0) {
        const stderr = result.stderr?.trim() ?? "";
        logError("idaas_plan_builder", "apply_exit_error", {
            status: result.status,
            stderr,
        });
        return { success: false, error: stderr || `exit code ${result.status}` };
    }

    const output = result.stdout?.trim() ?? "";
    logInfo("idaas_plan_builder", "apply_success", { output });
    return { success: true, output };
}

// ──────────────── Gateway hot-reload after secrets apply ────────────────

const SECRETS_RELOAD_TIMEOUT_MS = 15_000;

type ReloadAttempt = {
    success: boolean;
    warningCount?: number;
    error?: string;
    exitCode?: number | null;
};

/**
 * Attempt to hot-reload the gateway secrets runtime snapshot via
 * `openclaw secrets reload --json`, which performs an atomic snapshot
 * swap on the gateway without restarting channels/cron/heartbeat or
 * interrupting in-flight LLM requests.
 *
 * Returns null / success=false to signal the caller should fall back to SIGUSR1.
 *
 * The CLI internally calls gateway RPC `secrets.reload` (ADMIN_SCOPE)
 * and resolves the gateway auth token automatically from local config
 * (no token handling needed at this layer).
 */
function tryReloadSecretsViaCli(): ReloadAttempt {
    logDebug("idaas_plan_builder", "gateway_secrets_reload_request", {});
    const startedAt = Date.now();
    const result = spawnSync("openclaw", ["secrets", "reload", "--json"], {
        encoding: "utf-8",
        timeout: SECRETS_RELOAD_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const durationMs = Date.now() - startedAt;

    if (result.error) {
        return {
            success: false,
            error: result.error.message,
            exitCode: null,
        };
    }

    if (result.status !== 0) {
        const stderr = (result.stderr ?? "").trim();
        return {
            success: false,
            error: stderr || `exit code ${result.status}`,
            exitCode: result.status,
        };
    }

    const stdout = (result.stdout ?? "").trim();
    let warningCount: number | undefined;
    try {
        const parsed = JSON.parse(stdout) as { warningCount?: number };
        warningCount = typeof parsed.warningCount === "number" ? parsed.warningCount : undefined;
    } catch (parseErr: unknown) {
        logWarn("idaas_plan_builder", "gateway_secrets_reload_parse_error", {
            error: String(parseErr instanceof Error ? parseErr.message : parseErr),
            stdoutHead: stdout.slice(0, 200),
        });
        return { success: false, error: "json_parse_failed", exitCode: 0 };
    }

    logInfo("idaas_plan_builder", "gateway_secrets_reload_success", {
        warningCount,
        durationMs,
    });
    return { success: true, warningCount, exitCode: 0 };
}

/**
 * Request the gateway to pick up newly-written SecretRef markers.
 *
 * Strategy:
 *   1. Primary: invoke `openclaw secrets reload --json` which performs an
 *      atomic secrets snapshot swap on the gateway (no channel/cron/
 *      heartbeat rebuild, in-flight LLM requests unaffected).
 *   2. Fallback: `process.kill(pid, SIGUSR1)` — original behavior. The
 *      gateway's SIGUSR1 handler defers restart until pending operations
 *      drain, so in-flight work is not aborted; but channels/cron/
 *      heartbeat are fully rebuilt.
 *
 * The fallback guarantees downside parity with the pre-reload behavior.
 *
 * This MUST be called after a successful `secrets apply`.
 */
export function requestGatewayRestart(): { success: boolean; error?: string } {
    logDebug("idaas_plan_builder", "gateway_restart_request", { pid: process.pid });

    const reload = tryReloadSecretsViaCli();
    if (reload.success) {
        return { success: true };
    }

    const stderrHead = reload.error?.slice(0, 200);
    logWarn("idaas_plan_builder", "gateway_secrets_reload_fallback_sigusr1", {
        error: reload.error,
        exitCode: reload.exitCode,
        stderrHead,
        hint: "Falling back to SIGUSR1 gateway restart.",
    });

    try {
        process.kill(process.pid, "SIGUSR1");
        logInfo("idaas_plan_builder", "gateway_restart_sigusr1_sent", { pid: process.pid });
        return { success: true };
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logWarn("idaas_plan_builder", "gateway_restart_failed", {
            error: errorMsg,
            hint: "Run 'openclaw gateway restart' manually to pick up hosted credentials.",
        });
        return { success: false, error: errorMsg };
    }
}

// ──────────────── Plan write + apply ────────────────

/**
 * Write plan to a temp file, apply it, then clean up.
 */
export function writePlanAndApply(plan: SecretsApplyPlan): { success: boolean; error?: string } {
    const planPath = path.join(os.tmpdir(), `openclaw-idaas-plan-${crypto.randomUUID()}.json`);

    try {
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
        logDebug("idaas_plan_builder", "plan_written", { path: planPath, targets: plan.targets.length });

        return applyPlan(planPath);
    } finally {
        try {
            fs.unlinkSync(planPath);
        } catch {
            // Temp file cleanup is best-effort
        }
    }
}
