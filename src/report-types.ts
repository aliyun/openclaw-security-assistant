/**
 * Agent 上报协议类型定义
 *
 * 以 runId 为粒度建模，plugin 在阶段入口采集信息上报给 APS，
 * APS 根据信息中的关联 ID 串联整个 Loop 的运行状态。
 *
 * 本文件是上报协议的唯一类型来源，包含：
 * - 共享原语（SecurityAction、SecurityCheckError）
 * - 数据载体（LlmPayload、ToolCallPayload）
 * - 协议阶段 + Meta + 各阶段 Payload
 * - 统一上报结构 + APS 响应
 * - 内部状态类型（RunContext、ParentInfo）
 */

// ============================================================================
// 共享原语
// ============================================================================

/** 安全检查处置动作 */
export type SecurityAction = "allow" | "block" | "hint";

/** 安全检查错误信息 */
export type SecurityCheckError = {
    /** 错误码 */
    code: string;
    /** 错误描述 */
    message: string;
};

// ============================================================================
// 数据载体
// ============================================================================

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
    /** LLM 请求阶段的检测 action，仅响应方向需要（APS 用于关联 req/resp 两阶段检测结果） */
    req_action?: string;
};

/** Tool Call Payload 结构 */
export type ToolCallPayload = {
    /** 检测类型：tool 或 skill */
    check_type: "tool" | "skill";
    /** 工具名称 */
    name: string;
    /** 工具参数 */
    parameters?: Record<string, unknown>;
    /** 执行结果（仅响应方向） */
    result?: unknown;
    /** 错误信息（仅响应方向） */
    error?: string;
    /** 工具执行耗时（毫秒，仅响应方向） */
    duration_ms?: number;
    /** Skill ZIP 的 SHA256（仅 check_type = "skill" 时填充） */
    skill_sha256?: string;
    /** Skill 名称（仅 check_type = "skill" 时填充，辅助 APS 展示） */
    skill_name?: string;
};

// ============================================================================
// 协议阶段
// ============================================================================

/** 上报协议阶段 */
export type ReportPhase =
    | "run_start"
    | "before_llm_call"
    | "after_llm_call"
    | "before_tool_call"
    | "after_tool_call"
    | "run_end";

// ============================================================================
// Meta: Run 级恒定标识
// ============================================================================

/** 所有上报请求共享的关联标识，在一个 Run 生命周期内保持恒定 */
export type ReportMeta = {
    /** 会话 ID（ephemeral，/new 或 /reset 后重新生成） */
    session_id: string;
    /** Trace ID：标识一次完整用户交互（message_received → message_sent）中所有 Run 的关联 ID */
    trace_id: string;
    /** 本次 Run 唯一标识 */
    run_id: string;
    /** Agent 标识 */
    agent_id: string;
    /** 通道标识，如 "telegram"、"discord" */
    channel_id: string;
    /** 会话路由键，如 "agent:main:telegram:alice" */
    session_key: string;
    /** 父 Agent 的 sessionKey（仅 sub-agent 有值） */
    parent_session_key?: string;
    /** 父 Agent 的 runId（仅 sub-agent 有值） */
    parent_run_id?: string;
    /** 事件发生的时间戳（ms） */
    event_time: number;
};

// ============================================================================
// 各阶段 Payload
// ============================================================================

/** run_start 阶段 */
export type RunStartPayload = {
    /** Agent 接收到的输入内容（用户输入的 channel-message） */
    content: string;
};

/** before_llm_call 阶段 */
export type BeforeLlmCallPayload = {
    /** 本次 LLM HTTP 调用 UUID */
    llm_call_id: string;
    /** 当前 Run 内第几轮 LLM 调用（从 0 开始，插件自增） */
    turn_id: number;
    /** LLM Provider 标识（如 "openai"、"anthropic"） */
    provider: string;
    /** 模型 ID（如 "gpt-4o"） */
    model: string;
    /** LLM 的送检 Payload 内容 */
    llm_payload: LlmPayload;
};

/** after_llm_call 阶段 */
export type AfterLlmCallPayload = {
    /** 本次 LLM HTTP 调用 UUID */
    llm_call_id: string;
    /** 当前 Run 内第几轮 LLM 调用（从 0 开始，插件自增） */
    turn_id: number;
    /** LLM Provider 标识 */
    provider: string;
    /** 模型 ID */
    model: string;
    /** LLM 的送检 Payload 内容 */
    llm_payload: LlmPayload;
};

/** before_tool_call 阶段 */
export type BeforeToolCallPayload = {
    /** 产生此 tool_call 的 LLM 调用 ID */
    llm_call_id: string;
    /** 本次 ToolCall 的唯一标识 */
    tool_call_id: string;
    /** Tool 调用送检 Payload 内容 */
    tool_payload: ToolCallPayload;
};

/** after_tool_call 阶段 */
export type AfterToolCallPayload = {
    /** 产生此 tool_call 的 LLM 调用 ID */
    llm_call_id: string;
    /** 本次 ToolCall 的唯一标识 */
    tool_call_id: string;
    /** Tool 调用送检 Payload 内容 */
    tool_payload: ToolCallPayload;
};

/** run_end 阶段 */
export type RunEndPayload = {
    /** Agent 输出的内容（输出给用户的 channel-message） */
    content: string;
};

/** 各阶段 Payload 联合类型 */
export type ReportPayload =
    | RunStartPayload
    | BeforeLlmCallPayload
    | AfterLlmCallPayload
    | BeforeToolCallPayload
    | AfterToolCallPayload
    | RunEndPayload;

// ============================================================================
// 统一上报结构
// ============================================================================

/** 上报请求统一结构 */
export type Report = {
    /** 上报阶段 */
    phase: ReportPhase;
    /** Run 级固定标识 */
    meta: ReportMeta;
    /** 阶段特定数据 */
    payload: ReportPayload;
    /** 上报时间戳（ms） */
    timestamp: number;
};

// ============================================================================
// APS 响应
// ============================================================================

/**
 * APS 构建好的完整替换响应体
 *
 * 当 action != "allow" 时，APS 根据 LLM 协议构建好的最终响应数据。
 * SDK 直接使用 body + headers 构造 HTTP Response，无需感知具体 LLM 协议格式。
 */
export type ReplacementPayload = {
    /** SDK 需注入到 Response 的 HTTP Headers */
    headers: Record<string, string>;
    /** 完整响应体（SSE 事件流或 JSON 字符串） */
    body: string;
};

/** APS 检查响应（before_llm_call / after_llm_call / before_tool_call / after_tool_call） */
export type ReportCheckResponse = {
    /** 请求唯一标识 */
    request_id: string;
    /** 处置动作 */
    action?: SecurityAction;
    /** 纯文本内容（日志/审计 + 本地拼装兜底） */
    content?: string;
    /** APS 构建好的完整替换响应体（action != "allow" 时由 APS 返回；SDK 优先使用，失败回退 content 本地拼装） */
    payload?: ReplacementPayload;
    /** 错误信息（失败时返回） */
    error?: SecurityCheckError;
};

// ============================================================================
// 内部状态类型
// ============================================================================

/** Run 级上下文，llm_input 时创建，agent_end 时清理 */
export type RunContext = {
    /** 会话 ID */
    session_id: string;
    /** 会话路由键 */
    session_key: string;
    /** 本次 Run 唯一标识 */
    run_id: string;
    /** Agent 标识 */
    agent_id: string;
    /** 通道标识 */
    channel_id: string;
    /** LLM Provider 标识（来自 llm_input.event.provider） */
    provider: string;
    /** 模型 ID（来自 llm_input.event.model） */
    model: string;
    /** 父 Agent 的 sessionKey（仅 sub-agent 有值） */
    parent_session_key?: string;
    /** 父 Agent 的 runId（仅 sub-agent 有值） */
    parent_run_id?: string;
    /** Trace ID：标识一次完整用户交互中所有 Run */
    trace_id: string;
};

/** 子 Agent 父信息（subagent_spawned 写入，子 llm_input 消费） */
export type ParentInfo = {
    parentSessionKey: string;
    parentRunId: string;
    /** 从父 Run 继承的 Trace ID */
    traceId?: string;
};
