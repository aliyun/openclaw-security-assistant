/**
 * 状态透出模块 - CLI 命令注册
 *
 * 注册 `openclaw ali-osa` 命令组，通过 HTTP 请求网关已有端点
 * 获取运行时状态数据。
 *
 * 子命令：
 *   openclaw ali-osa health [--json]
 *   openclaw ali-osa status
 */

import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { HEALTH_PATH, STATUS_PATH, statusEmoji } from "./shared.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_GATEWAY_PORT = 18789;
const FETCH_TIMEOUT_MS = 60_000;

// ============================================================================
// Helpers
// ============================================================================

/**
 * 解析网关端口（优先级：env > config > default）
 */
function resolvePort(config: OpenClawConfig): number {
    const envRaw = process.env.OPENCLAW_GATEWAY_PORT?.trim();
    if (envRaw) {
        const envPort = parseInt(envRaw, 10);
        if (Number.isFinite(envPort) && envPort > 0) return envPort;
    }
    const cfgPort = (config.gateway as Record<string, unknown> | undefined)?.port;
    if (typeof cfgPort === "number" && Number.isFinite(cfgPort) && cfgPort > 0) return cfgPort;
    return DEFAULT_GATEWAY_PORT;
}

/**
 * 构建网关 HTTP 基础 URL（根据 TLS 配置选择协议）
 */
function resolveBaseUrl(config: OpenClawConfig): string {
    const port = resolvePort(config);
    const gw = config.gateway as Record<string, unknown> | undefined;
    const tls = gw?.tls as Record<string, unknown> | undefined;
    const scheme = tls?.enabled === true ? "https" : "http";
    return `${scheme}://127.0.0.1:${port}`;
}

/**
 * 请求网关 HTTP 端点并返回 JSON 数据
 *
 * 放行 503：/health 在 error 态下以 503 返回合法 body，不应被视作网关不可达。
 * 其他非 2xx 仍抛错，由 `printGatewayError` 展示友好提示。
 */
async function fetchEndpoint(baseUrl: string, path: string): Promise<unknown> {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok && res.status !== 503) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return res.json();
}

// ============================================================================
// CLI Registration
// ============================================================================

/**
 * 注册 `openclaw ali-osa` CLI 命令组
 */
export function registerSecurityAssistantCli(program: Command, config: OpenClawConfig): void {
    const sa = program
        .command("ali-osa")
        .description("Alibaba Cloud OpenClaw Security Assistant status and diagnostics");

    sa.command("health")
        .description("Show security assistant health status")
        .option("--json", "Output raw JSON")
        .action(async (opts: { json?: boolean }) => {
            try {
                const baseUrl = resolveBaseUrl(config);
                const data = await fetchEndpoint(baseUrl, HEALTH_PATH);
                if (opts.json) {
                    console.log(JSON.stringify(data, null, 2));
                    return;
                }
                formatHealthOutput(data as Record<string, unknown>);
            } catch (err) {
                printGatewayError(err);
                process.exitCode = 1;
            }
        });

    sa.command("status")
        .description("Show security assistant detailed diagnostics")
        .action(async () => {
            try {
                const baseUrl = resolveBaseUrl(config);
                const data = await fetchEndpoint(baseUrl, STATUS_PATH);
                console.log(JSON.stringify(data, null, 2));
            } catch (err) {
                printGatewayError(err);
                process.exitCode = 1;
            }
        });
}

// ============================================================================
// Output Formatting
// ============================================================================

const STATUS_HEADER = "🛡️ **Alibaba Cloud OpenClaw-Security-Assistant**";

function formatHealthOutput(data: Record<string, unknown>): void {
    const status = String(data.status ?? "unknown");
    const emoji = statusEmoji(status);
    console.log(`${STATUS_HEADER}\n`);
    console.log(`Status:  ${emoji} ${status}`);
    console.log(`Message: ${data.message ?? "-"}`);
    console.log(`Version: ${data.version ?? "-"}`);
    console.log(`Time:    ${data.timestamp ?? "-"}`);
}

function printGatewayError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
        err instanceof Error &&
        (err.name === "TimeoutError" || /aborted due to timeout/i.test(msg));
    if (isTimeout) {
        console.error(
            `Gateway request timed out after ${FETCH_TIMEOUT_MS}ms: ${msg}`,
        );
        console.error(
            "Gateway may still be initializing plugin routes. Retry in a moment.",
        );
        return;
    }
    console.error(`Failed to reach gateway: ${msg}`);
    console.error("Ensure the gateway is running (openclaw gateway run).");
}
