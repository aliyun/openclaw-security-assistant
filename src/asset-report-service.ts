/**
 * 资产信息上报服务
 *
 * 使用 runtime.ts 中缓存的静态运行时信息，避免重复采集。
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { SDK_VERSION } from "./config.js";
import { isAuthServiceReady } from "./auth-service.js";
import { getRuntimeContext } from "./runtime.js";
import { buildUrl, buildApsHeaders } from "./utils.js";
import {
    logWarn,
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

const execFileAsync = promisify(execFile);

/** 资产上报路径 */
const ASSET_REPORT_PATH = "/v1/agent/heartbeat";

/** CLI 数据缓存默认刷新间隔（毫秒）：10 分钟 */
const CLI_CACHE_REFRESH_INTERVAL_MS = 10 * 60_000;

/** 缓存最大可接受年龄（毫秒）：30 分钟，超过则告警 */
const MAX_CACHE_AGE_MS = 30 * 60_000;

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
 * 异步通过 OpenClaw CLI 获取 skills 列表
 *
 * 使用命令：openclaw skills list --verbose --json
 * 使用异步 execFile 避免阻塞主线程
 */
async function collectSkillsAsync(): Promise<SkillInfo[]> {
    try {
        const { stdout, stderr } = await execFileAsync("openclaw", ["skills", "list", "--verbose", "--json"], {
            encoding: "utf-8",
            timeout: 60_000,
            env: { ...process.env, OPENCLAW_LOG_LEVEL: "silent" },
        });

        // skills CLI 可能将 JSON 输出到 stdout 或 stderr，两者都尝试
        const output = (stdout?.trim() || stderr?.trim()) ?? "";
        if (!output) {
            logWarn("asset-report-service", "skills_empty_output", {
                stdoutLength: stdout?.length ?? 0,
                stderrLength: stderr?.length ?? 0,
            });
            return [];
        }

        // 从输出中提取 JSON 部分（跳过日志前缀）
        const jsonOutput = extractJsonFromOutput(output);
        if (!jsonOutput) {
            logDebug("asset-report-service", "skills_no_json", {});
            return [];
        }

        let parsed: SkillsListJsonOutput;
        try {
            parsed = JSON.parse(jsonOutput);
        } catch (parseError) {
            logWarn("asset-report-service", "skills_parse_error", { error: String(parseError) });
            return [];
        }

        const skills = parsed.skills ?? [];

        logDebug("asset-report-service", "skills_collect_success", {
            skillCount: skills.length,
            eligibleCount: skills.filter(s => s.eligible).length,
        });

        return skills;
    } catch (e: any) {
        logWarn("asset-report-service", "skills_collect_error", {
            error: e?.message || String(e),
            code: e?.code,
            signal: e?.signal,
            stderrPreview: e?.stderr?.trim().slice(0, 500) || "(empty)",
        });
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

// ============================================================================
// CLI Data Cache Types
// ============================================================================

/** CLI 数据异步缓存快照 */
type CliDataSnapshot = {
    skills: SkillInfo[];
    plugins: PluginsListJsonOutput["plugins"];
    refreshedAt: number;
};

/** 空快照（服务启动前或刷新失败时的安全默认值） */
const EMPTY_SNAPSHOT: CliDataSnapshot = { skills: [], plugins: [], refreshedAt: 0 };

// ============================================================================
// Async CLI Data Collection
// ============================================================================

/**
 * 异步采集原始 plugins 列表（一次 CLI 调用，两个视图复用）
 *
 * 使用命令：openclaw plugins list --json
 * 使用异步 execFile 避免阻塞主线程
 */
async function collectPluginsRawAsync(): Promise<PluginsListJsonOutput["plugins"]> {
    try {
        const { stdout } = await execFileAsync("openclaw", ["plugins", "list", "--json"], {
            encoding: "utf-8",
            timeout: 60_000,
            env: { ...process.env, OPENCLAW_LOG_LEVEL: "silent" },
        });

        const output = stdout?.trim();
        if (!output) {
            logDebug("asset-report-service", "plugins_empty_output", {});
            return [];
        }

        const jsonOutput = extractJsonFromOutput(output);
        if (!jsonOutput) {
            logDebug("asset-report-service", "plugins_no_json", {});
            return [];
        }

        let parsed: PluginsListJsonOutput;
        try {
            parsed = JSON.parse(jsonOutput);
        } catch (parseError) {
            logWarn("asset-report-service", "plugins_parse_error", { error: String(parseError) });
            return [];
        }

        const plugins = parsed.plugins ?? [];
        logDebug("asset-report-service", "plugins_collect_success", { pluginCount: plugins.length });
        return plugins;
    } catch (e: any) {
        logWarn("asset-report-service", "plugins_collect_error", {
            error: e?.message || String(e),
            code: e?.code,
            signal: e?.signal,
        });
        return [];
    }
}

/** 从缓存的 plugins 数据生成全量 tools 列表（纯函数，零开销） */
function deriveAllPluginTools(plugins: PluginsListJsonOutput["plugins"]): ToolInfo[] {
    const tools: ToolInfo[] = [];
    for (const plugin of plugins) {
        for (const name of plugin.toolNames ?? []) {
            tools.push({ name, source: `plugin:${plugin.id}` });
        }
    }
    return tools;
}

/** 从缓存的 plugins 数据生成 enabled+loaded 的 tool ID 列表（纯函数，零开销） */
function deriveEnabledLoadedPluginToolIds(plugins: PluginsListJsonOutput["plugins"]): string[] {
    const toolIds: string[] = [];
    for (const plugin of plugins) {
        if (plugin.enabled !== true || plugin.status !== "loaded") continue;
        for (const name of plugin.toolNames ?? []) {
            toolIds.push(`plugin:${plugin.id}/${name}`);
        }
    }
    return toolIds;
}

/**
 * 并行刷新 CLI 数据快照（skills + plugins 异步并行采集）
 */
async function refreshCliDataSnapshot(): Promise<CliDataSnapshot> {
    const startMs = Date.now();
    const [skills, plugins] = await Promise.all([
        collectSkillsAsync(),
        collectPluginsRawAsync(),
    ]);

    const snapshot: CliDataSnapshot = { skills, plugins, refreshedAt: Date.now() };

    logDebug("asset-report-service", "snapshot_refreshed", {
        skillCount: skills.length,
        pluginCount: plugins.length,
        durationMs: Date.now() - startMs,
    });

    return snapshot;
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
    let cacheTimer: NodeJS.Timeout | null = null;
    let snapshot: CliDataSnapshot = EMPTY_SNAPSHOT;
    let refreshing = false;

    /** 防并发刷新缓存快照 */
    async function tryRefreshSnapshot(): Promise<void> {
        if (refreshing) return;
        // auth 未就绪时跳过刷新，避免无效 CLI 子进程开销
        if (!isAuthServiceReady()) return;
        refreshing = true;
        try {
            const newSnapshot = await refreshCliDataSnapshot();
            // 仅当新快照包含有效数据，或旧快照从未刷新过时才替换
            // 避免瞬态 CLI 错误冲掉有效缓存，导致 10 分钟内全部空上报
            if (newSnapshot.skills.length > 0 || newSnapshot.plugins.length > 0 || snapshot.refreshedAt === 0) {
                snapshot = newSnapshot;
            } else {
                logWarn("asset-report-service", "snapshot_empty_discarded", {
                    skillCount: newSnapshot.skills.length,
                    pluginCount: newSnapshot.plugins.length,
                });
            }
        } catch (e: any) {
            logWarn("asset-report-service", "snapshot_refresh_error", { error: String(e?.message || e) });
        } finally {
            refreshing = false;
        }
    }

    async function reportOnce(): Promise<void> {
        // 认证服务未就绪时，跳过上报
        if (!isAuthServiceReady()) {
            logWarn("asset-report-service", "skip", { reason: "auth service not ready" });
            return;
        }

        const url = buildUrl(protectServerAddr, ASSET_REPORT_PATH);

        try {
            // 从运行时上下文获取缓存的静态信息
            const ctx = getRuntimeContext();

            // agentId 未设置时跳过上报（认证未完成）
            if (!ctx.agentId) {
                logWarn("asset-report-service", "skip", { reason: "agentId not set" });
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

            // 从缓存快照读取 skills/plugins 数据（零开销，直接读内存）
            const skills = snapshot.skills;
            const eligibleSkillIds = filterEligibleSkillIds(skills);

            // 缓存过期告警：超过 MAX_CACHE_AGE_MS 未刷新成功
            if (snapshot.refreshedAt > 0 && Date.now() - snapshot.refreshedAt > MAX_CACHE_AGE_MS) {
                logWarn("asset-report-service", "stale_cache", {
                    ageMs: Date.now() - snapshot.refreshedAt,
                });
            }

            // 从缓存 plugins 数据派生 tools 列表（core + plugin tools）
            const tools: ToolInfo[] = [
                ...CORE_TOOLS.map(name => ({ name, source: "core" })),
                ...deriveAllPluginTools(snapshot.plugins),
            ];

            // 生成 Agent 可用的 tool ID 列表（格式：core/<name> 或 plugin:<id>/<name>）
            const toolIds: string[] = [
                ...CORE_TOOLS.map(name => `core/${name}`),
                ...deriveEnabledLoadedPluginToolIds(snapshot.plugins),
            ];

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

            logDebug("asset-report-service", "payload", payload);

            const requestId = randomUUID();
            const headers = buildApsHeaders({ requestId, contentType: "application/json" });

            // AbortController 仅覆盖 HTTP 请求，不包含数据准备时间
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const resp = await originalFetch(url, {
                    method: "POST",
                    signal: controller.signal,
                    headers,
                    body: JSON.stringify(payload),
                });

                if (!resp.ok) {
                    logWarn("asset-report-service", "failed", {
                        status: resp.status,
                        statusText: resp.statusText,
                    });
                    return;
                }

                logDebug("asset-report-service", "success", {});
            } finally {
                clearTimeout(t);
            }

        } catch (e: any) {
            logWarn("asset-report-service", "error", { error: String(e?.message || e) });
        }
    }

    return {
        id: "openclaw-security-assistant-asset-report",
        start: async (ctx: OpenClawPluginServiceContext) => {
            // 等待 auth-service 就绪
            const waitIntervalMs = 10_000; // 10 秒检查一次
            const maxWaitMs = 300_000; // 最多等待 5 分钟
            const startTime = Date.now();

            while (!isAuthServiceReady()) {
                if (Date.now() - startTime > maxWaitMs) {
                    logWarn("asset-report-service", "wait_timeout", { message: "auth service not ready after 5min" });
                    break;
                }
                logDebug("asset-report-service", "waiting", {});
                await new Promise((resolve) => setTimeout(resolve, waitIntervalMs));
            }

            // auth-service 就绪后，先刷新缓存快照再上报
            if (isAuthServiceReady()) {
                await tryRefreshSnapshot();
                await reportOnce().catch(() => {});
            }

            // 定时刷新 CLI 数据缓存（10 分钟）
            cacheTimer = setInterval(() => tryRefreshSnapshot(), CLI_CACHE_REFRESH_INTERVAL_MS);
            cacheTimer.unref?.();

            // 定时上报
            timer = setInterval(() => reportOnce().catch(() => {}), intervalMs);
            timer.unref?.();

            logDebug("asset-report-service", "started", {
                intervalMs,
                timeoutMs,
                cacheRefreshIntervalMs: CLI_CACHE_REFRESH_INTERVAL_MS,
            });
        },
        stop: async (ctx: OpenClawPluginServiceContext) => {
            if (cacheTimer) clearInterval(cacheTimer);
            cacheTimer = null;
            if (timer) clearInterval(timer);
            timer = null;
        },
    };
}
