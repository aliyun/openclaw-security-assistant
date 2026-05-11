/**
 * 状态透出模块 - HTTP 路由 + 斜杠命令注册
 *
 * HTTP 端点（程序化调用）：
 *   /health - 用户视角概览（JSON）
 *   /status - 运维视角详情（JSON）
 *
 * 斜杠命令（聊天频道调用）：
 *   /security-health - 用户视角概览（可读文本）
 *   /security-status - 运维视角详情（JSON 代码块）
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { StatusCollector } from "./collector.js";
import type { HealthResponse } from "./types.js";
import { HEALTH_PATH, STATUS_PATH, healthStatusToHttpCode, statusEmoji } from "./shared.js";
import { logDebug } from "../logger.js";

// ============================================================================
// HTTP Response Helpers
// ============================================================================

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
    });
    res.end(payload);
}

// ============================================================================
// Route Registration
// ============================================================================

/**
 * 注册状态透出 HTTP 路由
 *
 * @param api OpenClaw 插件 API
 * @param collector 状态收集器实例
 */
export function registerStatusRoutes(
    api: OpenClawPluginApi,
    collector: StatusCollector,
): void {
    // Health endpoint - user-facing concise overview
    // replaceExisting: gateway restart triggers re-register; keep routes idempotent
    api.registerHttpRoute({
        path: HEALTH_PATH,
        auth: "plugin",
        match: "exact",
        replaceExisting: true,
        handler: (_req: IncomingMessage, res: ServerResponse) => {
            const health = collector.computeHealth();
            const httpCode = healthStatusToHttpCode(health.status);
            logDebug("status", "health_request", { status: health.status, httpCode });
            writeJson(res, httpCode, health);
            return true;
        },
    });

    // Status endpoint - ops-facing detailed diagnostics
    api.registerHttpRoute({
        path: STATUS_PATH,
        auth: "plugin",
        match: "exact",
        replaceExisting: true,
        handler: (_req: IncomingMessage, res: ServerResponse) => {
            const status = collector.collect();
            logDebug("status", "status_request", {});
            writeJson(res, 200, status);
            return true;
        },
    });

    logDebug("status", "routes_registered", {
        health: HEALTH_PATH,
        status: STATUS_PATH,
    });
}

// ============================================================================
// Slash Command Registration
// ============================================================================

/**
 * 将 health 数据格式化为聊天可读文本（Markdown）
 */
function formatHealthText(health: HealthResponse): string {
    const emoji = statusEmoji(health.status);
    return [
        `🛡️ **Alibaba Cloud OpenClaw-Security-Assistant**`,
        ``,
        `Status: ${emoji} **${health.status}**`,
        `Message: ${health.message}`,
        `Version: ${health.version}`,
        `Time: ${health.timestamp}`,
    ].join("\n");
}

/**
 * 注册状态透出 CLI 命令
 *
 * @param api OpenClaw 插件 API
 * @param collector 状态收集器实例
 */
export function registerStatusCommands(
    api: OpenClawPluginApi,
    collector: StatusCollector,
): void {
    // /security-health - 用户视角概览（可读文本）
    api.registerCommand({
        name: "ali-osa-health",
        description: "Show security assistant health status",
        handler: () => {
            const health = collector.computeHealth();
            logDebug("status", "health_command", { status: health.status });
            return { text: formatHealthText(health) };
        },
    });

    // /security-status - 运维视角详情（JSON 代码块）
    api.registerCommand({
        name: "ali-osa-status",
        description: "Show security assistant detailed diagnostics",
        handler: () => {
            const status = collector.collect();
            logDebug("status", "status_command", {});
            return { text: `🔍 **Security Assistant Status**\n\n\`\`\`json\n${JSON.stringify(status, null, 2)}\n\`\`\`` };
        },
    });

    logDebug("status", "commands_registered", {
        commands: ["ali-osa-health", "ali-osa-status"],
    });
}
