/**
 * 统一日志工具模块
 *
 * 所有日志统一使用 "openclaw-security-assistant" 作为前缀。
 * 支持 debug 模式：
 * - debug=true: 输出详细日志（包括调试信息）
 * - debug=false: 仅输出关键日志（安全检查结果、认证状态等）
 */

import type { PluginLogger } from "openclaw/plugin-sdk";

/** 日志前缀 */
const LOG_PREFIX = "[openclaw-security-assistant]";

/** 当前 logger 实例 */
let currentLogger: PluginLogger | undefined;

/** 当前 debug 模式 */
let debugMode = false;

/**
 * 初始化日志器
 */
export function initLogger(logger: PluginLogger | undefined, debug: boolean): void {
    currentLogger = logger;
    debugMode = debug;
}

/**
 * 格式化日志消息
 */
function formatMessage(category: string, action: string, data?: unknown): string {
    const prefix = `${LOG_PREFIX} [${category}] [${action}]`;
    if (data !== undefined) {
        const dataStr = typeof data === "string" ? data : JSON.stringify(data);
        return `${prefix} ${dataStr}`;
    }
    return prefix;
}

/**
 * 输出 info 日志（关键日志，无论 debug 模式都会输出）
 */
export function logInfo(category: string, action: string, data?: unknown): void {
    currentLogger?.info?.(formatMessage(category, action, data));
}

/**
 * 输出 warn 日志（关键日志，无论 debug 模式都会输出）
 */
export function logWarn(category: string, action: string, data?: unknown): void {
    currentLogger?.warn?.(formatMessage(category, action, data));
}

/**
 * 输出 error 日志（关键日志，无论 debug 模式都会输出）
 */
export function logError(category: string, action: string, data?: unknown): void {
    currentLogger?.error?.(formatMessage(category, action, data));
}

/**
 * 输出 debug 日志（仅在 debug 模式下输出）
 */
export function logDebug(category: string, action: string, data?: unknown): void {
    if (!debugMode) return;
    currentLogger?.info?.(formatMessage(category, action, data));
}
