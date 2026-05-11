/**
 * 资产信息上报类型定义
 *
 * 包含系统信息、Node 运行时信息、Provider/Model/Agent/Skill/Tool 等
 * 资产信息类型，用于 asset-report-service 定时上报。
 */

// ============================================================================
// System & Runtime
// ============================================================================

/** 系统信息 */
export type SystemInfo = {
    /** 操作系统平台：darwin | win32 | linux */
    platform: string;
    /** CPU 架构：arm64 | x64 */
    arch: string;
    /** 系统版本，如 ubuntu 22.04、macOS 14.0 */
    os_version?: string;
    /** 主机名 */
    hostname?: string;
    /** 主机 IP 地址 */
    ip?: string;
};

/** Node 运行时信息 */
export type NodeRuntimeInfo = {
    /** Node.js 版本，如 v22.22.0 */
    version: string;
    /** Node 可执行文件路径 */
    exec_path?: string;
};

// ============================================================================
// Gateway
// ============================================================================

/** Gateway 配置信息 */
export type GatewayInfo = {
    /** Gateway 端口，默认 18789 */
    port?: number;
    /** Gateway 模式：local | remote */
    mode?: "local" | "remote";
    /** Gateway 绑定模式：auto | lan | loopback | tailnet | custom */
    bind?: string;
};

// ============================================================================
// Provider & Model
// ============================================================================

/** 模型信息（排除敏感字段） */
export type ModelInfo = {
    /** 模型 ID，如 claude-opus-4-6 */
    id: string;
    /** 模型显示名称 */
    name?: string;
    /** API 类型 */
    api?: string;
    /** 是否支持推理模式 */
    reasoning?: boolean;
    /** 输入类型：text | image */
    input?: Array<"text" | "image">;
    /** 上下文窗口大小 */
    contextWindow?: number;
    /** 最大输出 token 数 */
    maxTokens?: number;
};

/** Provider 信息（排除敏感字段：apiKey, headers, auth） */
export type ProviderInfo = {
    /** Provider ID，如 anthropic, openai, google */
    id: string;
    /** Provider API 基础地址 */
    baseUrl?: string;
    /** API 类型 */
    api?: string;
    /** 该 Provider 下的模型列表 */
    models?: ModelInfo[];
};

// ============================================================================
// Agent
// ============================================================================

/** Agent 模型配置 */
export type AgentModelsInfo = {
    /** 该 agent 可用的模型 ID 列表（格式：provider/model） */
    available?: string[];
    /** 主模型（格式：provider/model） */
    primary?: string;
    /** 备选模型列表 */
    fallbacks?: string[];
};

/** Agent 信息 */
export type AgentInfo = {
    /** Agent ID */
    id: string;
    /** Agent 显示名称 */
    name?: string;
    /** 是否为默认 agent */
    isDefault?: boolean;
    /** Agent 工作目录 */
    workspace?: string;
    /** Agent 配置目录 */
    agentDir?: string;
    /** Agent 模型配置 */
    models?: AgentModelsInfo;
    /** Agent 实际可用的 skill ID 列表（全局 eligible ∩ agent 级 skills 白名单；格式：source/name） */
    skills?: string[];
    /** Agent 可用的 tool ID 列表（格式：core/<name> 或 plugin:<id>/<name>） */
    tools?: string[];
};

// ============================================================================
// Skill & Tool
// ============================================================================

/**
 * Skill 信息（SLS-only 对齐，仅保留 APS SLS 投递必需字段）
 *
 * APS 消费路径：
 * - SLS：`extractAssetNames` 仅读 `name` 写入 asset.log
 * - DB：`saveHeartbeatData` → `instance_skills` 写入 `description` / `source`
 *   （eligible/disabled 列在本版本留空，不再下发；按后台报表使用场景可接受）
 */
export type SkillInfo = {
    /** Skill 名称 */
    name: string;
    /** Skill 描述（供 instance_skills.description 展示） */
    description?: string;
    /** Skill 来源（供 instance_skills.source 分类，如 `openclaw-bundled` / `unknown`） */
    source?: string;
};

/** Tool 信息 */
export type ToolInfo = {
    /** Tool 名称 */
    name: string;
    /** Tool 来源：core 或 plugin:<id> */
    source: string;
};

// ============================================================================
// OpenClaw Runtime
// ============================================================================

/** OpenClaw 运行时信息 */
export type OpenClawInfo = {
    /** OpenClaw 版本号，如 2026.3.12 */
    version: string;
    /** Gateway 配置信息 */
    gateway?: GatewayInfo;
    /** 配置的 Provider 列表 */
    providers?: ProviderInfo[];
    /** Eligible Skills 列表（来自 openclaw skills list --eligible --json） */
    skills?: SkillInfo[];
    /** 可用的 Tools 列表 */
    tools?: ToolInfo[];
    /** 配置的 Agent 列表 */
    agents?: AgentInfo[];
};

// ============================================================================
// Asset Report Payload
// ============================================================================

/** 资产信息上报请求 Payload */
export type AssetReportPayload = {
    /** Agent 唯一标识 */
    agent_id: string;
    /** 系统信息 */
    system: SystemInfo;
    /** Node 运行时信息 */
    node_runtime: NodeRuntimeInfo;
    /** OpenClaw 运行时信息 */
    openclaw?: OpenClawInfo;
};
