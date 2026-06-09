/**
 * 定时配置拉取服务（config-sync-service）
 *
 * 定期从 APS（Agent Protection Server）拉取最新配置。
 * 使用版本号机制实现增量更新：
 * - 首次拉取不带 version 参数
 * - 后续轮询带上本地版本号，服务端返回 304 表示无变化
 *
 * 支持委派模式：配置更新时通知注册的 ConfigDelegate 处理器，
 * 各子模块（如 IdaaS）通过委派模式响应配置变更。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { isAuthServiceReady } from "./auth-service.js";
import { buildUrl, buildApsHeaders } from "./utils.js";
import {
    logWarn,
    logDebug,
    logInfo,
    logError,
} from "./logger.js";
import type {
    SdkConfig,
    ConfigSyncResponse,
    ConfigDelegate,
    ConfigSyncServiceParams,
} from "./config-sync-types.js";

// Re-export public types for backward compatibility
export type { SdkConfig, ConfigSyncResponse, ConfigDelegate, ConfigSyncServiceParams } from "./config-sync-types.js";

// ============================================================================
// Constants
// ============================================================================

/** 配置拉取路径 */
const CONFIG_SYNC_PATH = "/v1/agent/config";

/** 默认拉取间隔（毫秒）：60 秒 */
const DEFAULT_CONFIG_SYNC_INTERVAL_MS = 60 * 1000;

/** 默认请求超时（毫秒） */
const DEFAULT_CONFIG_SYNC_TIMEOUT_MS = 10_000;

/** 最大允许拉取间隔（毫秒）：30 分钟，防止服务端下发异常值 */
const MAX_CONFIG_SYNC_INTERVAL_MS = 30 * 60 * 1000;

// ============================================================================
// Types (internal only)
// ============================================================================

/** 配置拉取结果（内部使用） */
type ConfigFetchResult =
    | { status: "updated"; version: number; config: SdkConfig }
    | { status: "not_modified" }
    | { status: "not_found" }
    | { status: "unauthorized"; error: string }
    | { status: "error"; error: string };

// ============================================================================
// Module-level Singleton State
// ============================================================================

/** 当前本地配置版本号（0 表示尚未拉取过） */
let localVersion = 0;

/** 当前本地配置 */
let localConfig: SdkConfig | null = null;

// ============================================================================
// Public Getters
// ============================================================================

/**
 * 获取当前已同步的远端配置
 * 未拉取到配置时返回 null
 */
export function getSdkConfig(): SdkConfig | null {
    return localConfig;
}

/**
 * 获取当前配置版本号
 * 0 表示尚未成功拉取过配置
 */
export function getSdkConfigVersion(): number {
    return localVersion;
}

// ============================================================================
// Config Fetch Logic
// ============================================================================

/**
 * 从 APS 拉取配置
 *
 * @param protectServerAddr - APS 基础地址
 * @param version - 本地配置版本号，0 时不携带 version 参数
 * @param originalFetch - 原始 fetch 函数
 * @param timeoutMs - 请求超时
 */
async function fetchConfig(
    protectServerAddr: string,
    version: number,
    originalFetch: typeof globalThis.fetch,
    timeoutMs: number,
): Promise<ConfigFetchResult> {
    // 构建 URL：首次不带 version，后续携带
    const basePath = CONFIG_SYNC_PATH;
    const queryPath = version > 0 ? `${basePath}?version=${version}` : basePath;
    const url = buildUrl(protectServerAddr, queryPath);

    const headers = buildApsHeaders();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
        logDebug("config-sync", "fetch", { url, localVersion: version });

        const resp = await originalFetch(url, {
            method: "GET",
            headers,
            signal: controller.signal,
        });

        // 304 Not Modified：配置未变化
        if (resp.status === 304) {
            logDebug("config-sync", "not_modified", { version });
            return { status: "not_modified" };
        }

        // 404 Not Found：配置尚未推送
        if (resp.status === 404) {
            logDebug("config-sync", "not_found", {});
            return { status: "not_found" };
        }

        // 401 Unauthorized：JWT 无效
        if (resp.status === 401) {
            let error = "unauthorized";
            try {
                const body = await resp.json() as { error?: string };
                error = body?.error ?? error;
            } catch {
                // ignore parse error
            }
            logWarn("config-sync", "unauthorized", { error });
            return { status: "unauthorized", error };
        }

        // 非 200 的其他错误
        if (!resp.ok) {
            logWarn("config-sync", "fetch_failed", {
                status: resp.status,
                statusText: resp.statusText,
            });
            return { status: "error", error: `HTTP ${resp.status} ${resp.statusText}` };
        }

        // 200 OK：解析配置
        const data = await resp.json() as ConfigSyncResponse;

        if (typeof data.version !== "number" || !data.config) {
            logWarn("config-sync", "invalid_response", { data });
            return { status: "error", error: "invalid response: missing version or config" };
        }

        logDebug("config-sync", "fetched", {
            newVersion: data.version,
            oldVersion: version,
            enabled: data.config.enabled,
            mode: data.config.mode,
        });

        return {
            status: "updated",
            version: data.version,
            config: data.config,
        };
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logWarn("config-sync", "fetch_error", { error: message });
        return { status: "error", error: message };
    } finally {
        clearTimeout(t);
    }
}

// ============================================================================
// Delegate Notification
// ============================================================================

/**
 * 通知所有委派处理器配置已更新
 *
 * 依次调用每个 delegate 的 onConfigUpdate，单个 delegate 失败不影响其他
 */
async function notifyDelegates(delegates: ConfigDelegate[], config: SdkConfig): Promise<void> {
    for (const delegate of delegates) {
        try {
            await delegate.onConfigUpdate(config);
            logDebug("config-sync", "delegate_notified", { id: delegate.id });
        } catch (e: unknown) {
            logError("config-sync", "delegate_error", {
                id: delegate.id,
                error: String(e instanceof Error ? e.message : e),
            });
        }
    }
}

// ============================================================================
// Service Factory
// ============================================================================

/**
 * 创建定时配置拉取服务
 */
export function createConfigSyncService(params: ConfigSyncServiceParams): OpenClawPluginService {
    const { originalFetch, protectServerAddr } = params;
    const timeoutMs = params.timeoutMs ?? DEFAULT_CONFIG_SYNC_TIMEOUT_MS;
    const delegates = params.delegates ?? [];

    let timer: NodeJS.Timeout | null = null;
    /** 当前生效的轮询间隔（毫秒） */
    let currentIntervalMs = DEFAULT_CONFIG_SYNC_INTERVAL_MS;
    /** 防止并发 syncOnce 执行 */
    let syncing = false;
    /** stop 后阻止进行中的 syncOnce 写入状态 */
    let stopped = false;

    /**
     * 重新调度定时器（当远端配置的 config_interval_s 变化时调用）
     *
     * 注意：此函数只在 syncOnce 内部调用，syncing 互斥标志保证同一时刻
     * 只有一个 syncOnce 在执行，因此 rescheduleTimer 不存在并发调用。
     */
    function rescheduleTimer(newIntervalMs: number): void {
        // clamp 到 [1s, MAX_CONFIG_SYNC_INTERVAL_MS]
        const clamped = Math.min(Math.max(newIntervalMs, 1000), MAX_CONFIG_SYNC_INTERVAL_MS);
        if (clamped !== newIntervalMs) {
            logWarn("config-sync", "interval_clamped", {
                requestedMs: newIntervalMs,
                clampedMs: clamped,
                maxMs: MAX_CONFIG_SYNC_INTERVAL_MS,
            });
        }
        if (clamped === currentIntervalMs && timer) {
            return; // 间隔未变，无需重建
        }
        if (timer) {
            clearInterval(timer);
        }
        currentIntervalMs = clamped;
        timer = setInterval(() => syncOnce().catch(() => {}), currentIntervalMs);
        timer.unref?.();
        logInfo("config-sync", "interval_updated", {
            intervalMs: currentIntervalMs,
            intervalS: currentIntervalMs / 1000,
        });
    }

    /**
     * 执行一次配置拉取并更新本地状态
     */
    async function syncOnce(): Promise<void> {
        // 认证服务未就绪时跳过
        if (!isAuthServiceReady()) {
            logDebug("config-sync", "skip", { reason: "auth service not ready" });
            return;
        }

        // 防止并发执行（定时器回调不 await，网络慢时可能重叠）
        if (syncing) {
            logDebug("config-sync", "skip", { reason: "already syncing" });
            return;
        }

        syncing = true;
        try {
            if (stopped) return;

            const result = await fetchConfig(
                protectServerAddr,
                localVersion,
                originalFetch,
                timeoutMs,
            );

            if (stopped) return;

            switch (result.status) {
                case "updated":
                    localVersion = result.version;
                    localConfig = result.config;
                    logInfo("config-sync", "config_updated", {
                        version: result.version,
                        enabled: result.config.enabled,
                        mode: result.config.mode,
                        heartbeat_interval_s: result.config.heartbeat_interval_s,
                        config_interval_s: result.config.config_interval_s,
                    });
                    logDebug("config-sync", "config_detail", {
                        version: result.version,
                        config: result.config,
                    });

                    // 根据远端配置动态调整轮询间隔
                    if (
                        typeof result.config.config_interval_s === "number" &&
                        result.config.config_interval_s > 0
                    ) {
                        rescheduleTimer(result.config.config_interval_s * 1000);
                    }

                    // 委派通知：配置更新后通知所有注册的处理器
                    if (delegates.length > 0) {
                        await notifyDelegates(delegates, result.config);
                    }
                    break;
                case "not_modified":
                    // 沿用本地配置，无需任何操作
                    break;
                case "not_found":
                    logDebug("config-sync", "config_not_available", {});
                    break;
                case "unauthorized":
                    logError("config-sync", "auth_error", { error: result.error });
                    break;
                case "error":
                    logWarn("config-sync", "sync_error", { error: result.error });
                    break;
            }
        } finally {
            syncing = false;
        }
    }

    async function startImpl(): Promise<void> {
            // 等待 auth-service 就绪
            const waitIntervalMs = 5_000;
            const maxWaitMs = 300_000; // 最多等待 5 分钟
            const startTime = Date.now();

            while (!isAuthServiceReady()) {
                if (Date.now() - startTime > maxWaitMs) {
                    logWarn("config-sync", "wait_timeout", {
                        message: "auth service not ready after 5min",
                    });
                    break;
                }
                logDebug("config-sync", "waiting_auth", {});
                await new Promise((resolve) => setTimeout(resolve, waitIntervalMs));
            }

            // auth 就绪后立即拉取一次（syncOnce 内部会根据 config_interval_s 调整定时器）
            if (isAuthServiceReady()) {
                await syncOnce().catch(() => {});
            }

            if (stopped) return;

            // 如果 syncOnce 中已经根据远端配置创建了定时器，则不再重复创建
            if (!timer) {
                timer = setInterval(() => syncOnce().catch(() => {}), currentIntervalMs);
                timer.unref?.();
            }

            logDebug("config-sync", "started", {
                intervalMs: currentIntervalMs,
                timeoutMs,
                protectServerAddr,
            });
    }

    return {
        id: "openclaw-security-assistant-config-sync",
        // fire-and-forget：不阻塞 gateway sidecar 启动
        start: (_ctx: OpenClawPluginServiceContext) => {
            stopped = false;
            void startImpl();
        },
        stop: async (_ctx: OpenClawPluginServiceContext) => {
            stopped = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            // 重置本地状态
            localVersion = 0;
            localConfig = null;
            currentIntervalMs = DEFAULT_CONFIG_SYNC_INTERVAL_MS;
        },
    };
}
