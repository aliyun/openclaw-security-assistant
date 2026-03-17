/**
 * 安全检查模块
 */

import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { SDK_VERSION } from "./config.js";
import { getAgentRuntime } from "./runtime.js";
import { getAccessToken, isAuthServiceReady, triggerTokenRefresh } from "./auth-service.js";
import { buildUrl } from "./utils.js";
import { logWarn, logDebug } from "./logger.js";
import type {
    CheckRequestContext,
    CheckResponseContext,
    CheckToolCallRequestContext,
    CheckToolCallResponseContext,
    Direction,
    LlmPayload,
    ProviderCache,
    ProviderMatch,
    SecurityAction,
    SecurityCheckRequest,
    SecurityCheckResponse,
    ToolCallPayload,
} from "./types.js";

/** LLM 检查路径 */
const LLM_CHECK_PATH = "/v1/agent/llm_check";

/** Tool 检查路径 */
const TOOL_CHECK_PATH = "/v1/agent/tool_check";

/** Provider 配置缓存 */
let providerCache: ProviderCache = { lastTouchedAt: undefined, providers: [] };

/**
 * 从配置中提取所有 provider 的 baseUrl 列表（带缓存）
 */
export function getProviderBaseUrls(config: OpenClawConfig): ProviderMatch[] {
    const lastTouchedAt = config.meta?.lastTouchedAt;

    // 缓存命中：meta 时间戳未变化，直接返回缓存
    if (lastTouchedAt && lastTouchedAt === providerCache.lastTouchedAt) {
        return providerCache.providers;
    }

    // 缓存未命中：重新解析并更新缓存
    const providers = config.models?.providers ?? {};
    providerCache = {
        lastTouchedAt,
        providers: Object.entries(providers)
            .filter(([, cfg]) => cfg.baseUrl)
            .map(([providerId, cfg]) => ({
                providerId,
                baseUrl: cfg.baseUrl!,
            })),
    };

    return providerCache.providers;
}

/**
 * 检查 URL 是否匹配某个 provider 的 baseUrl（严格前缀匹配）
 */
export function matchProviderByUrl(url: string, providers: ProviderMatch[]): ProviderMatch | null {
    for (const provider of providers) {
        if (url.startsWith(provider.baseUrl)) {
            return provider;
        }
    }
    return null;
}

/**
 * 过滤敏感 headers（如 Authorization）
 */
export function filterSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
    const sensitiveKeys = new Set([
        "authorization",
        "x-api-key",
        "api-key",
        "apikey",
        "x-auth-token",
        "auth-token",
        "cookie",
        "set-cookie",
    ]);

    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (!sensitiveKeys.has(key.toLowerCase())) {
            filtered[key] = value;
        }
    }
    return filtered;
}

/**
 * 构建安全检查请求 headers
 */
export function buildSecurityCheckHeaders(requestId: string): Record<string, string> {
    // 从 auth-service 获取运行时的 access token
    const authToken = getAccessToken();

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
        "X-SDK-Version": SDK_VERSION,
        "X-Agent-Runtime": getAgentRuntime(),
    };

    // 添加身份认证 header
    if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
    }

    return headers;
}

/** 默认安全检查超时时间（毫秒） */
const DEFAULT_SECURITY_CHECK_TIMEOUT_MS = 2_000;

/**
 * 调用远程安全检查服务
 */
export async function callRemoteSecurityCheck(
    payload: SecurityCheckRequest,
    protectServerAddr: string,
    path: string,
    direction: Direction,
    originalFetch: typeof globalThis.fetch | null,
    timeoutMs?: number,
    logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<SecurityCheckResponse> {
    // 认证服务未就绪时，直接放行
    if (!isAuthServiceReady()) {
        logWarn("check", "skip", { reason: "auth service not ready, fail-open pass" });
        return { request_id: "", action: "pass" };
    }

    const f = originalFetch ?? globalThis.fetch;
    if (!f) {
        return { request_id: "", action: "pass" };
    }

    const requestId = randomUUID();
    const headers = buildSecurityCheckHeaders(requestId);
    // 将 direction 添加到 URL query 参数中
    const url = buildUrl(protectServerAddr, `${path}?direction=${direction}`);
    const timeout = timeoutMs ?? DEFAULT_SECURITY_CHECK_TIMEOUT_MS;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);

    try {
        logDebug("check", "request", { url, requestId, direction });

        const resp = await f(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        const json = (await resp.json()) as SecurityCheckResponse;
        logDebug("check", "response", { requestId, action: json.action });

        // 检测 token 超时错误码（402）
        if (json.error?.code === "402") {
            logWarn("check", "token_expired", { requestId, code: json.error.code, message: json.error.message });
            // 异步触发 token 刷新，不阻塞当前请求
            triggerTokenRefresh().catch((e) => {
                logWarn("check", "token_refresh_failed", { error: String(e) });
            });
        }

        return json;
    } catch (e) {
        // 远程服务不可用/超时/JSON 异常：降级放行
        logWarn("check", "error", { requestId, error: String(e) });
        return { request_id: requestId, action: "pass" };
    } finally {
        clearTimeout(t);
    }
}

/**
 * 检查 LLM 请求内容
 */
export async function checkLlmRequest(
    ctx: CheckRequestContext,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch | null,
    logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<{ action: SecurityAction; content?: string }> {
    const llmPayload: LlmPayload = {
        url: ctx.url,
        method: ctx.method,
        headers: filterSensitiveHeaders(ctx.headers),
        body: ctx.bodyText,
    };

    const payload: SecurityCheckRequest = {
        req_type: "llm",
        agent_session_id: "mocked_session_id",
        llm_run_id: "mocked_run_id",
        llm_payload: llmPayload,
    };

    const result = await callRemoteSecurityCheck(payload, protectServerAddr, LLM_CHECK_PATH, "req", originalFetch, undefined, logger);

    if (result.error) {
        // 错误时降级放行
        return { action: "pass" };
    }

    return { action: result.action ?? "pass", content: result.content };
}

/**
 * 检查 LLM 响应内容
 */
export async function checkLlmResponse(
    ctx: CheckResponseContext,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch | null,
    logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<{ action: SecurityAction; content?: string }> {
    const llmPayload: LlmPayload = {
        url: ctx.url,
        headers: filterSensitiveHeaders(ctx.headers),
        body: ctx.respText,
    };

    const payload: SecurityCheckRequest = {
        req_type: "llm",
        agent_session_id: "mocked_session_id",
        llm_run_id: "mocked_run_id",
        llm_payload: llmPayload,
    };

    const result = await callRemoteSecurityCheck(payload, protectServerAddr, LLM_CHECK_PATH, "resp", originalFetch, undefined, logger);

    if (result.error) {
        // 错误时降级放行
        return { action: "pass" };
    }

    return { action: result.action ?? "pass", content: result.content };
}

/**
 * 检查 Tool Call 请求内容
 */
export async function checkToolCallRequest(
    ctx: CheckToolCallRequestContext,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch | null,
    logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<{ action: SecurityAction; content?: string }> {
    const toolPayload: ToolCallPayload = {
        name: ctx.name,
        parameters: ctx.parameters,
    };

    const payload: SecurityCheckRequest = {
        req_type: "tool_call",
        agent_session_id: "mocked_session_id",
        llm_run_id: "mocked_run_id",
        tool_payload: toolPayload,
    };

    const result = await callRemoteSecurityCheck(payload, protectServerAddr, TOOL_CHECK_PATH, "req", originalFetch, undefined, logger);

    if (result.error) {
        return { action: "pass" };
    }

    return { action: result.action ?? "pass", content: result.content };
}

/**
 * 检查 Tool Call 响应内容
 */
export async function checkToolCallResponse(
    ctx: CheckToolCallResponseContext,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch | null,
    logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<{ action: SecurityAction; content?: string }> {
    const toolPayload: ToolCallPayload = {
        name: ctx.name,
        parameters: ctx.parameters,
        result: ctx.result,
        error: ctx.error,
    };

    const payload: SecurityCheckRequest = {
        req_type: "tool_call",
        agent_session_id: "mocked_session_id",
        llm_run_id: "mocked_run_id",
        tool_payload: toolPayload,
    };

    const result = await callRemoteSecurityCheck(payload, protectServerAddr, TOOL_CHECK_PATH, "resp", originalFetch, undefined, logger);

    if (result.error) {
        return { action: "pass" };
    }

    return { action: result.action ?? "pass", content: result.content };
}
