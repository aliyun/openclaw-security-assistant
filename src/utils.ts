/**
 * 通用工具函数
 */

import { randomUUID } from "node:crypto";
import { SDK_VERSION } from "./config.js";
import { getAgentRuntime } from "./runtime.js";
import { getAccessToken } from "./auth-service.js";

/**
 * 拼接基础地址和路径生成完整 URL
 * 使用原生 URL API，确保正确处理各种边界情况
 *
 * @param baseAddr - 基础地址，如 "http://127.0.0.1:28888"
 * @param path - 路径，如 "/v1/agent/llm_check"
 * @returns 完整的 URL 字符串
 */
export function buildUrl(baseAddr: string, path: string): string {
    const url = new URL(path, baseAddr);
    return url.toString();
}

/**
 * 构建 APS 服务请求公共 headers
 *
 * 包含：X-Request-Id、X-SDK-Version、X-Agent-Runtime、Authorization（如有 token）
 *
 * @param options.requestId - 请求追踪 ID（默认自动生成 UUID）
 * @param options.contentType - Content-Type（不传则不设置，适用于 FormData 等场景）
 */
export function buildApsHeaders(options?: {
    requestId?: string;
    contentType?: string;
}): Record<string, string> {
    const requestId = options?.requestId ?? randomUUID();
    const authToken = getAccessToken();

    const headers: Record<string, string> = {
        "X-Request-Id": requestId,
        "X-SDK-Version": SDK_VERSION,
        "X-Agent-Runtime": getAgentRuntime(),
    };

    if (options?.contentType) {
        headers["Content-Type"] = options.contentType;
    }

    if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
    }

    return headers;
}
