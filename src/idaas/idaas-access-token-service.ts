/**
 * IdaaS Access Token 刷新 Service
 *
 * 模块级单例：
 * - 按固定 exchange interval 或 JWT exp 提前量（取较小值）周期性刷新 access token
 * - 单次 fetch 失败时走指数退避（5s → 10s → 20s），全失败回退 30s 后整轮重试
 * - 对外暴露 applyAccessTokenConfig 函数，可动态启停并调整刷新间隔
 * - 缓存最近一次成功获取的 rawToken / payload，供其他模块读取
 *
 * 生命周期由调用方（通常是 index.ts 的 api.registerService）控制；
 * credential-hosting-service 只读取 token，不负责启动或关闭。
 */

import { fetchAccessToken, type AccessTokenResult, type JwtPayload } from "./idaas-cli.js";
import { resolveIdaasPersistDir } from "./idaas-paths.js";
import { logDebug, logInfo, logWarn, logError } from "../logger.js";
import { promises as fs } from "node:fs";
import path from "node:path";

/** 提前刷新量：到期前 60s 触发下一次 refresh */
const REFRESH_LEAD_MS = 60_000;

/** 调度兜底最小延迟：避免 exp 过近导致的 0 延迟忙循环 */
const MIN_REFRESH_DELAY_MS = 1_000;

/** 单次获取最大重试次数（总尝试 = 1 + MAX_RETRIES） */
const ACCESS_TOKEN_MAX_RETRIES = 3;

/** 指数退避基础延迟：5s → 10s → 20s */
const ACCESS_TOKEN_RETRY_BASE_MS = 5_000;

/** 单次获取全部失败后的回退重试间隔 */
const REFRESH_FAILURE_FALLBACK_MS = 30_000;

/** 心跳检查周期默认值（也用作 exchange_interval_s ≤ 0 时的默认刷新间隔） */
const DEFAULT_EXCHANGE_INTERVAL_MS = 30_000;

/**
 * 心跳检查周期：作为精准 setTimeout 的兜底。
 * 必须 ≤ REFRESH_LEAD_MS，保证"主 timer 失效"时心跳仍能在过期前刷到。
 * 场景：系统休眠唤醒、时钟跳变、setTimeout 被平台延迟触发等。
 */
const HEARTBEAT_INTERVAL_MS = DEFAULT_EXCHANGE_INTERVAL_MS;

/** waitForIdaasAccessToken 默认轮询间隔 */
const DEFAULT_WAIT_POLL_INTERVAL_MS = 1_000;

/** Access token 持久化文件名（存放于 idaasDir 下，权限 0o600） */
const ACCESS_TOKEN_PERSIST_FILENAME = ".access_token";

// ──────────────── 模块级状态 ────────────────

let idaasDir: string | null = null;
let enabled = false;
let refreshTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let refreshInFlight: Promise<AccessTokenResult> | null = null;
let cachedRawToken: string | null = null;
let cachedPayload: JwtPayload | null = null;
/** 当前配置的固定刷新间隔（毫秒），0 表示未配置（仅按 exp 调度） */
let currentExchangeIntervalMs = 0;

// ──────────────── 对外 API ────────────────

/**
 * 一次性注入 stateDir，计算并缓存 idaasDir。
 * 允许重复调用以更新目录（例如 gateway restart 场景）。
 */
export function initIdaasAccessTokenService(params: { stateDir: string }): void {
    idaasDir = resolveIdaasPersistDir(params.stateDir);
    logDebug("idaas_access_token", "init", { idaasDir });
}

/**
 * 动态应用 access token 配置（开关 + 间隔）
 *
 * - enable=true：若未运行则立刻触发首次 refreshLoop；若已运行且间隔变化则重新调度
 * - enable=false：清掉 refreshTimer 和 heartbeat，保留 cache 供读取
 * - intervalMs ≤ 0 或缺失时：采用默认值 DEFAULT_EXCHANGE_INTERVAL_MS
 *
 * 必须先 init 再 enable；否则仅记录 warn。
 */
export function applyAccessTokenConfig(next: { enable: boolean; intervalMs?: number }): void {
    if (next.enable) {
        if (!idaasDir) {
            logWarn("idaas_access_token", "enable_without_init", {});
            return;
        }

        // 解析并校验间隔
        let intervalMs = next.intervalMs ?? DEFAULT_EXCHANGE_INTERVAL_MS;
        if (intervalMs <= 0) {
            logWarn("idaas_access_token", "invalid_interval_use_default", {
                requestedMs: intervalMs,
                defaultMs: DEFAULT_EXCHANGE_INTERVAL_MS,
            });
            intervalMs = DEFAULT_EXCHANGE_INTERVAL_MS;
        }

        const intervalChanged = intervalMs !== currentExchangeIntervalMs;
        currentExchangeIntervalMs = intervalMs;

        if (!enabled) {
            // 首次启用
            enabled = true;
            logInfo("idaas_access_token", "enabled", { intervalMs: currentExchangeIntervalMs });
            startHeartbeat();
            void refreshLoop();
        } else if (intervalChanged) {
            // 已启用但间隔变化 → 重新调度
            logInfo("idaas_access_token", "interval_updated", { intervalMs: currentExchangeIntervalMs });
            scheduleNextRefresh(cachedPayload);
        }
        return;
    }

    // enable=false → disable
    if (!enabled) {
        logDebug("idaas_access_token", "disable_noop", {});
        return;
    }
    enabled = false;
    currentExchangeIntervalMs = 0;
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
    stopHeartbeat();
    logInfo("idaas_access_token", "disabled", {});
}

/**
 * 向后兼容的开关 thin wrapper
 * @deprecated 优先使用 applyAccessTokenConfig
 */
export function setIdaasAccessTokenRefreshEnabled(next: boolean): void {
    applyAccessTokenConfig({ enable: next });
}

/** 返回最近一次成功获取的 raw JWT；未就绪返回 null */
export function getIdaasAccessToken(): string | null {
    return cachedRawToken;
}

/** 返回最近一次成功获取的 JWT payload；未就绪返回 null */
export function getIdaasAccessTokenPayload(): JwtPayload | null {
    return cachedPayload;
}

/** payload 存在、sub 存在、且未过期 */
export function isIdaasAccessTokenReady(): boolean {
    if (!cachedPayload?.sub) return false;
    const exp = typeof cachedPayload.exp === "number" ? cachedPayload.exp : undefined;
    if (exp !== undefined && exp * 1000 <= Date.now()) return false;
    return true;
}

/**
 * 轮询等待 access token 就绪，超时返回 null。
 * 供 credential-hosting-service 在 start() 中使用。
 */
export async function waitForIdaasAccessToken(opts: {
    timeoutMs: number;
    pollIntervalMs?: number;
}): Promise<JwtPayload | null> {
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
    const startTime = Date.now();

    while (true) {
        if (isIdaasAccessTokenReady()) {
            return cachedPayload;
        }
        if (Date.now() - startTime >= opts.timeoutMs) {
            return null;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
}

// ──────────────── 内部实现 ────────────────

/**
 * 启动心跳兜底 setInterval。
 * 周期 ≤ REFRESH_LEAD_MS，到点判断 cache 是否就绪 / 剩余时间是否进入提前量窗口，
 * 若满足则补偿触发 refreshLoop（refreshInFlight 互斥，不会与主 setTimeout 并发）。
 */
function startHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
        if (!enabled) return;
        if (refreshInFlight) return;

        const exp = typeof cachedPayload?.exp === "number" ? cachedPayload.exp : undefined;
        const remainMs = exp === undefined ? -1 : exp * 1000 - Date.now();
        const needRefresh = !isIdaasAccessTokenReady() || remainMs <= REFRESH_LEAD_MS;
        if (needRefresh) {
            logDebug("idaas_access_token", "heartbeat_trigger_refresh", {
                remainMs,
                ready: isIdaasAccessTokenReady(),
            });
            void refreshLoop();
        }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
}

function stopHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

/**
 * 将最新的 rawToken 持久化到 {idaasDir}/.access_token。
 * 原子写：先写临时文件再 rename，权限 0o600。
 * 失败只记录日志，不影响内存 cache。
 */
async function persistAccessToken(rawToken: string): Promise<void> {
    if (!idaasDir) return;
    const filePath = path.join(idaasDir, ACCESS_TOKEN_PERSIST_FILENAME);
    const tmpPath = `${filePath}.tmp`;
    try {
        await fs.mkdir(idaasDir, { recursive: true });
        await fs.writeFile(tmpPath, rawToken, { encoding: "utf-8", mode: 0o600 });
        await fs.rename(tmpPath, filePath);
        // rename 不一定保留 mode（跨 fs 场景），显式再 chmod 兜底
        await fs.chmod(filePath, 0o600).catch(() => {});
        logDebug("idaas_access_token", "persisted", { filePath });
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logError("idaas_access_token", "persist_failed", { filePath, error: errorMsg });
        // 清理可能残留的临时文件
        await fs.unlink(tmpPath).catch(() => {});
    }
}

/**
 * 带指数退避重试的单次 AccessToken 获取。
 * 退避：5s → 10s → 20s。中途被关闭则立即中止。
 */
async function fetchAccessTokenWithRetry(dir: string): Promise<AccessTokenResult> {
    let lastResult: AccessTokenResult = { success: false, error: "not attempted" };

    for (let attempt = 0; attempt <= ACCESS_TOKEN_MAX_RETRIES; attempt++) {
        if (!enabled) {
            return { success: false, error: "service disabled during access token retry" };
        }

        lastResult = fetchAccessToken({ idaasDir: dir });

        if (lastResult.success && lastResult.payload?.sub) {
            return lastResult;
        }

        if (attempt >= ACCESS_TOKEN_MAX_RETRIES) {
            break;
        }

        const delayMs = ACCESS_TOKEN_RETRY_BASE_MS * Math.pow(2, attempt);
        logWarn("idaas_access_token", "retry", {
            attempt: attempt + 1,
            maxRetries: ACCESS_TOKEN_MAX_RETRIES,
            delayMs,
            error: lastResult.error,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return lastResult;
}

/**
 * 根据 payload 中的 exp（秒）和当前配置的 exchange interval 调度下一次 refresh。
 *
 * 公式：delay = max(MIN_REFRESH_DELAY_MS, min(fixedInterval, expDelay))
 * - fixedInterval = currentExchangeIntervalMs（0 表示不限制，使用 Infinity）
 * - expDelay = exp*1000 - now - REFRESH_LEAD_MS
 *
 * 语义：按固定周期为主，若固定周期会越过 exp 提前量窗口，则提前调度。
 */
function scheduleNextRefresh(payload: JwtPayload | null): void {
    if (!enabled) return;
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }

    const exp = typeof payload?.exp === "number" ? payload.exp : undefined;
    const fixedInterval = currentExchangeIntervalMs > 0 ? currentExchangeIntervalMs : Infinity;
    const expDelay = exp !== undefined ? exp * 1000 - Date.now() - REFRESH_LEAD_MS : Infinity;

    let delayMs: number;
    if (fixedInterval === Infinity && expDelay === Infinity) {
        // 既无固定间隔、也无 exp，使用 fallback
        delayMs = REFRESH_FAILURE_FALLBACK_MS;
        logWarn("idaas_access_token", "schedule_no_hint", { fallbackMs: delayMs });
    } else {
        delayMs = Math.max(MIN_REFRESH_DELAY_MS, Math.min(fixedInterval, expDelay));
    }

    refreshTimer = setTimeout(() => {
        void refreshLoop();
    }, delayMs);
    refreshTimer.unref?.();

    logDebug("idaas_access_token", "scheduled", {
        delayMs,
        fixedIntervalMs: currentExchangeIntervalMs,
        expDelayMs: expDelay === Infinity ? "none" : expDelay,
        exp,
    });
}

/**
 * 单次调度入口：带互斥锁；失败时回退到 30s 后重试。
 */
async function refreshLoop(): Promise<void> {
    if (!enabled) return;
    if (!idaasDir) {
        logWarn("idaas_access_token", "refresh_without_dir", {});
        return;
    }
    if (refreshInFlight) {
        logDebug("idaas_access_token", "refresh_in_flight_skip", {});
        return;
    }

    const dir = idaasDir;
    const task = fetchAccessTokenWithRetry(dir);
    refreshInFlight = task;
    try {
        const result = await task;
        if (!enabled) return;

        if (result.success && result.payload?.sub && result.rawToken) {
            const tokenChanged = cachedRawToken !== result.rawToken;
            cachedRawToken = result.rawToken;
            cachedPayload = result.payload;
            logInfo("idaas_access_token", "refreshed", {
                sub: result.payload.sub,
                exp: result.payload.exp,
                tokenChanged,
            });
            // token 发生变化时持久化（首次获取也算变化，因为 cachedRawToken 原为 null）
            if (tokenChanged) {
                void persistAccessToken(result.rawToken);
            }
            scheduleNextRefresh(result.payload);
            return;
        }

        logError("idaas_access_token", "refresh_failed", {
            error: result.error,
            fallbackMs: REFRESH_FAILURE_FALLBACK_MS,
        });
        // 全部重试失败 → 延迟 30s 再进行下一整轮尝试（不动 cache）
        refreshTimer = setTimeout(() => {
            void refreshLoop();
        }, REFRESH_FAILURE_FALLBACK_MS);
        refreshTimer.unref?.();
    } finally {
        refreshInFlight = null;
    }
}
