/**
 * 通用工具函数
 */

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
