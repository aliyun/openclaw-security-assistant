/**
 * RunContext 生命周期管理
 *
 * 管理 Run 级上下文、Turn 计数器、LLM Call ID 关联、SubAgent 父信息。
 * 所有 Map 的 CRUD 操作均输出日志，便于测试和调试期间追踪状态变化。
 */

import { randomUUID } from "node:crypto";
import type { RunContext, ParentInfo, ReportMeta } from "./report-types.js";
import { logDebug, logWarn } from "./logger.js";

function isCronSessionKey(sessionKey: string): boolean {
    return sessionKey.includes(":cron:");
}

// ============================================================================
// 状态存储
// ============================================================================

/** 核心上下文，llm_input 创建（含 provider/model），agent_end 清理 */
const runContextMap = new Map<string, RunContext>();

/** wrappedFetch 中自增，标识当前 Run 内第几轮 LLM 调用 */
const turnCounterMap = new Map<string, number>();

/** wrappedFetch 中设置，用于 tool_call 阶段关联产生该 tool_call 的 LLM 调用 */
const lastLlmCallIdMap = new Map<string, string>();

/** subagent_spawned 写入，子 Agent 的 llm_input 消费 */
const parentInfoMap = new Map<string, ParentInfo>();

/** sessionKey → 当前活跃 runId 映射，用于 subagent_spawned 时查找父的真实 runId */
const sessionRunIdMap = new Map<string, string>();

/** sessionKey → trace_id 映射，Main Run 写入，Announce Run 读取 */
const sessionTraceMap = new Map<string, string>();

/**
 * sessionKey → pending 标记，由 before_dispatch hook 写入。
 * 仅用户消息触发 before_dispatch，Announce/SubAgent 不触发。
 * 以此区分 "新用户交互" 与 "Announce Run"，避免依赖 runId 命名约定。
 */
const pendingNewTraceMap = new Map<string, boolean>();

// ============================================================================
// RunContext CRUD
// ============================================================================

/**
 * 创建 RunContext 并存入 Map。
 * 自动消费 parentInfoMap 中的父信息（如存在）。
 */
export function createRunContext(params: {
    runId: string;
    sessionId: string;
    sessionKey: string;
    agentId: string;
    channelId: string;
    provider: string;
    model: string;
}): RunContext {
    const { runId, sessionId, sessionKey, agentId, channelId, provider, model } = params;

    // 消费子 Agent 的父信息
    const parentInfo = consumeParentInfo(sessionKey);

    // 根据 Run 类型确定 trace_id
    // 优先级：SubAgent 继承 > 用户发起（before_dispatch 标记）新建 > 其他（Announce 等）继承
    let traceId: string;
    let runType: "main" | "subagent" | "announce" | "cron";
    if (parentInfo?.traceId) {
        // SubAgent: 从父 Run 继承
        traceId = parentInfo.traceId;
        runType = "subagent";
    } else if (pendingNewTraceMap.delete(sessionKey)) {
        // Main Run: before_dispatch 已标记此 session 有新用户消息到达
        traceId = randomUUID();
        runType = "main";
    } else if (isCronSessionKey(sessionKey)) {
        // Cron Run: 无 announce 语义，每次触发均为独立 trace
        traceId = randomUUID();
        runType = "cron";
    } else {
        // Announce 或其他非用户发起的 Run: 继承 session 已有的 trace_id
        const existing = sessionTraceMap.get(sessionKey);
        runType = "announce";
        if (existing) {
            traceId = existing;
        } else {
            // 兜底：session 内无先前 trace（不应发生，但防御性处理）
            logWarn("run_context", "no_prior_trace_id", { runId, sessionKey });
            traceId = randomUUID();
        }
    }

    const ctx: RunContext = {
        session_id: sessionId,
        session_key: sessionKey,
        run_id: runId,
        agent_id: agentId,
        channel_id: channelId,
        provider,
        model,
        parent_session_key: parentInfo?.parentSessionKey,
        parent_run_id: parentInfo?.parentRunId,
        trace_id: traceId,
    };

    runContextMap.set(runId, ctx);
    sessionRunIdMap.set(sessionKey, runId);

    // sessionTraceMap 供后续 Announce Run 查找
    sessionTraceMap.set(sessionKey, traceId);

    logDebug("run_context", "created", {
        runId,
        sessionKey,
        provider,
        model,
        runType,
        traceId,
        hasParent: !!parentInfo,
        parentSessionKey: parentInfo?.parentSessionKey,
        parentRunId: parentInfo?.parentRunId,
        mapSize: runContextMap.size,
    });

    return ctx;
}

/**
 * 获取 RunContext。未命中时输出 warn 日志。
 */
export function getRunContext(runId: string): RunContext | undefined {
    const ctx = runContextMap.get(runId);
    if (!ctx) {
        logWarn("run_context", "not_found", { runId, mapSize: runContextMap.size });
    }
    return ctx;
}

/**
 * 静默检查 RunContext 是否存在（不产生 warn 日志）。
 * 用于延时兜底清理前判断上下文是否已被正常流程清理。
 */
export function hasRunContext(runId: string): boolean {
    return runContextMap.has(runId);
}

/**
 * 删除 RunContext（仅 cleanupRun 内部使用）。
 */
function deleteRunContext(runId: string): void {
    runContextMap.delete(runId);
}

// ============================================================================
// Turn 计数器
// ============================================================================

/**
 * 自增 Turn 计数器，返回 turn_id 数值（0, 1, ...）。
 */
export function nextTurn(runId: string): number {
    const current = turnCounterMap.get(runId) ?? 0;
    turnCounterMap.set(runId, current + 1);

    logDebug("run_context", "turn_incremented", { runId, turnId: current, nextValue: current + 1 });

    return current;
}

// ============================================================================
// LLM Call ID 关联
// ============================================================================

/**
 * 记录当前 Run 最近一次的 llm_call_id（供 tool_call 阶段关联）。
 */
export function setLastLlmCallId(runId: string, llmCallId: string): void {
    lastLlmCallIdMap.set(runId, llmCallId);
    logDebug("run_context", "llm_call_id_set", { runId, llmCallId });
}

/**
 * 获取当前 Run 最近一次的 llm_call_id。
 */
export function getLastLlmCallId(runId: string): string | undefined {
    const id = lastLlmCallIdMap.get(runId);
    logDebug("run_context", "llm_call_id_get", { runId, llmCallId: id ?? "none" });
    return id;
}

// ============================================================================
// Session → RunId 映射
// ============================================================================

/**
 * 通过 sessionKey 查找当前活跃的 runId。
 * 用于 subagent_spawned 时通过父 sessionKey 反查父的真实 runId。
 */
export function getRunIdBySessionKey(sessionKey: string): string | undefined {
    return sessionRunIdMap.get(sessionKey);
}

/**
 * 标记指定 session 即将开始新的用户交互。
 * 由 before_dispatch hook 调用（仅用户消息触发，Announce 不触发）。
 */
export function markNewTrace(sessionKey: string): void {
    pendingNewTraceMap.set(sessionKey, true);
    logDebug("run_context", "new_trace_marked", { sessionKey });
}

// ============================================================================
// SubAgent 父信息
// ============================================================================

/**
 * 记录子 Agent 的父信息（subagent_spawned 时调用）。
 */
export function setParentInfo(childSessionKey: string, info: ParentInfo): void {
    parentInfoMap.set(childSessionKey, info);
    logDebug("run_context", "parent_info_set", {
        childSessionKey,
        parentSessionKey: info.parentSessionKey,
        parentRunId: info.parentRunId,
    });
}

/**
 * 消费子 Agent 的父信息（子 llm_input 时调用，一次性消费）。
 */
export function consumeParentInfo(childSessionKey: string): ParentInfo | undefined {
    const info = parentInfoMap.get(childSessionKey);
    if (info) {
        parentInfoMap.delete(childSessionKey);
        logDebug("run_context", "parent_info_consumed", {
            childSessionKey,
            parentSessionKey: info.parentSessionKey,
            parentRunId: info.parentRunId,
        });
    }
    return info;
}

// ============================================================================
// 清理
// ============================================================================

/**
 * 清理与 runId 关联的所有状态（runContext、turnCounter、lastLlmCallId）。
 */
export function cleanupRun(runId: string): void {
    deleteRunContext(runId);
    turnCounterMap.delete(runId);
    lastLlmCallIdMap.delete(runId);

    logDebug("run_context", "cleaned_up", {
        runId,
        remainingContexts: runContextMap.size,
        remainingTurns: turnCounterMap.size,
        remainingLlmCallIds: lastLlmCallIdMap.size,
    });
}

/**
 * 清理与 sessionKey 关联的所有状态。
 * 应在 session_end hook 中调用。
 *
 * 清理范围：
 * - sessionRunIdMap、sessionTraceMap、pendingNewTraceMap：当前 session 自身的状态
 * - parentInfoMap：当前 session 作为子 Agent 时的父信息（key = childSessionKey）
 *   正常路径由 consumeParentInfo 一次性消费，此处为子 session 未正常启动时的兜底清理
 */
export function cleanupSession(sessionKey: string): void {
    // 必要：唯一清理点，createRunContext 写入，无其他删除路径
    sessionRunIdMap.delete(sessionKey);
    sessionTraceMap.delete(sessionKey);

    // 防御性：正常由 createRunContext 消费，此处兜底 before_dispatch 触发后 session 异常结束未创建 Run 的情形
    pendingNewTraceMap.delete(sessionKey);

    // 防御性：正常由 consumeParentInfo 一次性消费，此处兜底子 Agent spawn 后未触发 llm_input 的情形
    parentInfoMap.delete(sessionKey);

    logDebug("run_context", "session_cleaned_up", {
        sessionKey,
        remainingSessions: sessionRunIdMap.size,
        remainingTraces: sessionTraceMap.size,
    });
}

// ============================================================================
// Meta 构建 helper
// ============================================================================

/**
 * 从 RunContext 构建 ReportMeta（每次调用生成新的 event_time）。
 */
export function buildReportMeta(ctx: RunContext): ReportMeta {
    return {
        session_id: ctx.session_id,
        run_id: ctx.run_id,
        agent_id: ctx.agent_id,
        channel_id: ctx.channel_id,
        session_key: ctx.session_key,
        parent_session_key: ctx.parent_session_key,
        parent_run_id: ctx.parent_run_id,
        trace_id: ctx.trace_id,
        event_time: Date.now(),
    };
}

/**
 * RunContext 缺失时的兜底 meta：使用占位信息确保安全检测不被跳过。
 */
export function buildOrphanMeta(): ReportMeta {
    const orphanId = `orphan-${randomUUID()}`;
    return {
        session_id: "unknown",
        trace_id: orphanId,
        run_id: orphanId,
        agent_id: "unknown",
        channel_id: "unknown",
        session_key: "unknown",
        event_time: Date.now(),
    };
}
