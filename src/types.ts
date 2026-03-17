/**
 * openclaw-security-assistant 插件类型定义
 */

/** 安全检查处置动作 */
export type SecurityAction = "pass" | "block" | "hint";

/** 请求类型枚举 */
export type ReqType = "llm" | "tool_call";

/** 数据流向 */
export type Direction = "req" | "resp";

/** Provider 匹配结果 */
export type ProviderMatch = {
    providerId: string;
    baseUrl: string;
};

/** Provider 配置缓存 */
export type ProviderCache = {
    lastTouchedAt: string | undefined;
    providers: ProviderMatch[];
};

/** LLM Payload 结构 */
export type LlmPayload = {
    /** 目标 LLM API 地址 */
    url: string;
    /** HTTP 方法（仅请求方向需要） */
    method?: string;
    /** 原始 HTTP Headers（过滤 Authorization 等敏感头） */
    headers: Record<string, string>;
    /** 请求/响应体内容 */
    body: string;
};

/** Tool Call Payload 结构 */
export type ToolCallPayload = {
    /** 工具名称 */
    name: string;
    /** 工具参数 */
    parameters?: Record<string, unknown>;
    /** 执行结果（仅响应方向） */
    result?: unknown;
    /** 错误信息（仅响应方向） */
    error?: string;
};

/** 安全检查请求 Payload */
export type SecurityCheckRequest = {
    /** 请求类型枚举 */
    req_type: ReqType;
    /** Agent 会话 ID */
    agent_session_id: string;
    /** 本次调用唯一 ID */
    llm_run_id: string;
    /** LLM 请求/响应内容（当 req_type 为 llm 时必填） */
    llm_payload?: LlmPayload;
    /** Tool Call 请求/响应内容（当 req_type 为 tool_call 时必填） */
    tool_payload?: ToolCallPayload;
};

/** 安全检查错误信息 */
export type SecurityCheckError = {
    /** 错误码 */
    code: string;
    /** 错误描述 */
    message: string;
};

/** 安全检查响应 Payload */
export type SecurityCheckResponse = {
    /** 请求唯一标识 */
    request_id: string;
    /** 处置动作 */
    action?: SecurityAction;
    /** 替换/追加内容（block 或 hint 时生效） */
    content?: string;
    /** 错误信息（失败时返回） */
    error?: SecurityCheckError;
};

/** 安全检查请求上下文 */
export type CheckRequestContext = {
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyText: string;
};

/** 安全检查响应上下文 */
export type CheckResponseContext = {
    url: string;
    method: string;
    status: number;
    headers: Record<string, string>;
    respText: string;
};

/** Tool Call 请求上下文 */
export type CheckToolCallRequestContext = {
    /** 工具名称 */
    name: string;
    /** 工具参数 */
    parameters?: Record<string, unknown>;
};

/** Tool Call 响应上下文 */
export type CheckToolCallResponseContext = {
    /** 工具名称 */
    name: string;
    /** 工具参数 */
    parameters?: Record<string, unknown>;
    /** 执行结果 */
    result?: unknown;
    /** 错误信息 */
    error?: string;
};

// ============================================================================
// Asset Report Types
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

/** Gateway 配置信息 */
export type GatewayInfo = {
    /** Gateway 端口，默认 18789 */
    port?: number;
    /** Gateway 模式：local | remote */
    mode?: "local" | "remote";
    /** Gateway 绑定模式：auto | lan | loopback | tailnet | custom */
    bind?: string;
};

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
    /** Agent 可用的 skill ID 列表（格式：source/name） */
    skills?: string[];
    /** Agent 可用的 tool ID 列表（格式：core/<name> 或 plugin:<id>/<name>） */
    tools?: string[];
};

// ============================================================================
// Skill Types（与 OpenClaw CLI --json 输出对齐）
// ============================================================================

/** Skill 缺失的依赖要求 */
export type SkillMissing = {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
    os?: string[];
};

/**
 * Skill 信息（与 openclaw skills list --eligible --json 输出对齐）
 *
 * 来源：openclaw skills list --eligible --json
 */
export type SkillInfo = {
    /** Skill 名称 */
    name: string;
    /** Skill 描述 */
    description?: string;
    /** Skill emoji */
    emoji?: string;
    /** 是否可用（已通过所有检查） */
    eligible?: boolean;
    /** 是否被禁用 */
    disabled?: boolean;
    /** 是否被 allowlist 阻止 */
    blockedByAllowlist?: boolean;
    /** Skill 来源 */
    source?: string;
    /** 是否为内置 skill */
    bundled?: boolean;
    /** 主要环境变量 */
    primaryEnv?: string;
    /** 主页地址 */
    homepage?: string;
    /** 缺失的依赖 */
    missing?: SkillMissing;
};

/** Tool 信息 */
export type ToolInfo = {
    /** Tool 名称 */
    name: string;
    /** Tool 来源：core 或 plugin:<id> */
    source: string;
};

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
