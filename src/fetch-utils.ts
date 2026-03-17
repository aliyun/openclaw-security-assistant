/**
 * Fetch 辅助函数
 */

/**
 * 将 Headers 对象转换为 Record
 */
export function headersToRecord(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        headers.forEach((v, k) => (out[k] = v));
    } catch {}
    return out;
}

/**
 * 将 HeadersInit 转换为 Record
 */
export function headersInitToRecord(headersInit: HeadersInit | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!headersInit) return out;

    try {
        if (headersInit instanceof Headers) {
            headersInit.forEach((v, k) => (out[k] = v));
        } else if (Array.isArray(headersInit)) {
            for (const [k, v] of headersInit) out[String(k)] = String(v);
        } else {
            for (const [k, v] of Object.entries(headersInit)) out[k] = String(v);
        }
    } catch {}

    return out;
}

/**
 * 从 fetch 参数中提取 URL
 */
export function getUrlFromFetchArgs(input: RequestInfo | URL): string {
    return typeof input === "string"
        ? input
        : input instanceof URL
            ? input.toString()
            : input instanceof Request
                ? input.url
                : String(input);
}

/**
 * 从 fetch 参数中提取 HTTP 方法
 */
export function getMethodFromFetchArgs(input: RequestInfo | URL, init?: RequestInit): string {
    const m = init?.method ?? (input instanceof Request ? input.method : "GET") ?? "GET";
    return String(m).toUpperCase();
}

/**
 * 从 fetch 参数中提取请求体文本
 */
export async function getRequestBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
    if (input instanceof Request) {
        try {
            return await input.clone().text();
        } catch {
            return "";
        }
    }
    return typeof init?.body === "string" ? init.body : "";
}

/**
 * 合并 fetch 参数中的请求 headers
 */
export function getMergedRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
    const initHeaders = headersInitToRecord(init?.headers);
    const inputHeaders = input instanceof Request ? headersToRecord(input.headers) : {};
    return { ...inputHeaders, ...initHeaders }; // init 覆盖 input
}

/**
 * 判断响应是否为 SSE 流
 */
export function isSseResponse(resp: Response): boolean {
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    return ct.includes("text/event-stream");
}
