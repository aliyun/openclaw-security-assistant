/**
 * OpenAI 格式响应构建模块
 *
 * 当请求或响应被安全检查拦截时，构造符合 OpenAI API 格式的响应，
 * 确保 AgentRuntime 能正确解析。
 */

import type { ReplacementPayload, SecurityAction } from "./report-types.js";
import { isSseResponse } from "./fetch-utils.js";

/** -------- SSE 判断 -------- */

/**
 * 判断请求是否期望 SSE 流式响应
 */
export function guessRequestWantsSse(
    url: string,
    reqHeaders: Record<string, string>,
    reqBodyText: string,
): boolean {
    // 1) body JSON: stream:true
    try {
        if (reqBodyText) {
            const obj = JSON.parse(reqBodyText);
            if (obj && obj.stream === true) return true;
        }
    } catch {}

    // 2) accept header
    const accept = (reqHeaders["accept"] || reqHeaders["Accept"] || "").toLowerCase();
    if (accept.includes("text/event-stream")) return true;

    // 3) simple fallback for OpenAI chat completions
    if (url.includes("/chat/completions")) return true;

    return false;
}

/** -------- 响应体构建 -------- */

/**
 * 构建 SSE 格式的响应体
 */
export function buildOpenAiSseBodyFromText(replacementText: string, id: string): string {
    const now = Math.floor(Date.now() / 1000);
    const model = "security";

    const chunkObj = {
        id,
        object: "chat.completion.chunk",
        created: now,
        model,
        choices: [{ index: 0, delta: { content: replacementText }, finish_reason: null }],
    };

    const finishObj = {
        id,
        object: "chat.completion.chunk",
        created: now,
        model,
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
    };

    return (
        `data: ${JSON.stringify(chunkObj)}\n\n` +
        `data: ${JSON.stringify(finishObj)}\n\n` +
        `data: [DONE]\n\n`
    );
}

/**
 * 构建 JSON 格式的响应体
 */
export function buildOpenAiJsonBodyFromText(replacementText: string, id: string): string {
    const now = Math.floor(Date.now() / 1000);
    const model = "security";

    const jsonObj = {
        id,
        object: "chat.completion",
        created: now,
        model,
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: replacementText },
                finish_reason: "stop",
            },
        ],
    };

    return JSON.stringify(jsonObj);
}

/**
 * 从 SSE 响应体中提取文本内容
 */
export function extractTextFromSseBody(sseBody: string): string {
    const lines = sseBody.split("\n");
    const texts: string[] = [];

    for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
                const json = JSON.parse(line.slice(6));
                const content = json?.choices?.[0]?.delta?.content;
                if (content) texts.push(content);
            } catch {}
        }
    }

    return texts.join("");
}

/**
 * 从 JSON 响应体中提取文本内容
 */
export function extractTextFromJsonBody(jsonBody: string): string {
    try {
        const json = JSON.parse(jsonBody);
        return json?.choices?.[0]?.message?.content ?? "";
    } catch {
        return "";
    }
}

/**
 * 从响应体中提取文本内容（自动识别 SSE/JSON）
 */
export function extractTextFromResponseBody(body: string, isSse: boolean): string {
    return isSse ? extractTextFromSseBody(body) : extractTextFromJsonBody(body);
}

/**
 * 判断响应是否包含 tool_calls（中间响应）
 *
 * 对于包含 tool_calls 的响应，不应该追加 hint 内容，否则会破坏响应结构
 */
export function isToolCallResponse(body: string, isSse: boolean): boolean {
    // 简单检查 body 中是否包含 "tool_calls" 关键字
    // 这是最直接有效的方法，适用于 SSE 和 JSON 两种格式
    return body.includes("\"tool_calls\"");
}

/**
 * 构建 hint 模式的响应体（追加提示内容）
 */
export function buildHintResponseBody(
    originalBody: string,
    hintContent: string,
    isSse: boolean,
    id: string,
): string {
    const originalText = extractTextFromResponseBody(originalBody, isSse);
    const combinedText = originalText + hintContent;

    return isSse
        ? buildOpenAiSseBodyFromText(combinedText, id)
        : buildOpenAiJsonBodyFromText(combinedText, id);
}

/** -------- 拦截响应构建 -------- */

/**
 * 从 APS 预组装的 ReplacementPayload 直接构造 Response
 *
 * 插件侧不做任何协议拼装，完全信任 APS 返回的 headers 和 body。
 * HTTP 状态码固定为 200。
 */
export function buildResponseFromAps(payload: ReplacementPayload): Response {
    return new Response(payload.body, {
        status: 200,
        headers: new Headers(payload.headers),
    });
}

/**
 * 为被拦截的请求创建 OpenAI 格式响应
 *
 * 请求被拦截时还没有原始 Response，需要自己构建完整的响应头
 */
export function makeOpenAiBlockedResponseForRequest(
    wantsSse: boolean,
    replacementText: string,
): Response {
    const id = "chatcmpl-security-request-blocked";

    if (wantsSse) {
        const headers = new Headers({
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "connection": "keep-alive",
        });
        const body = buildOpenAiSseBodyFromText(replacementText, id);
        return new Response(body, { status: 200, headers });
    }

    const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
    const body = buildOpenAiJsonBodyFromText(replacementText, id);
    return new Response(body, { status: 200, headers });
}

/**
 * 为被拦截的上游响应创建替换响应
 *
 * 尽量保持原始响应的 status/headers，只替换 body
 */
export function makeOpenAiBlockedResponseForUpstreamResponse(
    original: Response,
    replacementText: string,
): Response {
    const id = "chatcmpl-security-response-blocked";
    const wantsSse = isSseResponse(original);

    const headers = new Headers(original.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");

    const body = wantsSse
        ? buildOpenAiSseBodyFromText(replacementText, id)
        : buildOpenAiJsonBodyFromText(replacementText, id);

    return new Response(body, {
        status: original.status,
        statusText: original.statusText,
        headers,
    });
}

/**
 * 为 hint 模式创建追加内容的响应
 *
 * 在原始响应内容后追加提示内容
 * 注意：对于包含 tool_calls 的中间响应，不追加内容，直接返回 null
 */
export function makeOpenAiHintResponseForUpstreamResponse(
    original: Response,
    originalBody: string,
    hintContent: string,
): Response | null {
    const wantsSse = isSseResponse(original);

    // 检查是否是 tool_call 响应（中间响应）
    // 对于中间响应，不追加 hint 内容，避免破坏响应结构
    if (isToolCallResponse(originalBody, wantsSse)) {
        return null;
    }

    const id = "chatcmpl-security-response-hint";

    const headers = new Headers(original.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");

    const body = buildHintResponseBody(originalBody, hintContent, wantsSse, id);

    return new Response(body, {
        status: original.status,
        statusText: original.statusText,
        headers,
    });
}

/**
 * 根据安全检查结果创建响应
 */
export function createSecurityResponse(
    action: SecurityAction,
    content: string | undefined,
    context: {
        isRequest: boolean;
        wantsSse: boolean;
        originalResponse?: Response;
        originalBody?: string;
    },
): Response | null {
    // allow: 不需要修改响应
    if (action === "allow") {
        return null;
    }

    // block: 替换响应内容
    if (action === "block") {
        const blockContent = content ?? "安全检查已拦截此内容";

        if (context.isRequest || !context.originalResponse) {
            return makeOpenAiBlockedResponseForRequest(context.wantsSse, blockContent);
        }

        return makeOpenAiBlockedResponseForUpstreamResponse(context.originalResponse, blockContent);
    }

    // hint: 追加提示内容（仅对最终响应有效）
    if (action === "hint") {
        if (context.isRequest || !context.originalResponse || !context.originalBody) {
            // hint 模式不适用于请求拦截，降级为 pass
            return null;
        }

        const hintContent = content ?? "";
        return makeOpenAiHintResponseForUpstreamResponse(
            context.originalResponse,
            context.originalBody,
            hintContent,
        );
    }

    return null;
}
