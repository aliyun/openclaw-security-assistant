/**
 * 凭据扫描器 (CLI 版本)
 *
 * 通过 `openclaw secrets audit --json` 发现明文 API key，调用 alibaba-cloud-idaas CLI 上传到
 * IdaaS Server 进行托管，然后通过 `openclaw secrets apply` 将明文 key 替换为 exec 类型的
 * SecretRef。
 *
 * 全程仅使用 openclaw CLI 和文件 I/O，不依赖 openclaw/plugin-sdk/provider-auth
 * 或 openclaw/plugin-sdk/config-runtime，兼容 openclaw >= 2026.2.26。
 */

import { logDebug, logInfo, logWarn, logError } from "../logger.js";
import { putSecret, getSecret } from "./idaas-cli.js";
import { generateCredentialId } from "./credential-id.js";
import { appendManifestEntries, type BackupEntry } from "./credential-backup.js";
import {
    runSecretsAudit,
    extractAuthProfileFindings,
    extractAgentId,
    readApiKeyFromStore,
    isNonSecretMarker,
    buildExecProviderConfig,
    buildPlan,
    writePlanAndApply,
    requestGatewayRestart,
    type AuditFinding,
    type PlanTarget,
} from "./plan-builder.js";

/** exec secret provider 名称（用于构建 SecretRef） */
const EXEC_SECRET_PROVIDER = "idaas";

/** 单条凭据托管结果 */
export type HostingResult = {
    profileId: string;
    provider: string;
    success: boolean;
    credentialId?: string;
    error?: string;
};

/** 扫描结果摘要 */
export type ScanResult = {
    /** 扫描到的静态 key 数量 */
    totalStaticKeys: number;
    /** 成功托管数量 */
    hostedCount: number;
    /** 失败数量 */
    failedCount: number;
    /** 各条结果详情 */
    details: HostingResult[];
};

/** audit finding 解析后的待托管条目 */
type HostingEntry = {
    finding: AuditFinding;
    profileId: string;
    provider: string;
    apiKey: string;
    agentId: string;
};

/**
 * 从 audit report 中提取待托管条目。
 *
 * 流程：audit findings → 过滤 auth-profile 明文 → 读取实际 key 值 → 过滤 marker。
 */
function discoverHostingEntries(): HostingEntry[] {
    const report = runSecretsAudit();
    if (!report) {
        logWarn("idaas_credential_scanner", "audit_failed", {});
        return [];
    }

    const findings = extractAuthProfileFindings(report);
    if (findings.length === 0) {
        logDebug("idaas_credential_scanner", "no_plaintext_findings", {});
        return [];
    }

    const entries: HostingEntry[] = [];

    for (const finding of findings) {
        const profileId = finding.profileId!;
        const provider = finding.provider!;

        // 从文件路径提取 agentId
        const agentId = extractAgentId(finding.file);
        if (!agentId) {
            logWarn("idaas_credential_scanner", "skip_no_agent_id", {
                file: finding.file,
                profileId,
            });
            continue;
        }

        // 从 auth-profiles.json 读取实际 key 值（audit 不暴露明文值）
        const apiKey = readApiKeyFromStore(finding.file, profileId);
        if (!apiKey) {
            logDebug("idaas_credential_scanner", "skip_no_key", { profileId, provider });
            continue;
        }

        // 过滤已知 marker（非真实密钥）
        if (isNonSecretMarker(apiKey)) {
            logDebug("idaas_credential_scanner", "skip_marker", { profileId, provider });
            continue;
        }

        entries.push({ finding, profileId, provider, apiKey, agentId });
    }

    logDebug("idaas_credential_scanner", "discovery_complete", {
        findingsCount: findings.length,
        entriesCount: entries.length,
    });

    return entries;
}

/**
 * 对单个条目执行 IDaaS 上传和校验。
 *
 * 不修改本地配置 — 配置变更统一由后续的 secrets apply plan 完成。
 */
function uploadCredential(
    entry: HostingEntry,
    idaasDir: string,
    userId: string,
    aiscAppId: string,
): { success: boolean; credentialId: string; error?: string } {
    const { profileId, provider, apiKey } = entry;
    const { aegisId, idaasId } = generateCredentialId({
        userId,
        apiKey,
        aiscAppId,
    });
    const credentialId = idaasId;

    logDebug("idaas_credential_scanner", "upload_start", { profileId, provider, credentialId, aegisId });

    // put-secret
    const putResult = putSecret({ idaasDir, credentialId, aegisId, apiKey });
    if (!putResult.success) {
        logError("idaas_credential_scanner", "upload_put_failed", {
            profileId,
            provider,
            credentialId,
            error: putResult.error,
            rawOutput: putResult.rawOutput,
        });
        return { success: false, credentialId, error: putResult.error };
    }

    // get-secret 校验
    const getResult = getSecret({ idaasDir, credentialId });
    if (!getResult.success) {
        logError("idaas_credential_scanner", "upload_verify_failed", {
            profileId,
            provider,
            credentialId,
            error: getResult.error,
            rawOutput: getResult.rawOutput,
        });
        return { success: false, credentialId, error: `verify failed: ${getResult.error}` };
    }

    logDebug("idaas_credential_scanner", "upload_success", { profileId, provider, credentialId });
    return { success: true, credentialId };
}

/**
 * 执行一次完整的扫描和托管流程（纯 CLI 版本）
 *
 * 流程：
 * 1. `openclaw secrets audit --json` → 发现明文 key
 * 2. 读取 auth-profiles.json → 获取实际 key 值，过滤 marker
 * 3. 逐个上传到 IDaaS Server（put-secret + get-secret 校验）
 * 4. 构建 SecretsApplyPlan（含 providerUpserts + targets）
 * 5. `openclaw secrets apply --from plan.json` → 原子替换明文为 SecretRef
 *
 * @returns 扫描结果摘要
 */
export async function runCredentialScan(
    idaasDir: string,
    userId: string,
    stateDir?: string,
    aiscAppId?: string,
): Promise<ScanResult> {
    if (!aiscAppId) {
        logDebug("idaas_credential_scanner", "skip_no_aisc_app_id", {});
        return { totalStaticKeys: 0, hostedCount: 0, failedCount: 0, details: [] };
    }

    // Phase 1-2: discover + read + filter
    const entries = discoverHostingEntries();

    if (entries.length === 0) {
        logDebug("idaas_credential_scanner", "no_entries", {});
        return { totalStaticKeys: 0, hostedCount: 0, failedCount: 0, details: [] };
    }

    logInfo("idaas_credential_scanner", "found_entries", {
        count: entries.length,
        providers: [...new Set(entries.map((e) => e.provider))],
    });

    // Phase 3: upload to IDaaS
    const planTargets: PlanTarget[] = [];
    const details: HostingResult[] = [];
    let hostedCount = 0;
    let failedCount = 0;

    for (const entry of entries) {
        const uploadResult = uploadCredential(entry, idaasDir, userId, aiscAppId);

        if (!uploadResult.success) {
            details.push({
                profileId: entry.profileId,
                provider: entry.provider,
                success: false,
                credentialId: uploadResult.credentialId,
                error: uploadResult.error,
            });
            failedCount++;
            continue;
        }

        // Build plan target for this credential
        planTargets.push({
            type: "auth-profiles.api_key.key",
            path: `profiles.${entry.profileId}.key`,
            pathSegments: ["profiles", entry.profileId, "key"],
            ref: {
                source: "exec",
                provider: EXEC_SECRET_PROVIDER,
                id: uploadResult.credentialId,
            },
            agentId: entry.agentId,
        });

        details.push({
            profileId: entry.profileId,
            provider: entry.provider,
            success: true,
            credentialId: uploadResult.credentialId,
        });
        hostedCount++;
    }

    // Phase 4-5: backup, build plan, and apply via CLI
    if (planTargets.length > 0) {
        // Backup plaintext keys BEFORE applying the plan.
        // If we backed up after apply and the process crashed in between,
        // the plaintext keys would be permanently lost (already replaced with
        // SecretRef but never recorded in the manifest). Backing up first is
        // safe: if the subsequent apply fails, the extra manifest entries are
        // harmless — the restore script checks keyRef before overwriting.
        if (stateDir) {
            const backupEntries: BackupEntry[] = entries
                .filter((e) => details.some((d) => d.profileId === e.profileId && d.success))
                .map((e) => ({
                    agentId: e.agentId,
                    profileId: e.profileId,
                    provider: e.provider,
                    apiKey: e.apiKey,
                    credentialId: generateCredentialId({
                        userId,
                        apiKey: e.apiKey,
                        aiscAppId,
                    }).idaasId,
                    hostedAt: new Date().toISOString(),
                }));

            if (backupEntries.length > 0) {
                const backupOk = appendManifestEntries(stateDir, backupEntries);
                if (backupOk) {
                    logInfo("idaas_credential_scanner", "backup_written", {
                        count: backupEntries.length,
                    });
                }
            }
        }

        const providerConfig = buildExecProviderConfig(idaasDir);
        const plan = buildPlan({ targets: planTargets, providerConfig });

        logInfo("idaas_credential_scanner", "applying_plan", {
            targetCount: planTargets.length,
        });

        const applyResult = writePlanAndApply(plan);

        if (!applyResult.success) {
            logError("idaas_credential_scanner", "apply_failed", {
                error: applyResult.error,
                targetCount: planTargets.length,
            });

            // Revert success → failure for all targets that were in the plan
            for (const detail of details) {
                if (detail.success) {
                    detail.success = false;
                    detail.error = `plan apply failed: ${applyResult.error}`;
                    hostedCount--;
                    failedCount++;
                }
            }
        } else {
            logInfo("idaas_credential_scanner", "apply_success", {
                targetCount: planTargets.length,
            });

            // Trigger a gateway restart so the runtime picks up the newly-hosted
            // SecretRef markers. Without this, LLM requests fail with
            // "No credentials found" until a manual restart.
            const restartResult = requestGatewayRestart();
            if (!restartResult.success) {
                logWarn("idaas_credential_scanner", "gateway_restart_failed", {
                    error: restartResult.error,
                    hint: "Credentials were hosted successfully but the gateway may need a manual restart: openclaw gateway restart",
                });
            }
        }
    }

    logInfo("idaas_credential_scanner", "scan_result", {
        totalStaticKeys: entries.length,
        hostedCount,
        failedCount,
    });

    return {
        totalStaticKeys: entries.length,
        hostedCount,
        failedCount,
        details,
    };
}
