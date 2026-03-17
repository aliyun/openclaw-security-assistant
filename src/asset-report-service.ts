/**
 * 资产信息上报服务
 *
 * 使用 runtime.ts 中缓存的静态运行时信息，避免重复采集。
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { OpenClawPluginApi, OpenClawPluginService, PluginLogger } from "openclaw/plugin-sdk";
import { SDK_VERSION } from "./config.js";
import { getAccessToken, isAuthServiceReady } from "./auth-service.js";
import { getRuntimeContext } from "./runtime.js";
import { buildUrl } from "./utils.js";
import {
    logInfo,
    logWarn,
    logError,
    logDebug,
} from "./logger.js";
import type {
    AgentInfo,
    AgentModelsInfo,
    AssetReportPayload,
    GatewayInfo,
    ModelInfo,
    ProviderInfo,
    SkillInfo,
    ToolInfo,
} from "./types.js";

/** 资产上报路径 */
const ASSET_REPORT_PATH = "/v1/agent/heartbeat";

// ============================================================================
// Data Collection Helpers
// ============================================================================

/**
 * 从模型配置中提取模型信息（排除敏感字段）
 */
function extractModelInfo(model: { id: string; name?: string; api?: string; reasoning?: boolean; input?: Array<"text" | "image">; contextWindow?: number; maxTokens?: number }): ModelInfo {
    return {
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        input: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
    };
}

/**
 * 采集 Provider 列表（排除敏感字段）
 */
function collectProviders(config: { models?: { providers?: Record<string, unknown> } }): ProviderInfo[] {
    const providers = config.models?.providers;
    if (!providers || typeof providers !== "object") {
        return [];
    }

    const result: ProviderInfo[] = [];
    for (const [providerId, providerConfig] of Object.entries(providers)) {
        if (!providerConfig || typeof providerConfig !== "object") continue;

        const cfg = providerConfig as {
            baseUrl?: string;
            api?: string;
            models?: Array<{ id: string; name?: string; api?: string; reasoning?: boolean; input?: Array<"text" | "image">; contextWindow?: number; maxTokens?: number }>;
        };

        const providerInfo: ProviderInfo = {
            id: providerId,
            baseUrl: cfg.baseUrl,
            api: cfg.api,
        };

        if (Array.isArray(cfg.models)) {
            providerInfo.models = cfg.models.map(extractModelInfo);
        }

        result.push(providerInfo);
    }

    return result;
}

/** 默认 Agent ID */
const DEFAULT_AGENT_ID = "main";

/**
 * 解析 AgentModelConfig，提取 primary 和 fallbacks
 */
function parseAgentModelConfig(modelConfig: unknown): { primary?: string; fallbacks?: string[] } {
    if (!modelConfig) return {};

    if (typeof modelConfig === "string") {
        return { primary: modelConfig };
    }

    if (typeof modelConfig === "object") {
        const cfg = modelConfig as { primary?: string; fallbacks?: string[] };
        return {
            primary: cfg.primary,
            fallbacks: cfg.fallbacks,
        };
    }

    return {};
}

/**
 * 解析默认 Agent ID（参考 OpenClaw 的 resolveDefaultAgentId 逻辑）
 */
function resolveDefaultAgentId(agentsConfig: {
    list?: Array<{ id: string; default?: boolean }>;
}): string {
    const agentList = agentsConfig.list;
    if (!Array.isArray(agentList) || agentList.length === 0) {
        return DEFAULT_AGENT_ID;
    }

    // 找第一个标记为 default 的 agent
    const defaults = agentList.filter((agent) => agent?.default);
    const chosen = (defaults[0] ?? agentList[0])?.id?.trim();
    return chosen || DEFAULT_AGENT_ID;
}

/**
 * 解析 main agent 的默认 workspace 和 agentDir
 */
function resolveMainAgentDefaults(stateDir: string): {
    workspace: string;
    agentDir: string;
} {
    return {
        workspace: path.join(stateDir, "workspace"),
        agentDir: path.join(stateDir, "agents", DEFAULT_AGENT_ID, "agent"),
    };
}

/**
 * 采集 Agent 列表
 */
function collectAgents(config: {
    agents?: {
        defaults?: {
            model?: unknown;
            models?: Record<string, unknown>;
            workspace?: string;
        };
        list?: Array<{
            id: string;
            name?: string;
            default?: boolean;
            model?: unknown;
            workspace?: string;
            agentDir?: string;
            /** Agent 的 skill 过滤器（skill name 列表） */
            skills?: string[];
        }>;
    };
}, stateDir: string, eligibleSkillIds: string[], toolIds: string[]): AgentInfo[] {
    const agentsConfig = config.agents;
    if (!agentsConfig) return [];

    const result: AgentInfo[] = [];
    const agentList = agentsConfig.list;
    const defaults = agentsConfig.defaults;

    // 获取所有 agent 可用的模型列表（从 defaults.models 中获取 keys）
    const availableModels = defaults?.models ? Object.keys(defaults.models) : undefined;

    // 获取默认模型的 primary
    const defaultModelConfig = parseAgentModelConfig(defaults?.model);

    // 解析默认 agent ID
    const defaultAgentId = resolveDefaultAgentId(agentsConfig);

    // main agent 的默认值（仅当 main 没有显式配置时使用）
    const mainDefaults = resolveMainAgentDefaults(stateDir);

    // 采集 agent list
    if (Array.isArray(agentList) && agentList.length > 0) {
        for (const agent of agentList) {
            const isDefault = agent.id === defaultAgentId;

            // agent 级别的模型配置
            const agentModelConfig = parseAgentModelConfig(agent.model);

            // 如果 agent 没有配置 model，使用 defaults.model
            const primary = agentModelConfig.primary ?? defaultModelConfig.primary;
            const fallbacks = agentModelConfig.fallbacks ?? defaultModelConfig.fallbacks;

            const models: AgentModelsInfo | undefined = (availableModels || primary || fallbacks)
                ? {
                    available: availableModels,
                    primary,
                    fallbacks,
                }
                : undefined;

            // workspace 和 agentDir：只有 main 且没有显式配置时才使用默认值
            let workspace = agent.workspace;
            let agentDir = agent.agentDir;

            if (agent.id === DEFAULT_AGENT_ID) {
                workspace = workspace || defaults?.workspace || mainDefaults.workspace;
                agentDir = agentDir || mainDefaults.agentDir;
            }

            result.push({
                id: agent.id,
                name: agent.name,
                isDefault,
                workspace,
                agentDir,
                models,
                skills: eligibleSkillIds.length > 0 ? eligibleSkillIds : undefined,
                tools: toolIds.length > 0 ? toolIds : undefined,
            } as unknown as AgentInfo);
        }
    } else {
        // 没有配置 agent list，创建一个默认 agent (main)
        const models: AgentModelsInfo | undefined = (availableModels || defaultModelConfig.primary || defaultModelConfig.fallbacks)
            ? {
                available: availableModels,
                primary: defaultModelConfig.primary,
                fallbacks: defaultModelConfig.fallbacks,
            }
            : undefined;

        result.push({
            id: DEFAULT_AGENT_ID,
            isDefault: true,
            workspace: defaults?.workspace || mainDefaults.workspace,
            agentDir: mainDefaults.agentDir,
            models,
            skills: eligibleSkillIds.length > 0 ? eligibleSkillIds : undefined,
            tools: toolIds.length > 0 ? toolIds : undefined,
        });
    }

    return result;
}

// ============================================================================
// Skills Collection (via OpenClaw CLI)
// ============================================================================

/**
 * OpenClaw skills list --json 输出格式
 */
type SkillsListJsonOutput = {
    workspaceDir: string;
    managedSkillsDir: string;
    skills: SkillInfo[];
};

/**
 * 通过 OpenClaw CLI 获取 eligible skills 列表
 *
 * 使用命令：openclaw skills list --verbose --json
 *
 * 优点：
 * 1. 与 OpenClaw CLI 行为完全一致
 * 2. 使用官方的 eligible 判断逻辑
 * 3. 减少维护成本
 */
function collectSkills(logger?: PluginLogger): SkillInfo[] {
    try {
        const result = spawnSync("openclaw", ["skills", "list", "--verbose", "--json"], {
            encoding: "utf-8",
            timeout: 120_000, // 120 秒超时
        });

        if (result.error) {
            logWarn("skills", "spawn_error", {
                error: result.error.message,
                code: (result.error as NodeJS.ErrnoException).code,
            });
            return [];
        }

        if (result.status !== 0) {
            logWarn("skills", "exit_error", {
                status: result.status,
                signal: result.signal,
            });
            return [];
        }

        const output = result.stdout?.trim();
        if (!output) {
            logWarn("skills", "empty_output", {});
            return [];
        }

        // 从输出中提取 JSON 部分（跳过日志前缀）
        const jsonOutput = extractJsonFromOutput(output);
        if (!jsonOutput) {
            logWarn("skills", "no_json", {});
            return [];
        }

        let parsed: SkillsListJsonOutput;
        try {
            parsed = JSON.parse(jsonOutput);
        } catch (parseError) {
            logWarn("skills", "parse_error", { error: String(parseError) });
            return [];
        }

        const skills = parsed.skills ?? [];

        logDebug("skills", "collect_success", {
            skillCount: skills.length,
            eligibleCount: skills.filter(s => s.eligible).length,
        });

        return skills;
    } catch (e) {
        logWarn("skills", "exception", { error: String(e) });
        return [];
    }
}

/**
 * 筛选可用的 skill ID 列表
 *
 * @param skills 所有 skills 列表
 * @returns 可用的 skill ID 列表（格式：source/name）
 */
function filterEligibleSkillIds(skills: SkillInfo[]): string[] {
    return skills
        .filter((skill) => skill.eligible === true)
        .map((skill) => `${skill.source}/${skill.name}`);
}

// ============================================================================
// Tools Collection
// ============================================================================

/**
 * Core tools 列表（来自 OpenClaw CORE_TOOL_DEFINITIONS）
 *
 * 来源：src/agents/tool-catalog.ts
 */
const CORE_TOOLS: string[] = [
    "read",
    "write",
    "edit",
    "apply_patch",
    "exec",
    "process",
    "web_search",
    "web_fetch",
    "memory_search",
    "memory_get",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "subagents",
    "session_status",
    "browser",
    "canvas",
    "message",
    "cron",
    "gateway",
    "nodes",
    "agents_list",
    "image",
    "tts",
];

/**
 * OpenClaw plugins list --json 输出格式
 */
type PluginsListJsonOutput = {
    workspaceDir: string;
    plugins: Array<{
        id: string;
        name: string;
        description?: string;
        version?: string;
        source: string;
        origin: string;
        workspaceDir?: string;
        enabled: boolean;
        status: "loaded" | "disabled" | "error";
        error?: string;
        toolNames: string[];
        hookNames: string[];
        channelIds: string[];
        providerIds: string[];
        gatewayMethods: string[];
        cliCommands: string[];
        services: string[];
        commands: string[];
        httpHandlers: number;
        hookCount: number;
        configSchema: boolean;
    }>;
    diagnostics?: Array<{
        level: string;
        message: string;
        pluginId?: string;
    }>;
};

/**
 * 从 CLI 输出中提取 JSON 内容
 *
 * CLI 输出可能包含日志前缀和后缀，需要找到完整的 JSON 对象
 */
function extractJsonFromOutput(output: string): string {
    // 查找 JSON 对象的起始位置
    const jsonStart = output.indexOf("{");
    if (jsonStart === -1) {
        return "";
    }

    // 使用括号匹配找到 JSON 对象的结束位置
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = jsonStart; i < output.length; i++) {
        const char = output[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === "\\") {
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === "{" || char === "[") {
                depth++;
            } else if (char === "}" || char === "]") {
                depth--;
                if (depth === 0) {
                    // 找到匹配的结束括号
                    return output.slice(jsonStart, i + 1);
                }
            }
        }
    }

    // 如果没有找到完整匹配，返回从起始位置到末尾（兼容旧行为）
    return output.slice(jsonStart);
}

/**
 * 采集 Plugin tools 列表（不过滤，返回所有）
 *
 * 使用命令：openclaw plugins list --json
 */
function collectAllPluginTools(logger?: PluginLogger): ToolInfo[] {
    try {
        const result = spawnSync("openclaw", ["plugins", "list", "--json"], {
            encoding: "utf-8",
            timeout: 120_000, // 120 秒超时
        });

        if (result.error) {
            logWarn("tools", "spawn_error", {
                error: result.error.message,
                code: (result.error as NodeJS.ErrnoException).code,
            });
            return [];
        }

        if (result.status !== 0) {
            logWarn("tools", "exit_error", {
                status: result.status,
                signal: result.signal,
            });
            return [];
        }

        const output = result.stdout?.trim();
        if (!output) {
            logWarn("tools", "empty_output", {});
            return [];
        }

        // 从输出中提取 JSON 部分（跳过日志前缀）
        const jsonOutput = extractJsonFromOutput(output);
        if (!jsonOutput) {
            logWarn("tools", "no_json", {});
            return [];
        }

        let parsed: PluginsListJsonOutput;
        try {
            parsed = JSON.parse(jsonOutput);
        } catch (parseError) {
            logWarn("tools", "parse_error", { error: String(parseError) });
            return [];
        }

        const plugins = parsed.plugins ?? [];

        if (plugins.length === 0) {
            logDebug("tools", "no_plugins", {});
        }

        const tools: ToolInfo[] = [];
        for (const plugin of plugins) {
            const pluginId = plugin.id;
            const toolNames = plugin.toolNames ?? [];

            if (toolNames.length === 0) {
                continue;
            }

            for (const name of toolNames) {
                tools.push({
                    name,
                    source: `plugin:${pluginId}`,
                });
            }
        }

        logDebug("tools", "collect_success", {
            pluginCount: plugins.length,
            toolCount: tools.length,
        });

        return tools;
    } catch (e) {
        logWarn("tools", "exception", { error: String(e) });
        return [];
    }
}

/**
 * 采集 enabled 且 loaded plugin tools 的 ID 列表（用于 AgentInfo.tools）
 *
 * 使用命令：openclaw plugins list --json
 *
 * 筛选条件：enabled=true 且 status="loaded"
 */
function collectEnabledLoadedPluginToolIds(logger?: PluginLogger): string[] {
    try {
        const result = spawnSync("openclaw", ["plugins", "list", "--json"], {
            encoding: "utf-8",
            timeout: 120_000, // 120 秒超时
        });

        if (result.error) {
            logWarn("tools", "spawn_error", {
                error: result.error.message,
                code: (result.error as NodeJS.ErrnoException).code,
            });
            return [];
        }

        if (result.status !== 0) {
            logWarn("tools", "exit_error", {
                status: result.status,
                signal: result.signal,
            });
            return [];
        }

        const output = result.stdout?.trim();
        if (!output) {
            logWarn("tools", "empty_output", {});
            return [];
        }

        // 从输出中提取 JSON 部分（跳过日志前缀）
        const jsonOutput = extractJsonFromOutput(output);
        if (!jsonOutput) {
            logWarn("tools", "no_json", {});
            return [];
        }

        let parsed: PluginsListJsonOutput;
        try {
            parsed = JSON.parse(jsonOutput);
        } catch (parseError) {
            logWarn("tools", "parse_error", { error: String(parseError) });
            return [];
        }

        const plugins = parsed.plugins ?? [];
        const toolIds: string[] = [];

        for (const plugin of plugins) {
            // 筛选 enabled=true 且 status="loaded" 的 plugin
            if (plugin.enabled !== true || plugin.status !== "loaded") {
                continue;
            }

            const pluginId = plugin.id;
            const toolNames = plugin.toolNames ?? [];

            for (const name of toolNames) {
                toolIds.push(`plugin:${pluginId}/${name}`);
            }
        }

        logDebug("tools", "collect_enabled_success", {
            pluginCount: plugins.length,
            enabledLoadedCount: plugins.filter(p => p.enabled && p.status === "loaded").length,
            toolCount: toolIds.length,
        });

        return toolIds;
    } catch (e) {
        logWarn("tools", "exception", { error: String(e) });
        return [];
    }
}

/**
 * 采集所有 tools 列表（core + 所有 plugin tools）
 *
 * @param logger 日志记录器
 * @returns 所有 tools 列表
 */
function collectTools(logger?: PluginLogger): ToolInfo[] {
    const tools: ToolInfo[] = [];

    // 添加 core tools
    for (const name of CORE_TOOLS) {
        tools.push({
            name,
            source: "core",
        });
    }

    // 添加所有 plugin tools（不过滤）
    tools.push(...collectAllPluginTools(logger));

    return tools;
}

/**
 * 生成 Agent 可用的 tool ID 列表
 *
 * 包含：core tools + enabled=true 且 status="loaded" 的 plugin tools
 *
 * @param logger 日志记录器
 * @returns tool ID 列表（格式：core/<name> 或 plugin:<id>/<name>）
 */
function generateAgentToolIds(logger?: PluginLogger): string[] {
    const toolIds: string[] = [];

    // 添加 core tools
    for (const name of CORE_TOOLS) {
        toolIds.push(`core/${name}`);
    }

    // 添加 enabled=true 且 status="loaded" 的 plugin tools
    toolIds.push(...collectEnabledLoadedPluginToolIds(logger));

    return toolIds;
}

/**
 * 创建资产信息上报服务
 */
export function createAssetReportService(params: {
    api: OpenClawPluginApi;
    originalFetch: typeof globalThis.fetch;
    protectServerAddr: string;
    intervalMs?: number;
    timeoutMs?: number;
}): OpenClawPluginService {
    const { api, originalFetch, protectServerAddr } = params;
    const intervalMs = params.intervalMs ?? 60_000; // 默认 1 分钟上报一次
    const timeoutMs = params.timeoutMs ?? 5_000;

    let timer: NodeJS.Timeout | null = null;

    async function reportOnce(logger: PluginLogger): Promise<void> {
        // 认证服务未就绪时，跳过上报
        if (!isAuthServiceReady()) {
            logWarn("asset_report", "skip", { reason: "auth service not ready" });
            return;
        }

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);

        const url = buildUrl(protectServerAddr, ASSET_REPORT_PATH);

        try {
            // 从运行时上下文获取缓存的静态信息
            const ctx = getRuntimeContext();

            // agentId 未设置时跳过上报（认证未完成）
            if (!ctx.agentId) {
                logWarn("asset_report", "skip", { reason: "agentId not set" });
                return;
            }

            // 动态获取 gateway 配置（可能运行时变化）
            const gatewayInfo: GatewayInfo | undefined = api.config?.gateway
                ? {
                    port: api.config.gateway.port,
                    mode: api.config.gateway.mode,
                    bind: api.config.gateway.bind,
                }
                : undefined;

            // 采集 providers 信息
            const stateDir = api.runtime.state.resolveStateDir();
            const providers = collectProviders(api.config);

            // 采集 skills 信息
            const skills = collectSkills(logger);

            // 筛选可用的 skill ID 列表
            const eligibleSkillIds = filterEligibleSkillIds(skills);

            // 采集 tools 信息（所有 tools）
            const tools = collectTools(logger);

            // 生成 Agent 可用的 tool ID 列表（core + enabled=true 且 status="loaded" 的 plugin tools）
            const toolIds = generateAgentToolIds(logger);

            // 采集 agents 信息（传入可用的 skill ID 列表和 tool ID 列表）
            const agents = collectAgents(api.config, stateDir, eligibleSkillIds, toolIds);

            const payload: AssetReportPayload = {
                agent_id: ctx.agentId,
                system: ctx.system,
                node_runtime: ctx.nodeRuntime,
                openclaw: {
                    version: ctx.openclaw.version,
                    gateway: gatewayInfo,
                    providers,
                    skills,
                    tools,
                    agents,
                },
            };

            // 调试日志：上报数据
            logDebug("asset_report", "payload", payload);

            const requestId = randomUUID();
            // 从 auth-service 获取运行时的 access token
            const authToken = getAccessToken();

            const headers: Record<string, string> = {
                "Content-Type": "application/json",
                "X-Request-Id": requestId,
                "X-SDK-Version": SDK_VERSION,
            };

            // 添加身份认证 header
            if (authToken) {
                headers["Authorization"] = `Bearer ${authToken}`;
            }

            const resp = await originalFetch(url, {
                method: "POST",
                signal: controller.signal,
                headers,
                body: JSON.stringify(payload),
            });

            if (!resp.ok) {
                logWarn("asset_report", "failed", {
                    status: resp.status,
                    statusText: resp.statusText,
                });
                return;
            }

            // 关键日志：上报成功
            logInfo("asset_report", "success", {});

        } catch (e: any) {
            logWarn("asset_report", "error", { error: String(e?.message || e) });
        } finally {
            clearTimeout(t);
        }
    }

    return {
        id: "openclaw-security-assistant-asset-report",
        start: async (ctx) => {
            // 等待 auth-service 就绪
            const waitIntervalMs = 10_000; // 10 秒检查一次
            const maxWaitMs = 300_000; // 最多等待 5 分钟
            const startTime = Date.now();

            while (!isAuthServiceReady()) {
                if (Date.now() - startTime > maxWaitMs) {
                    logWarn("asset_report", "wait_timeout", { message: "auth service not ready after 5min" });
                    break;
                }
                logDebug("asset_report", "waiting", {});
                await new Promise((resolve) => setTimeout(resolve, waitIntervalMs));
            }

            // auth-service 就绪后，立即上报一次
            if (isAuthServiceReady()) {
                await reportOnce(ctx.logger).catch(() => {});
            }

            // 定时上报
            timer = setInterval(() => reportOnce(ctx.logger).catch(() => {}), intervalMs);
            timer.unref?.();

            logInfo("asset_report", "started", { intervalMs, timeoutMs });
        },
        stop: async () => {
            if (timer) clearInterval(timer);
            timer = null;
        },
    };
}
