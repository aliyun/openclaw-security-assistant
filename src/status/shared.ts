/**
 * 状态透出模块 - 共享常量与格式化工具
 *
 * 被 routes.ts（HTTP 路由 + 斜杠命令）和 cli.ts（终端 CLI）共同引用。
 */

import type { HealthStatus } from "./types.js";

// ============================================================================
// Endpoint Path Constants
// ============================================================================

/** Health 端点路径 */
export const HEALTH_PATH = "/plugin/openclaw-security-assistant/health";

/** Status 端点路径 */
export const STATUS_PATH = "/plugin/openclaw-security-assistant/status";

// ============================================================================
// Display Helpers
// ============================================================================

/** 状态 emoji 映射 */
export const STATUS_EMOJI: Record<HealthStatus, string> = {
    ok: "✅",
    waiting: "⏳",
    error: "❌",
};

/**
 * 获取状态对应的 emoji（未知状态返回 ❓）
 */
export function statusEmoji(status: string): string {
    return (STATUS_EMOJI as Record<string, string>)[status] ?? "❓";
}

// ============================================================================
// HTTP Status Code Mapping
// ============================================================================

/**
 * Health 业务状态 -> HTTP 状态码映射
 *
 * - ok / waiting：200（waiting 属启动期正常态，不触发监控告警）
 * - error：503 Service Unavailable（探针可据此判活）
 */
export function healthStatusToHttpCode(status: HealthStatus): 200 | 503 {
    return status === "error" ? 503 : 200;
}
