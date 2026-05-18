/**
 * oc-sec 元数据透传机制
 *
 * 在 before_prompt_build 阶段注入 HTML 注释格式的标记到 system prompt，
 * 在 wrappedFetch 中提取并解码，实现 session/run ID 的跨 Hook 透传。
 */

// ============================================================================
// Marker 常量
// ============================================================================

/** oc-sec 元数据标记前缀（HTML 注释格式，对 LLM 不可见） */
export const OC_SEC_MARKER_PREFIX = "<!-- oc-sec:";
export const OC_SEC_MARKER_SUFFIX = " -->";

/**
 * oc-sec 正则：提取 base64 编码的 payload
 *
 * 标记格式：<!-- oc-sec:BASE64_STRING -->
 * payload 解码后为 sid=VALUE&rid=VALUE 的 key=value 格式
 */
export const OC_SEC_MARKER_REGEX = /<!-- oc-sec:([A-Za-z0-9+/=]+) -->/;

/** oc-sec 正则：全局摘除标记 */
export const OC_SEC_MARKER_GLOBAL_REGEX = /<!-- oc-sec:[A-Za-z0-9+/=]+ -->/g;

// ============================================================================
// Types
// ============================================================================

/** oc-sec 元数据结构（嵌入 system prompt 的标记中） */
export type OcSecMetadata = {
    /** Session Key：会话路由键，如 "agent:main:telegram:alice"，用于 rid 不可用时回查 runId */
    sid: string;
    /** Run ID：执行级标识，一条用户消息 = 一个 run */
    rid: string;
};

/** oc-sec 提取结果 */
export type OcSecExtractionResult = {
    /** 提取到的元数据，未匹配到时为 null */
    metadata: OcSecMetadata | null;
    /** 摘除标记后的干净 body 文本 */
    cleanBody: string;
};

// ============================================================================
// Encode / Decode
// ============================================================================

/**
 * 从 base64 编码的 oc-sec marker 中解码并解析 sid/rid。
 * @param encoded - base64 编码的字符串（正则捕获组 [1]）
 * @returns 解析后的 OcSecMetadata，解码失败或超长时返回 null
 */
export function decodeOcSecPayload(encoded: string): OcSecMetadata | null {
    // 合法 payload 为 "sid=UUID&rid=UUID"（约 80 字节），base64 编码后约 108 字符
    // 设 256 为安全上限，超过则视为恶意构造
    const MAX_ENCODED_LENGTH = 256;

    if (encoded.length === 0 || encoded.length > MAX_ENCODED_LENGTH) {
        return null;
    }

    try {
        const decoded = Buffer.from(encoded, "base64").toString("utf-8");
        const params = new URLSearchParams(decoded);
        const sid = params.get("sid");
        const rid = params.get("rid");
        if (sid && rid) {
            return { sid, rid };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 将 sid 和 rid 编码为 base64 格式的 oc-sec marker payload。
 * @returns base64 编码的字符串
 */
export function encodeOcSecPayload(sid: string, rid: string): string {
    const payload = `sid=${sid}&rid=${rid}`;
    return Buffer.from(payload).toString("base64");
}
