/**
 * 凭据托管 Service
 *
 * 实现两阶段工作模式：
 * Phase 1（就绪轮询）：轮询检查 CLI 和 auth profile 是否就绪
 * Phase 2（定时扫描）：定时扫描 model 的静态 API key 并执行托管
 *
 * 所有 IdaaS 文件统一持久化到 {stateDir}/alicloud-idaas/ 目录。
 *
 * Provider 注册已移至 credential-scanner.ts 通过 SecretsApplyPlan.providerUpserts
 * 原子完成，不再需要单独的 ensureIdaasSecretsProvider 调用。
 *
 * 支持通过 applyHostSecretConfig 动态启停和调整扫描间隔。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { isAuthServiceReady } from "../auth-service.js";
import { logDebug, logInfo, logWarn, logError } from "../logger.js";
import { isCliAvailable } from "./idaas-cli.js";
import { waitForIdaasAccessToken } from "./idaas-access-token-service.js";
import { runCredentialScan } from "./credential-scanner.js";
import { writeExecResolverScript } from "./exec-resolver.js";
import { writeRestoreScript } from "./credential-backup.js";
import { resolveIdaasPersistDir } from "./idaas-paths.js";

/** 就绪轮询间隔（毫秒）- 默认 10 秒 */
const DEFAULT_READINESS_CHECK_INTERVAL_MS = 10_000;

/** 就绪轮询最大等待时间（毫秒）- 默认 10 分钟 */
const DEFAULT_READINESS_MAX_WAIT_MS = 600_000;

/** 扫描间隔（毫秒）- 默认 10 分钟 */
const DEFAULT_SCAN_INTERVAL_MS = 600_000;

// ============================================================================
// Module-level Singleton State
// ============================================================================

let scanTimer: NodeJS.Timeout | null = null;
let hostingEnabled = false;
let stopped = false;
let isScanning = false;
/** stateDir captured from service context at start() */
let capturedStateDir: string | undefined;
/** IdaaS 持久化目录 */
let idaasDir: string | undefined;
/** 当前扫描间隔（毫秒） */
let currentScanIntervalMs = DEFAULT_SCAN_INTERVAL_MS;
/** 就绪轮询间隔 */
let readinessCheckIntervalMs = DEFAULT_READINESS_CHECK_INTERVAL_MS;
/** 就绪轮询最大等待时间 */
let readinessMaxWaitMs = DEFAULT_READINESS_MAX_WAIT_MS;
/** 缓存的 api 实例（用于 logger） */
let cachedApi: OpenClawPluginApi | undefined;
/** 首次启用流程是否已完成（readiness/write scripts/首次 scan） */
let bootstrapped = false;
/** 缓存的 userId（access token 中的 sub） */
let cachedUserId: string | undefined;
/** 缓存的 aiscAppId（由 coordinator 在 config update 时设置） */
let cachedAiscAppId: string | undefined;

/** Service 配置 */
export type CredentialHostingServiceConfig = {
    /** 就绪轮询间隔（毫秒） */
    readinessCheckIntervalMs?: number;
    /** 就绪轮询最大等待时间（毫秒） */
    readinessMaxWaitMs?: number;
    /** 扫描间隔（毫秒） */
    scanIntervalMs?: number;
};

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * 就绪检查：CLI 可用 + auth-service 就绪
 */
function checkReadiness(dir: string): { ready: boolean; reason?: string } {
    if (!isAuthServiceReady()) {
        return { ready: false, reason: "auth service not ready" };
    }

    if (!isCliAvailable(dir)) {
        return { ready: false, reason: "idaas-cli not available" };
    }

    return { ready: true };
}

/**
 * Phase 1: 就绪轮询
 */
async function waitForReadiness(dir: string): Promise<boolean> {
    const startTime = Date.now();

    while (!stopped && hostingEnabled) {
        const { ready, reason } = checkReadiness(dir);

        if (ready) {
            logInfo("idaas_credential_hosting", "ready", {
                waitedMs: Date.now() - startTime,
            });
            return true;
        }

        if (Date.now() - startTime > readinessMaxWaitMs) {
            logWarn("idaas_credential_hosting", "readiness_timeout", {
                reason,
                maxWaitMs: readinessMaxWaitMs,
            });
            return false;
        }

        logDebug("idaas_credential_hosting", "waiting", { reason });
        await new Promise((resolve) => setTimeout(resolve, readinessCheckIntervalMs));
    }

    return false;
}

/**
 * 执行一次扫描（带错误捕获）
 */
async function scanOnce(dir: string, userId: string): Promise<void> {
    const { ready, reason } = checkReadiness(dir);
    if (!ready) {
        logWarn("idaas_credential_hosting", "scan_skip", { reason });
        return;
    }

    try {
        const result = await runCredentialScan(dir, userId, capturedStateDir, cachedAiscAppId);

        if (result.totalStaticKeys > 0) {
            logInfo("idaas_credential_hosting", "scan_complete", {
                totalStaticKeys: result.totalStaticKeys,
                hostedCount: result.hostedCount,
                failedCount: result.failedCount,
            });
        } else {
            logDebug("idaas_credential_hosting", "scan_complete", {
                totalStaticKeys: 0,
            });
        }
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logError("idaas_credential_hosting", "scan_error", { error: errorMsg });
    }
}

/**
 * 启动定时扫描 loop
 */
function startScanLoop(dir: string, userId: string, intervalMs: number): void {
    if (scanTimer) {
        clearInterval(scanTimer);
    }
    scanTimer = setInterval(async () => {
        if (isScanning) {
            logDebug("idaas_credential_hosting", "scan_skip_in_progress", {});
            return;
        }
        isScanning = true;
        try {
            await scanOnce(dir, userId);
        } catch {
            // scanOnce 内部已有错误处理
        } finally {
            isScanning = false;
        }
    }, intervalMs);
    scanTimer.unref?.();

    logDebug("idaas_credential_hosting", "scan_loop_started", {
        intervalMs,
    });
}

/**
 * 执行首次启用流程：readiness → access-token → scripts → 首次 scan → scan loop
 */
async function bootstrap(): Promise<void> {
    if (!idaasDir || !cachedApi || !capturedStateDir) return;

    logDebug("idaas_credential_hosting", "bootstrap_start", {
        idaasDir,
        scanIntervalMs: currentScanIntervalMs,
    });

    // Phase 1: 等待就绪
    const ready = await waitForReadiness(idaasDir);
    if (!ready || stopped || !hostingEnabled) {
        logWarn("idaas_credential_hosting", "bootstrap_aborted", { ready, stopped, hostingEnabled });
        return;
    }

    // Phase 1.5: 等待 IdaaS access token
    const payload = await waitForIdaasAccessToken({
        timeoutMs: readinessMaxWaitMs,
        pollIntervalMs: readinessCheckIntervalMs,
    });
    if (!payload?.sub || stopped || !hostingEnabled) {
        logError("idaas_credential_hosting", "access_token_not_ready", {
            stopped,
            hostingEnabled,
            hasSub: !!payload?.sub,
        });
        return;
    }
    cachedUserId = payload.sub;
    logInfo("idaas_credential_hosting", "access_token_acquired", { userId: cachedUserId });

    // Phase 1.75: write exec resolver bridge script
    try {
        await writeExecResolverScript(capturedStateDir);
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logError("idaas_credential_hosting", "exec_resolver_setup_failed", { error: errorMsg });
        return;
    }

    // Phase 1.8: write standalone restore script
    if (capturedStateDir) {
        writeRestoreScript(capturedStateDir);
    }

    // Phase 2: 首次扫描
    await scanOnce(idaasDir, cachedUserId);

    // 启动定时扫描 loop
    if (!stopped && hostingEnabled) {
        startScanLoop(idaasDir, cachedUserId, currentScanIntervalMs);
        bootstrapped = true;
    }

    logInfo("idaas_credential_hosting", "started", { scanIntervalMs: currentScanIntervalMs });
}

// ============================================================================
// Public API: Dynamic Control
// ============================================================================

/**
 * 动态应用凭据托管配置（开关 + 间隔）
 *
 * - enable=true 且首次启用：执行 bootstrap 流程
 * - enable=true 且已启用、间隔变化：重建 scanTimer
 * - enable=false：仅停止扫描循环，保留已写入状态（SecretRef、exec-resolver、备份清单）
 * - intervalMs ≤ 0 或缺失时：采用默认值 DEFAULT_SCAN_INTERVAL_MS
 */
export function applyHostSecretConfig(next: { enable: boolean; intervalMs?: number; aiscAppId?: string }): void {
    if (next.aiscAppId) {
        cachedAiscAppId = next.aiscAppId;
    }

    if (next.enable) {
        // 解析并校验间隔
        let intervalMs = next.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
        if (intervalMs <= 0) {
            logWarn("idaas_credential_hosting", "invalid_interval_use_default", {
                requestedMs: intervalMs,
                defaultMs: DEFAULT_SCAN_INTERVAL_MS,
            });
            intervalMs = DEFAULT_SCAN_INTERVAL_MS;
        }

        const intervalChanged = intervalMs !== currentScanIntervalMs;
        currentScanIntervalMs = intervalMs;

        if (!hostingEnabled) {
            // 首次启用
            hostingEnabled = true;
            stopped = false;
            logInfo("idaas_credential_hosting", "enabled", { intervalMs: currentScanIntervalMs });
            void bootstrap();
        } else if (intervalChanged && bootstrapped && idaasDir && cachedUserId && cachedApi) {
            // 已启用且已 bootstrap，间隔变化 → 重建 scan loop
            logInfo("idaas_credential_hosting", "interval_updated", { intervalMs: currentScanIntervalMs });
            startScanLoop(idaasDir, cachedUserId, currentScanIntervalMs);
        }
        return;
    }

    // enable=false → disable
    if (!hostingEnabled) {
        logDebug("idaas_credential_hosting", "disable_noop", {});
        return;
    }
    hostingEnabled = false;
    if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
    }
    logInfo("idaas_credential_hosting", "disabled", {});
}

// ============================================================================
// Service Init (called by unified IdaaS service in coordinator)
// ============================================================================

/**
 * 初始化凭据托管模块状态（由统一 IdaaS service 调用）
 *
 * 设置模块级参数和 api/stateDir 缓存，实际启停由 coordinator 通过 applyHostSecretConfig 控制。
 */
export function initCredentialHostingService(params: {
    api: OpenClawPluginApi;
    stateDir: string;
    config?: CredentialHostingServiceConfig;
}): void {
    const { api, stateDir } = params;
    readinessCheckIntervalMs =
        params.config?.readinessCheckIntervalMs ?? DEFAULT_READINESS_CHECK_INTERVAL_MS;
    readinessMaxWaitMs =
        params.config?.readinessMaxWaitMs ?? DEFAULT_READINESS_MAX_WAIT_MS;
    currentScanIntervalMs =
        params.config?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    stopped = false;
    cachedApi = api;
    capturedStateDir = stateDir;
    idaasDir = resolveIdaasPersistDir(stateDir);

    logDebug("idaas_credential_hosting", "service_init", {
        readinessCheckIntervalMs,
        readinessMaxWaitMs,
        scanIntervalMs: currentScanIntervalMs,
        idaasDir,
    });
}

/**
 * 停止凭据托管模块（由统一 IdaaS service stop 调用）
 */
export function stopCredentialHostingService(): void {
    stopped = true;
    applyHostSecretConfig({ enable: false });
    bootstrapped = false;
    cachedUserId = undefined;
    logDebug("idaas_credential_hosting", "stopped", {});
}
