/**
 * 安全检查模块
 *
 * 统一 Report 发送 + 各阶段高级函数 + Skill 检测。
 * 旧协议已删除，所有检测路径均走新版 Report 协议。
 */

import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { isAuthServiceReady, triggerTokenRefresh } from "./auth-service.js";
import { buildUrl, buildApsHeaders } from "./utils.js";
import { logWarn, logDebug } from "./logger.js";
import type {
    SecurityAction,
    ReplacementPayload,
    Report,
    ReportMeta,
    ReportCheckResponse,
    ReportPayload,
    ReportPhase,
    RunStartPayload,
    RunEndPayload,
    BeforeLlmCallPayload,
    AfterLlmCallPayload,
    BeforeToolCallPayload,
    AfterToolCallPayload,
} from "./report-types.js";

// ============================================================================
// Provider 类型（内联，原 types.ts 迁出）
// ============================================================================

/** Provider 匹配结果 */
export type ProviderMatch = {
    providerId: string;
    baseUrl: string;
};

/** Provider 配置缓存 */
type ProviderCache = {
    configRef: OpenClawConfig | undefined;
    providers: ProviderMatch[];
};

// ============================================================================
// 路径常量
// ============================================================================

/** 异步 gzip 压缩/解压（libuv 线程池，不阻塞事件循环） */
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** LLM 检查路径 */
const LLM_CHECK_PATH = "/v1/agent/llm_check";

/** Tool 检查路径 */
const TOOL_CHECK_PATH = "/v1/agent/tool_check";

/** run_start 路径 */
const RUN_START_PATH = "/v1/agent/run_start";
/** run_end 路径 */
const RUN_END_PATH = "/v1/agent/run_end";

/** 根据阶段解析 APS 请求路径 */
function resolveReportPath(phase: ReportPhase): string {
    switch (phase) {
        case "before_llm_call":
        case "after_llm_call":
            return LLM_CHECK_PATH;
        case "before_tool_call":
        case "after_tool_call":
            return TOOL_CHECK_PATH;
        case "run_start":
            return RUN_START_PATH;
        case "run_end":
            return RUN_END_PATH;
    }
}

/** Provider 配置缓存 */
let providerCache: ProviderCache = { configRef: undefined, providers: [] };

/** 根据阶段解析数据流向（仅 check 阶段需要） */
function resolveDirection(phase: ReportPhase): "req" | "resp" | undefined {
    switch (phase) {
        case "before_llm_call":
        case "before_tool_call":
            return "req";
        case "after_llm_call":
        case "after_tool_call":
            return "resp";
        case "run_start":
        case "run_end":
            return undefined;
    }
}

/**
 * 从配置中提取所有 provider 的 baseUrl 列表（带缓存）
 *
 * 缓存策略：通过配置对象引用判断是否需要重新解析。
 * loadConfig() 在配置未变时返回同一对象引用；
 * 配置变更（CLI/API/外部编辑）后 runtimeConfigSnapshot 被替换为新对象，
 * 引用不等即触发重新解析。
 */
export function getProviderBaseUrls(config: OpenClawConfig): ProviderMatch[] {
    // 缓存命中：配置对象引用未变，直接返回缓存
    if (config === providerCache.configRef) {
        return providerCache.providers;
    }

    // 缓存未命中：重新解析并更新缓存
    const providers = config.models?.providers ?? {};
    providerCache = {
        configRef: config,
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



// ============================================================================
// 新协议：统一 Report 发送 + 6 阶段高级函数
// ============================================================================

/** 检查阶段超时时间（ms）—— 阻塞主流程，保持较短 */
const CHECK_TIMEOUT_MS = 2_000;

/** 单向上报超时时间（ms）—— fire-and-forget，不阻塞主流程但仍需合理上限 */
const TRACE_TIMEOUT_MS = 2_000;

/**
 * 构建 Report 请求并发送到 APS（内部共享逻辑）。
 * 返回原始 Response 供调用方决定是否解析 body。
 *
 * @param timeoutMs  可选超时，默认 CHECK_TIMEOUT_MS（2s）
 */
async function buildAndSendReport(
    phase: ReportPhase,
    meta: ReportMeta,
    payload: ReportPayload,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch,
    timeoutMs: number = CHECK_TIMEOUT_MS,
    useGzip = true,
): Promise<{ resp: Response; requestId: string } | null> {
    // 认证服务未就绪时，直接跳过
    if (!isAuthServiceReady()) {
        logWarn("report", "skip", { phase, reason: "auth service not ready, fail-open pass" });
        return null;
    }

    const requestId = randomUUID();
    const headers = buildApsHeaders({ requestId, contentType: "application/json" });
    const basePath = resolveReportPath(phase);
    const direction = resolveDirection(phase);
    const urlStr = direction
        ? `${buildUrl(protectServerAddr, basePath)}?direction=${direction}`
        : buildUrl(protectServerAddr, basePath);

    const report: Report = {
        phase,
        meta,
        payload,
        timestamp: Date.now(),
    };

    const jsonBody = JSON.stringify(report);
    let body: BodyInit;
    let gzipLen: number | undefined;
    if (useGzip) {
        headers["Content-Encoding"] = "gzip";
        headers["Accept-Encoding"] = "gzip";
        const compressed = await gzipAsync(Buffer.from(jsonBody));
        body = new Blob([compressed]);
        gzipLen = compressed.length;
    } else {
        body = jsonBody;
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
        logDebug("report", "request", {
            requestId,
            phase,
            url: urlStr,
            direction,
            bodyLen: jsonBody.length,
            gzipLen,
            runId: meta.run_id,
            traceId: meta.trace_id,
            payloadPreview: JSON.stringify(payload).slice(0, 300),
        });

        const resp = await originalFetch(urlStr, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
        });

        return { resp, requestId };
    } catch (e) {
        logWarn("report", "error", { requestId, phase, error: String(e) });
        return null;
    } finally {
        clearTimeout(t);
    }
}

// ---- 单向上报（fire-and-forget） ----

/**
 * 发送 trace 上报（fire-and-forget），不关心 APS 响应内容。
 * 用于 run_start / run_end 阶段。
 */
export async function sendTraceReport(
    phase: ReportPhase,
    meta: ReportMeta,
    payload: ReportPayload,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch,
    useGzip = true,
): Promise<void> {
    const result = await buildAndSendReport(phase, meta, payload, protectServerAddr, originalFetch, TRACE_TIMEOUT_MS, useGzip);
    if (result) {
        // 必须消费 response body 以释放底层 socket，否则 undici 会持有连接直到 bodyTimeout
        result.resp.text().catch(() => {});
        logDebug("report", "fire_forget_sent", { requestId: result.requestId, phase, status: result.resp.status, runId: meta.run_id });
    }
}

/** 发送 run_start 上报 */
export async function reportRunStart(
    meta: ReportMeta,
    payload: RunStartPayload,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch,
): Promise<void> {
    // run_start payload 体量小，fire-and-forget 无需压缩以降低延迟/CPU 开销
    await sendTraceReport("run_start", meta, payload, protectServerAddr, originalFetch, false);
}

/** 发送 run_end 上报 */
export async function reportRunEnd(
    meta: ReportMeta,
    payload: RunEndPayload,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch,
): Promise<void> {
    // run_end payload 体量小，fire-and-forget 无需压缩以降低延迟/CPU 开销
    await sendTraceReport("run_end", meta, payload, protectServerAddr, originalFetch, false);
}

// ---- 请求-响应（返回 action） ----

/**
 * 发送 trace 检查请求，等待 APS 返回处置动作。
 * 用于 before/after_llm_call、before/after_tool_call 阶段。
 * 降级策略：认证未就绪/网络异常/超时/服务端错误均返回 allow。
 */
export async function sendTraceCheck(
    phase: ReportPhase,
    meta: ReportMeta,
    payload: ReportPayload,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch,
    useGzip = true,
): Promise<{ action: SecurityAction; content?: string; payload?: ReplacementPayload }> {
    const checkStart = Date.now();
    const result = await buildAndSendReport(phase, meta, payload, protectServerAddr, originalFetch, CHECK_TIMEOUT_MS, useGzip);
    if (!result) {
        return { action: "allow" };
    }

    try {
        // 响应解压：Node.js fetch 可能已自动解压 body 但未移除 content-encoding header，
        // 因此不能仅凭 header 判断，需通过 gzip magic bytes (1f 8b) 探测实际编码
        const buf = Buffer.from(await result.resp.arrayBuffer());
        const isGzipped = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
        const text = isGzipped
            ? (await gunzipAsync(buf)).toString("utf-8")
            : buf.toString("utf-8");
        const json = JSON.parse(text) as ReportCheckResponse;
        const durationMs = Date.now() - checkStart;
        logDebug("report", "response", {
            requestId: result.requestId,
            phase,
            action: json.action,
            content: json.content,
            hasPayload: Boolean(json.payload),
            error: json.error,
            durationMs,
        });

        // 检测 token 超时错误码（402）
        if (json.error?.code === "402") {
            logWarn("report", "token_expired", { requestId: result.requestId, code: json.error.code, message: json.error.message });
            triggerTokenRefresh().catch((e) => {
                logWarn("report", "token_refresh_failed", { error: String(e) });
            });
        }

        if (json.error) {
            return { action: "allow" };
        }
        return {
            action: json.action ?? "allow",
            content: json.content,
            payload: json.payload,
        };
    } catch (e) {
        logWarn("report", "response_parse_error", { requestId: result.requestId, phase, error: String(e) });
        return { action: "allow" };
    }
}

/** 发送 before_llm_call 检查，返回 APS 处置动作 */
export async function checkBeforeLlmCall(
    meta: ReportMeta,
    payload: BeforeLlmCallPayload,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch,
): Promise<{ action: SecurityAction; content?: string; payload?: ReplacementPayload }> {
    return sendTraceCheck("before_llm_call", meta, payload, protectServerAddr, originalFetch);
}

/** 发送 after_llm_call 检查，返回 APS 处置动作 */
export async function checkAfterLlmCall(
    meta: ReportMeta,
    payload: AfterLlmCallPayload,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch,
): Promise<{ action: SecurityAction; content?: string; payload?: ReplacementPayload }> {
    return sendTraceCheck("after_llm_call", meta, payload, protectServerAddr, originalFetch);
}

/** 发送 before_tool_call 检查，返回 APS 处置动作 */
export async function checkBeforeToolCall(
    meta: ReportMeta,
    payload: BeforeToolCallPayload,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch,
): Promise<{ action: SecurityAction; content?: string; payload?: ReplacementPayload }> {
    return sendTraceCheck("before_tool_call", meta, payload, protectServerAddr, originalFetch);
}

/** 发送 after_tool_call 检查，返回 APS 处置动作 */
export async function checkAfterToolCall(
    meta: ReportMeta,
    payload: AfterToolCallPayload,
    protectServerAddr: string,
    originalFetch: typeof globalThis.fetch,
): Promise<{ action: SecurityAction; content?: string; payload?: ReplacementPayload }> {
    return sendTraceCheck("after_tool_call", meta, payload, protectServerAddr, originalFetch);
}
