/**
 * 资产信息上报服务
 *
 * 使用 runtime.ts 中缓存的静态运行时信息，避免重复采集。
 * Skills 和 Plugins 数据通过进程内文件系统采集器获取，无需 CLI 子进程。
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { SDK_VERSION } from "./config.js";
import { isAuthServiceReady } from "./auth-service.js";
import { getRuntimeContext } from "./runtime.js";
import { buildUrl, buildApsHeaders } from "./utils.js";
import { collectSkillsInternal, collectPluginsInternal, type PluginRecord } from "./internal-collectors.js";
import {
    logWarn,
    logDebug,
    logInfo,
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
} from "./asset-types.js";

/** 资产上报路径 */
const ASSET_REPORT_PATH = "/v1/agent/heartbeat";

/** 资产数据缓存默认刷新间隔（毫秒）：30 分钟 */
const CLI_CACHE_REFRESH_INTERVAL_MS = 30 * 60_000;

/** 缓存最大可接受年龄（毫秒）：90 分钟，超过则告警 */
const MAX_CACHE_AGE_MS = 90 * 60_000;

// ============================================================================
// Report Status Tracking (module-level, survives re-register)
// ============================================================================

/** 最近一次上报时间（ISO 格式） */
let lastReportAt: string | null = null;

/** 最近一次上报错误信息，成功时为 null */
let lastReportErrMsg: string | null = null;

/** 获取最近一次上报时间 */
export function getLastAssetReportAt(): string | null {
    return lastReportAt;
}

/** 获取最近一次上报错误信息 */
export function getLastAssetReportErrMsg(): string | null {
    return lastReportErrMsg;
}

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

// ============================================================================
// Agent skills 白名单过滤（对齐 core resolveEffectiveAgentSkillFilter 语义）
// ============================================================================

/**
 * 规范化 agent 的 skills 白名单。
 * - undefined 入参 → undefined（不限制）
 * - 非数组 → undefined（无效配置降级为"不限制"，与 core normalizeSkillFilter 一致）
 * - 数组 → 裁剪空串后的字符串列表（可为空数组，表示"显式禁用所有"）
 */
function normalizeAgentSkillFilter(input: unknown): string[] | undefined {
    if (input === undefined) return undefined;
    if (!Array.isArray(input)) return undefined;
    return input
        .filter((v): v is string => typeof v === "string")
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * 解析该 agent 的有效 skills 白名单（对齐 core resolveEffectiveAgentSkillFilter）：
 * agent 自有 `skills` 字段优先（即便为空数组也算显式声明）；否则回退 defaults.skills。
 */
function resolveAgentSkillFilter(
    agent: { skills?: unknown },
    defaults: { skills?: unknown } | undefined,
): string[] | undefined {
    if (Object.prototype.hasOwnProperty.call(agent, "skills")) {
        return normalizeAgentSkillFilter(agent.skills);
    }
    return normalizeAgentSkillFilter(defaults?.skills);
}

/**
 * 用 agent 白名单（skill name 列表）过滤全局 eligibleSkillIds（`source/name` 形式）。
 * - filter undefined → 全量返回（不限制）
 * - filter []        → 返回 []（显式禁用所有）
 * - filter 非空       → 按 skill name 匹配保留
 */
function applyAgentSkillFilter(
    eligibleSkillIds: string[],
    filter: string[] | undefined,
): string[] {
    if (filter === undefined) return eligibleSkillIds;
    if (filter.length === 0) return [];
    const nameSet = new Set(filter);
    return eligibleSkillIds.filter((id) => {
        const slashIdx = id.lastIndexOf("/");
        const name = slashIdx >= 0 ? id.substring(slashIdx + 1) : id;
        return nameSet.has(name);
    });
}

/**
 * 根据 agent 的 skills 白名单决定 payload 的 `skills` 字段：
 * - 有显式白名单（包括 []）→ 返回过滤后的数组（保留空数组，不退化为 undefined）
 * - 无白名单 → 全量 eligible；若 eligible 为空则返回 undefined（省略字段）
 */
function computeAgentSkillsField(
    eligibleSkillIds: string[],
    filter: string[] | undefined,
): string[] | undefined {
    const filtered = applyAgentSkillFilter(eligibleSkillIds, filter);
    if (filter !== undefined) return filtered;
    return filtered.length > 0 ? filtered : undefined;
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
            /** Agent 默认 skills 白名单（skill name 列表；agent 未显式声明 skills 时生效） */
            skills?: string[];
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
                skills: computeAgentSkillsField(
                    eligibleSkillIds,
                    resolveAgentSkillFilter(agent, defaults),
                ),
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
            // fallback 分支无显式 agentList，只可能继承 defaults.skills
            skills: computeAgentSkillsField(
                eligibleSkillIds,
                normalizeAgentSkillFilter(defaults?.skills),
            ),
            tools: toolIds.length > 0 ? toolIds : undefined,
        });
    }

    // 记录 agent 级 skills 白名单生效情况，便于排查过滤差异
    const filteredAgentCount = result.filter(
        (a) => Array.isArray(a.skills) && a.skills.length !== eligibleSkillIds.length,
    ).length;
    logDebug("asset-report-service", "agents_collected", {
        agentCount: result.length,
        eligibleSkillCount: eligibleSkillIds.length,
        filteredAgentCount,
    });

    return result;
}

// ============================================================================
// Skills Collection (via in-process filesystem scan)
// ============================================================================
//
// Eligible skill id 列表现在由 `collectSkillsInternal` 直接返回（SkillCollectResult.eligibleIds），
// SkillInfo 对外不再携带 `eligible` 字段，因此不再需要从 skills[] 过滤。

// ============================================================================
// Tools Collection
// ============================================================================

/**
 * Core tools 列表（来自 OpenClaw CORE_TOOL_DEFINITIONS）
 *
 * KEEP-IN-SYNC: src/agents/tool-catalog.ts CORE_TOOL_DEFINITIONS
 *
 * 本列表仅用于 APS SLS 资产名上报（asset.log 中 `asset_type=tool` 条目），
 * 不影响 gateway 运行、不影响安全检测、不影响用户功能。
 * core 升级若新增/删除 core tool，需手动同步本列表；漂移仅导致 SLS 资产统计不全。
 * 参见独立 followup：推动 plugin-sdk 暴露 `listCoreToolIds()` 以彻底去硬编码。
 */
const CORE_TOOLS: string[] = [
    "read",
    "write",
    "edit",
    "apply_patch",
    "exec",
    "process",
    "code_execution",
    "web_search",
    "web_fetch",
    "x_search",
    "memory_search",
    "memory_get",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "subagents",
    "session_status",
    "browser",
    "canvas",
    "message",
    "heartbeat_respond",
    "cron",
    "gateway",
    "nodes",
    "agents_list",
    "update_plan",
    "image",
    "image_generate",
    "music_generate",
    "video_generate",
    "tts",
];

// ============================================================================
// Asset Data Cache Types
// ============================================================================

/** 资产数据异步缓存快照 */
type AssetDataSnapshot = {
    skills: SkillInfo[];
    /** 进程内计算的 eligible skill ID 列表（格式 `source/name`），供 agent.skills 过滤使用 */
    eligibleSkillIds: string[];
    plugins: PluginRecord[];
    refreshedAt: number;
};

/** 空快照（服务启动前或刷新失败时的安全默认值） */
const EMPTY_SNAPSHOT: AssetDataSnapshot = { skills: [], eligibleSkillIds: [], plugins: [], refreshedAt: 0 };

// ============================================================================
// Async Asset Data Collection
// ============================================================================

/** 从缓存的 plugins 数据生成全量 tools 列表（纯函数，零开销） */
function deriveAllPluginTools(plugins: PluginRecord[]): ToolInfo[] {
    const tools: ToolInfo[] = [];
    for (const plugin of plugins) {
        for (const name of plugin.toolNames ?? []) {
            tools.push({ name, source: `plugin:${plugin.id}` });
        }
    }
    return tools;
}

/** 从缓存的 plugins 数据生成 enabled+loaded 的 tool ID 列表（纯函数，零开销） */
function deriveEnabledLoadedPluginToolIds(plugins: PluginRecord[]): string[] {
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
 * 串行刷新资产数据快照（skills + plugins 进程内采集）
 *
 * 串行执行避免并行 IO 争用，单个采集器失败不影响另一个。
 */
async function refreshAssetDataSnapshot(api: OpenClawPluginApi): Promise<AssetDataSnapshot> {
    const startMs = Date.now();

    let skills: SkillInfo[] = [];
    let eligibleSkillIds: string[] = [];
    try {
        const result = await collectSkillsInternal(api);
        skills = result.skills;
        eligibleSkillIds = result.eligibleIds;
    } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logWarn("asset-report-service", "skills_collect_error", {
            error: errorMessage,
        });
    }

    let plugins: PluginRecord[] = [];
    try {
        plugins = await collectPluginsInternal(api);
    } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logWarn("asset-report-service", "plugins_collect_error", {
            error: errorMessage,
        });
    }

    const snapshot: AssetDataSnapshot = { skills, eligibleSkillIds, plugins, refreshedAt: Date.now() };

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
    let snapshot: AssetDataSnapshot = EMPTY_SNAPSHOT;
    let refreshing = false;

    /** 防并发刷新缓存快照 */
    async function tryRefreshSnapshot(): Promise<void> {
        if (refreshing) return;
        // auth 未就绪时跳过刷新，避免无效采集开销
        if (!isAuthServiceReady()) return;
        refreshing = true;
        logDebug("asset-report-service", "snapshot_refresh_start", {
            previousRefreshedAt: snapshot.refreshedAt,
        });
        try {
            const newSnapshot = await refreshAssetDataSnapshot(api);
            // 仅当新快照包含有效数据，或旧快照从未刷新过时才替换
            // 避免瞬态采集错误冲掉有效缓存，导致 10 分钟内全部空上报
            if (newSnapshot.skills.length > 0 || newSnapshot.plugins.length > 0 || snapshot.refreshedAt === 0) {
                snapshot = newSnapshot;
            } else {
                logWarn("asset-report-service", "snapshot_empty_discarded", {
                    skillCount: newSnapshot.skills.length,
                    pluginCount: newSnapshot.plugins.length,
                });
            }
        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            logWarn("asset-report-service", "snapshot_refresh_error", { error: errorMessage });
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
            const eligibleSkillIds = snapshot.eligibleSkillIds;

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
                    lastReportAt = new Date().toISOString();
                    lastReportErrMsg = `HTTP ${resp.status} ${resp.statusText}`;
                    logWarn("asset-report-service", "failed", {
                        status: resp.status,
                        statusText: resp.statusText,
                    });
                    return;
                }

                lastReportAt = new Date().toISOString();
                lastReportErrMsg = "success";
                logDebug("asset-report-service", "success", {});
            } finally {
                clearTimeout(t);
            }

        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            lastReportAt = new Date().toISOString();
            lastReportErrMsg = errorMessage;
            logWarn("asset-report-service", "error", { error: errorMessage });
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
                    // 超时即放弃，不启动定时器（对齐 skill-scan-scheduler 策略）
                    logWarn("asset-report-service", "wait_timeout", {
                        message: "auth service not ready after 5min, service will not start",
                    });
                    return;
                }
                logDebug("asset-report-service", "waiting", {});
                await new Promise((resolve) => setTimeout(resolve, waitIntervalMs));
            }

            // auth-service 就绪后，先刷新缓存快照再上报
            // 关键生命周期节点：首次 auth 就绪（非高频，服务启动期仅一次）
            logInfo("asset-report-service", "auth_ready", {
                waitedMs: Date.now() - startTime,
            });
            await tryRefreshSnapshot();
            await reportOnce().catch(() => {});

            // 定时刷新资产数据缓存（30 分钟）
            cacheTimer = setInterval(() => tryRefreshSnapshot(), CLI_CACHE_REFRESH_INTERVAL_MS);
            cacheTimer.unref?.();

            // 定时上报
            timer = setInterval(() => reportOnce().catch(() => {}), intervalMs);
            timer.unref?.();

            // 关键生命周期节点：服务启动完成（非高频，仅启动时一次）
            logInfo("asset-report-service", "started", {
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
            // 关键生命周期节点：服务停止（非高频，仅停止时一次）
            logInfo("asset-report-service", "stopped", {});
        },
    };
}
