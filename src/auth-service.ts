/**
 * 认证服务模块
 *
 * 在启动时向 managementServerAddr 发起认证请求获取 access_token，
 * 并将 token 附加到 ProtectionServer 的所有请求中。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { SDK_VERSION } from "./config.js";
import { getAgentRuntime, getRuntimeContext, setAgentId } from "./runtime.js";
import { buildUrl } from "./utils.js";
import {
    logWarn,
    logError,
    logDebug,
} from "./logger.js";

/** 认证请求路径 */
const AUTH_TOKEN_PATH = "/v1/agent/auth/token";

/** 安装 Token 请求路径 */
const INSTALL_TOKEN_PATH = "/v1/agent/install/token";

/** 本地存储的 access_token 文件名 */
const ACCESS_TOKEN_FILENAME = ".access_token";

/** Token 检查间隔（默认 1 分钟） */
const DEFAULT_TOKEN_CHECK_INTERVAL_MS = 60 * 1000;

/** Token 服务端刷新间隔（默认 1 小时） */
const TOKEN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** Token 提前刷新阈值（距离过期 10 分钟时提前刷新） */
const TOKEN_EXPIRY_THRESHOLD_MS = 10 * 60 * 1000;

/** 认证请求超时时间 */
const DEFAULT_AUTH_TIMEOUT_MS = 30_000;

/** Install 重试间隔（默认 30 秒） */
const DEFAULT_INSTALL_RETRY_INTERVAL_MS = 30 * 1000;

/** auth/token 不可恢复错误码（token 本身已废弃，需 install_key 重新颁发） */
const AUTH_UNRECOVERABLE_CODES = new Set<number>([400, 401, 403, 404]);

/** install/token 不可恢复错误码（install_key 无效/解析失败，无法自愈） */
const INSTALL_UNRECOVERABLE_CODES = new Set<number>([400, 401]);

// ============================================================================
// Types
// ============================================================================

/** 认证请求 Body */
export type AuthTokenRequestBody = {
    /** 唯一机器 ID */
    machine_id: string;
    /** 原始 token（用于刷新） */
    raw_token: string;
};

/** 认证响应 */
export type AuthTokenResponse = {
    /** 响应码 */
    code: number;
    /** 响应数据 */
    data: {
        /** JWT 格式的 access token */
        access_token: string;
    };
    /** 响应消息 */
    msg: string;
    /** 是否成功 */
    success: boolean;
};

/** 安装 Token 请求 Body */
export type InstallTokenRequestBody = {
    /** install 命令中的 key 值 */
    install_key: string;
    /** openclaw 实例运行身份唯一标识 */
    machine_id: string;
};

/** 安装 Token 响应 */
export type InstallTokenResponse = {
    /** 响应码 */
    code: number;
    /** 响应数据 */
    data: {
        /** JWT 格式的 access token */
        access_token: string;
    };
    /** 响应消息 */
    msg: string;
    /** 是否成功 */
    success: boolean;
};

/** 认证服务配置 */
export type AuthServiceConfig = {
    /** Management Server 地址 */
    managementServerAddr: string;
    /** Token 检查间隔 */
    checkIntervalMs?: number;
    /** 请求超时时间 */
    timeoutMs?: number;
};

// ============================================================================
// JWT Token Payload Types
// ============================================================================

/** JWT Token payload 结构 */
export type JwtPayload = {
    /** Token 主体（智能体ID） */
    sub?: string;
    /** 受众（目标服务） */
    aud?: string;
    /** 签发者 */
    iss?: string;
    /** 过期时间戳（秒级） */
    exp?: number;
    /** 签发时间戳（秒级） */
    iat?: number;
    /** 租户ID */
    tenant_id?: string;
    /** 终端用户ID */
    end_user_id?: string;
    /** 权限列表 */
    permissions?: string[];
};

// ============================================================================
// Token Storage (Module-level singleton)
// ============================================================================

/** 当前存储的 access token */
let currentAccessToken: string | null = null;

/** 解析后的 JWT payload */
let currentJwtPayload: JwtPayload | null = null;

/** 认证服务是否就绪（有有效 token） */
let isReady = false;

/** 认证服务错误信息（仅在不可恢复的错误时设置，waiting 状态为 null） */
let authErrMsg: string | null = null;

/** Token 刷新回调函数（由 createAuthService 设置） */
let tokenRefreshCallback: (() => Promise<boolean>) | null = null;

/** 最近一次 install/token 调用的失败信息（成功时清空；仅用于状态透出观察点） */
let lastInstallTokenError: { code: number; msg: string } | null = null;

/**
 * 获取当前的 access token
 */
export function getAccessToken(): string | null {
    return currentAccessToken;
}

/**
 * 获取当前的 JWT payload
 */
export function getJwtPayload(): JwtPayload | null {
    return currentJwtPayload;
}

/**
 * 检查认证服务是否就绪
 */
export function isAuthServiceReady(): boolean {
    return isReady;
}

/**
 * 获取认证服务错误信息
 * 仅在不可恢复的错误时返回非 null（如缺少 token 和 install_key）
 */
export function getAuthErrMsg(): string | null {
    return authErrMsg;
}

/**
 * 触发 token 刷新（供外部调用）
 * 当检测到 token 超时（如 402 错误码）时调用此函数
 *
 * @returns Promise<boolean> 刷新是否成功
 */
export async function triggerTokenRefresh(): Promise<boolean> {
    if (!tokenRefreshCallback) {
        logWarn("auth", "trigger_refresh_failed", { reason: "no refresh callback set" });
        return false;
    }

    logDebug("auth", "trigger_refresh", {});
    return tokenRefreshCallback();
}

/**
 * 设置 access token 并解析 JWT payload
 *
 * @param token JWT token 字符串
 * @param logger 可选的日志记录器
 * @param pluginDir 可选的插件目录，如果提供则将 token 写入本地 access_token 文件
 */
export function setAccessToken(token: string, logger?: PluginLogger, pluginDir?: string): void {
    currentAccessToken = token;
    currentJwtPayload = parseJwtPayload(token);

    // 写入本地 access_token 文件
    if (pluginDir) {
        try {
            const accessTokenFile = path.join(pluginDir, ACCESS_TOKEN_FILENAME);
            fs.writeFileSync(accessTokenFile, token, "utf-8");
            logDebug("auth", "token_saved", { file: accessTokenFile });
        } catch (e: any) {
            logError("auth", "token_save_failed", { error: e?.message || e });
        }
    }

    // 记录解析后的 payload 关键信息
    if (currentJwtPayload) {
        const expDate = currentJwtPayload.exp
            ? new Date(currentJwtPayload.exp * 1000).toISOString()
            : "unknown";
        const iatDate = currentJwtPayload.iat
            ? new Date(currentJwtPayload.iat * 1000).toISOString()
            : "unknown";

        logDebug("auth", "token_parsed", {
            sub: currentJwtPayload.sub,
            aud: currentJwtPayload.aud,
            iss: currentJwtPayload.iss,
            iat: iatDate,
            exp: expDate,
        });
    } else {
        logWarn("auth", "token_parse_failed", {
            tokenLength: token.length,
        });
    }
}

/**
 * 清除 access token
 */
export function clearAccessToken(): void {
    currentAccessToken = null;
    currentJwtPayload = null;
}

/**
 * 检查 token 是否即将过期（距离过期时间小于阈值）
 *
 * @param thresholdMs 提前刷新阈值（毫秒），默认 10 分钟
 * @returns true 表示即将过期，需要刷新
 */
export function isTokenExpiringSoon(thresholdMs: number = TOKEN_EXPIRY_THRESHOLD_MS): boolean {
    if (!currentJwtPayload?.exp) {
        // 没有 exp 字段，无法判断，保守起见返回 true 触发刷新
        return true;
    }

    const now = Math.floor(Date.now() / 1000); // 当前时间（秒级）
    const remainingSeconds = currentJwtPayload.exp - now;

    return remainingSeconds * 1000 < thresholdMs;
}

/**
 * 解析 JWT token 的 payload 部分
 *
 * @param token JWT token 字符串
 * @returns 解析后的 payload，解析失败返回 null
 */
export function parseJwtPayload(token: string): JwtPayload | null {
    try {
        // JWT 格式: header.payload.signature
        const parts = token.split(".");
        if (parts.length !== 3) {
            return null;
        }

        // Base64Url 解码 payload
        const payload = parts[1];
        // 将 Base64Url 转换为标准 Base64
        const base64 = payload
            .replace(/-/g, "+")
            .replace(/_/g, "/");
        // 补齐 padding
        const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

        // 解码并解析 JSON
        const decoded = Buffer.from(padded, "base64").toString("utf-8");
        return JSON.parse(decoded) as JwtPayload;
    } catch {
        return null;
    }
}

/**
 * 从本地文件加载 access token
 * 只负责读取和解析，不判断过期，不设置 agentId
 * agentId 在服务端验证成功后统一设置
 *
 * @returns 是否成功加载合法的 token
 */
function loadAccessTokenFromFile(
    pluginDir: string,
    logger?: PluginLogger,
): boolean {
    const accessTokenFile = path.join(pluginDir, ACCESS_TOKEN_FILENAME);

    try {
        if (!fs.existsSync(accessTokenFile)) {
            logDebug("auth", "load_token_not_found", {});
            return false;
        }

        const token = fs.readFileSync(accessTokenFile, "utf-8").trim();
        if (!token) {
            logWarn("auth", "load_token_empty", {});
            return false;
        }

        // 设置 token
        currentAccessToken = token;
        currentJwtPayload = parseJwtPayload(token);

        // 检查是否能解析
        if (!currentJwtPayload) {
            logWarn("auth", "load_token_parse_failed", {});
            currentAccessToken = null;
            currentJwtPayload = null;
            return false;
        }

        logDebug("auth", "load_token_success", {
            tokenLength: token.length,
            sub: currentJwtPayload.sub,
            exp: currentJwtPayload.exp
                ? new Date(currentJwtPayload.exp * 1000).toISOString()
                : undefined,
        });
        return true;
    } catch (e: any) {
        logError("auth", "load_token_error", { error: e?.message || e });
        return false;
    }
}

/** Token 验证结果 */
type TokenVerifyResult = {
    /** 是否成功 */
    success: boolean;
    /** 响应码：200=新签发，201=复用已有token */
    code: number;
    /** access token */
    accessToken: string | null;
    /** 响应消息 */
    msg: string;
};

// ============================================================================
// Auth Service Implementation
// ============================================================================

/**
 * 向 Management Server 请求 access token（用于刷新/验证）
 * 
 * 服务端返回码：
 * - 200: token 重新签发
 * - 201: token 未过期，复用已有
 * - 401: token 签名无效
 * - 403: machine_id 不匹配
 * - 404: Agent 不存在
 */
async function fetchAccessToken(
    managementServerAddr: string,
    machineId: string,
    rawToken: string,
    originalFetch: typeof globalThis.fetch,
    timeoutMs: number,
    logger?: PluginLogger,
): Promise<TokenVerifyResult> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const url = buildUrl(managementServerAddr, AUTH_TOKEN_PATH);
    const requestId = randomUUID();

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
        "X-SDK-Version": SDK_VERSION,
        "X-Agent-Runtime": getAgentRuntime(),
    };

    const body: AuthTokenRequestBody = {
        machine_id: machineId,
        raw_token: rawToken,
    };

    try {
        // 调试日志：认证请求
        logDebug("auth", "request", {
            url,
            requestId,
            machineId,
        });

        const resp = await originalFetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!resp.ok) {
            logWarn("auth", "request_failed", {
                url,
                status: resp.status,
                statusText: resp.statusText,
            });
            return { success: false, code: resp.status, accessToken: null, msg: resp.statusText };
        }

        const data = (await resp.json()) as AuthTokenResponse;

        if (!data.success || !data.data?.access_token) {
            logWarn("auth", "invalid_response", {
                url,
                code: data.code,
                msg: data.msg,
            });
            return { success: false, code: data.code, accessToken: null, msg: data.msg };
        }

        const isReused = data.code === 201;
        logDebug("auth", "token_success", {
            code: data.code,
            reused: isReused,
        });

        return {
            success: true,
            code: data.code,
            accessToken: data.data.access_token,
            msg: data.msg,
        };
    } catch (e: any) {
        logWarn("auth", "request_error", {
            url,
            error: String(e?.message || e),
        });
        return { success: false, code: 0, accessToken: null, msg: String(e?.message || e) };
    } finally {
        clearTimeout(t);
    }
}

/**
 * 向 Management Server 请求安装 token
 */
async function fetchInstallToken(
    managementServerAddr: string,
    installKey: string,
    machineId: string,
    originalFetch: typeof globalThis.fetch,
    timeoutMs: number,
    logger?: PluginLogger,
): Promise<string | null> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const url = buildUrl(managementServerAddr, INSTALL_TOKEN_PATH);
    const requestId = randomUUID();

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
        "X-SDK-Version": SDK_VERSION,
        "X-Agent-Runtime": getAgentRuntime(),
    };

    const body: InstallTokenRequestBody = {
        install_key: installKey,
        machine_id: machineId,
    };

    try {
        // 调试日志：安装认证请求
        logDebug("auth", "install_request", {
            url,
            requestId,
            machineId,
        });

        const resp = await originalFetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!resp.ok) {
            logWarn("auth", "install_failed", {
                url,
                status: resp.status,
                statusText: resp.statusText,
            });
            lastInstallTokenError = { code: resp.status, msg: resp.statusText };
            return null;
        }

        const data = (await resp.json()) as InstallTokenResponse;

        if (!data.success || !data.data?.access_token) {
            logWarn("auth", "install_invalid_response", {
                url,
                code: data.code,
                msg: data.msg,
            });
            lastInstallTokenError = { code: data.code, msg: data.msg };
            return null;
        }

        logDebug("auth", "install_success", {});

        lastInstallTokenError = null;
        return data.data.access_token;
    } catch (e: any) {
        logWarn("auth", "install_error", {
            url,
            error: String(e?.message || e),
        });
        lastInstallTokenError = { code: 0, msg: String(e?.message || e) };
        return null;
    } finally {
        clearTimeout(t);
    }
}

/**
 * 创建认证服务
 */
export function createAuthService(params: {
    api: OpenClawPluginApi;
    originalFetch: typeof globalThis.fetch;
    pluginDir: string;
    config: AuthServiceConfig;
}): OpenClawPluginService {
    const { api, originalFetch, pluginDir } = params;
    const {
        managementServerAddr,
        checkIntervalMs = DEFAULT_TOKEN_CHECK_INTERVAL_MS,
        timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    } = params.config;

    // Token 检查定时器
    let checkTimer: NodeJS.Timeout | null = null;
    let installRetryTimer: NodeJS.Timeout | null = null;
    let isRefreshing = false;
    // 上次刷新时间（毫秒时间戳）
    let lastRefreshTime = 0;

    // 设置 token 刷新回调
    tokenRefreshCallback = async () => {
        return refreshToken(api.logger);
    };

    /**
     * 刷新 token（向服务端验证当前 token 有效性）
     */
    async function refreshToken(logger: PluginLogger): Promise<boolean> {
        if (isRefreshing) {
            logDebug("auth", "refresh_skipped", { reason: "already refreshing" });
            return false;
        }

        isRefreshing = true;
        try {
            const ctx = getRuntimeContext();
            const currentToken = getAccessToken();

            if (!currentToken) {
                logWarn("auth", "refresh_skip", { reason: "no token available" });
                return false;
            }

            const result = await fetchAccessToken(
                managementServerAddr,
                ctx.machineId,
                currentToken,
                originalFetch,
                timeoutMs,
                logger,
            );

            if (result.success && result.accessToken) {
                // code=200: 新签发的 token，需要更新本地文件和内存
                // code=201: 复用已有 token，服务端返回的就是客户端传上去的同一个 token，不需要更新
                if (result.code === 200) {
                    setAccessToken(result.accessToken, logger, pluginDir);
                }
                // code=201: 无需任何操作，token 未变化
                // 更新上次刷新时间
                lastRefreshTime = Date.now();
                // 状态透出：刷新成功即解除之前可能存在的 error
                authErrMsg = null;
                return true;
            }
            // 状态透出：仅在服务端明确返回不可恢复码时写入 authErrMsg
            // 严格保持业务状态不变：不改 isReady、不清 token、不触碰定时器
            if (AUTH_UNRECOVERABLE_CODES.has(result.code)) {
                authErrMsg = `Token invalidated: ${result.msg || `code=${result.code}`}`;
            }
            return false;
        } finally {
            isRefreshing = false;
        }
    }

    /**
     * 使用 install_key 获取 token
     */
    async function fetchTokenWithInstallKey(logger: PluginLogger): Promise<boolean> {
        const ctx = getRuntimeContext();
        const installKey = ctx.installKey;
        const machineId = ctx.machineId;

        if (!installKey) {
            logError("auth", "install_missing", { message: "no install_key available" });
            return false;
        }

        logDebug("auth", "install_requesting", {});

        const token = await fetchInstallToken(
            managementServerAddr,
            installKey,
            machineId,
            originalFetch,
            timeoutMs,
            logger,
        );

        if (token) {
            setAccessToken(token, logger, pluginDir);

            // 从 JWT sub 字段设置 agentId（只执行一次）
            const payload = getJwtPayload();
            if (payload?.sub) {
                setAgentId(payload.sub);
                logDebug("auth", "agent_id_set", { agentId: payload.sub });
            }

            logDebug("auth", "install_token_obtained", {});
            return true;
        }

        logWarn("auth", "install_token_failed", {});
        return false;
    }

    /**
     * 检查 token 是否需要刷新
     * 条件（或逻辑）：
     * 1. 即将过期（距离过期时间 < 10 分钟）
     * 2. 距离上次刷新 >= 1 小时
     */
    async function checkAndRefreshToken(logger: PluginLogger): Promise<void> {
        // 未就绪时不执行
        if (!isReady) {
            logDebug("auth", "check_skip", { reason: "service not ready" });
            return;
        }

        const now = Date.now();
        const timeSinceLastRefresh = now - lastRefreshTime;
        const shouldRefreshByInterval = timeSinceLastRefresh >= TOKEN_REFRESH_INTERVAL_MS;
        const shouldRefreshByExpiry = isTokenExpiringSoon();

        if (shouldRefreshByExpiry || shouldRefreshByInterval) {
            logDebug("auth", "check_start", {
                reason: shouldRefreshByExpiry ? "expiring_soon" : "interval_elapsed",
                timeSinceLastRefresh: Math.floor(timeSinceLastRefresh / 1000),
                expiringSoon: shouldRefreshByExpiry,
            });
            await refreshToken(logger).catch(() => {});
        }
    }

    /**
     * 启动 token 检查定时器
     */
    function startCheckTimer(logger: PluginLogger): void {
        if (checkTimer) {
            clearInterval(checkTimer);
        }
        checkTimer = setInterval(() => checkAndRefreshToken(logger).catch(() => {}), checkIntervalMs);
        checkTimer.unref?.();
        logDebug("auth", "check_timer_started", { interval: checkIntervalMs });
    }

    /**
     * 停止 install 重试定时器
     */
    function stopInstallRetryTimer(): void {
        if (installRetryTimer) {
            clearInterval(installRetryTimer);
            installRetryTimer = null;
        }
    }

    /**
     * 启动 install 重试流程
     */
    function startInstallRetry(logger: PluginLogger): void {
        const retryIntervalMs = DEFAULT_INSTALL_RETRY_INTERVAL_MS;

        logDebug("auth", "install_retry_start", { interval: retryIntervalMs });

        installRetryTimer = setInterval(async () => {
            logDebug("auth", "install_retry", {});

            const success = await fetchTokenWithInstallKey(logger).catch((e) => {
                logError("auth", "install_retry_error", { error: String(e) });
                return false;
            });

            if (success) {
                stopInstallRetryTimer();
                isReady = true;
                authErrMsg = null;
                lastRefreshTime = Date.now();
                startCheckTimer(logger);
                logDebug("auth", "install_retry_success", {});
            } else {
                // 状态透出：仅在服务端明确返回不可恢复码时写入 authErrMsg；瞬时错误保持原状
                // 不改控制流：重试定时器继续按原节奏轮询
                const lastErr = lastInstallTokenError;
                if (lastErr && INSTALL_UNRECOVERABLE_CODES.has(lastErr.code)) {
                    authErrMsg = `install_key rejected: ${lastErr.msg || `code=${lastErr.code}`}`;
                }
            }
        }, retryIntervalMs);
        installRetryTimer.unref?.();
    }

    return {
        id: "openclaw-security-assistant-auth",
        start: async (ctx: OpenClawPluginServiceContext) => {
            const logger = ctx.logger;
            const runtimeCtx = getRuntimeContext();

            // 步骤 1：尝试从本地文件加载 token
            const loaded = loadAccessTokenFromFile(pluginDir, logger);

            if (loaded) {
                // 文件中有 token，立即向服务端验证有效性
                logDebug("auth", "verify_start", {});

                const currentToken = getAccessToken();
                const result = await fetchAccessToken(
                    managementServerAddr,
                    runtimeCtx.machineId,
                    currentToken!,
                    originalFetch,
                    timeoutMs,
                    logger,
                ).catch((e) => {
                    logError("auth", "verify_error", { error: String(e) });
                    return null;
                });

                if (result?.success && result.accessToken) {
                    // 服务端验证成功
                    if (result.code === 200) {
                        // token 重新签发，更新本地文件和内存
                        setAccessToken(result.accessToken, logger, pluginDir);
                    }
                    // code=201: 复用已有 token，服务端返回的就是客户端传上去的同一个 token，不需要更新

                    // 从 JWT sub 字段设置 agentId（首次设置）
                    const payload = getJwtPayload();
                    if (payload?.sub) {
                        setAgentId(payload.sub);
                        logDebug("auth", "agent_id_set", { agentId: payload.sub });
                    }

                    isReady = true;
                    authErrMsg = null;
                    lastRefreshTime = Date.now();
                    startCheckTimer(logger);
                    logDebug("auth", "started", { source: "token verified", code: result.code });
                    return;
                }

                // 服务端验证失败，清除本地 token
                logWarn("auth", "verify_failed", { code: result?.code, msg: result?.msg });
                clearAccessToken();
            }

            // 步骤 2：没有有效 token，检查是否有 install_key
            if (!runtimeCtx.installKey) {
                // 没有 install_key，启动失败
                authErrMsg = "Missing install_key and access_token";
                logError("auth", "start_failed", { message: "no valid token and no install_key" });
                return;
            }

            // 步骤 3：尝试使用 install_key 获取 token
            logDebug("auth", "install_init", {});

            const success = await fetchTokenWithInstallKey(logger).catch((e) => {
                logError("auth", "install_init_error", { error: String(e) });
                return false;
            });

            if (success) {
                // 成功获取 token，就绪
                isReady = true;
                authErrMsg = null;
                lastRefreshTime = Date.now();
                startCheckTimer(logger);
                logDebug("auth", "started", { source: "install_key" });
                return;
            }

            // 状态透出：仅在服务端明确返回不可恢复码时写入 authErrMsg；瞬时错误保持 null
            // 不改控制流：重试定时器照常启动
            const lastErr = lastInstallTokenError;
            if (lastErr && INSTALL_UNRECOVERABLE_CODES.has(lastErr.code)) {
                authErrMsg = `install_key rejected: ${lastErr.msg || `code=${lastErr.code}`}`;
            }

            // 步骤 4：获取失败，启动重试流程
            logDebug("auth", "started_waiting", {});
            startInstallRetry(logger);
        },
        stop: async () => {
            stopInstallRetryTimer();
            if (checkTimer) {
                clearInterval(checkTimer);
                checkTimer = null;
            }
            isRefreshing = false;
            isReady = false;
            authErrMsg = null;
            lastRefreshTime = 0;
            tokenRefreshCallback = null;
            clearAccessToken();
        },
    };
}
