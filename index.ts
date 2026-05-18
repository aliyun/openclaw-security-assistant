import path from "node:path";
import { randomUUID } from "node:crypto";
import type {OpenClawPluginApi} from "openclaw/plugin-sdk";
import {
    createOpenClawSecurityAssistantConfigSchema,
    resolveOpenClawSecurityAssistantConfig,
    SDK_VERSION,
} from "./src/config.js";
import {createAssetReportService, getLastAssetReportAt, getLastAssetReportErrMsg} from "./src/asset-report-service.js";
import {createAuthService, isAuthServiceReady, getJwtPayload, getAuthErrMsg} from "./src/auth-service.js";
import {createConfigSyncService} from "./src/config-sync-service.js";
import {createIdaasConfigDelegate, createIdaasService} from "./src/idaas/idaas-coordinator.js";
import {initializeRuntimeContext, getRuntimeContext} from "./src/runtime.js";
import type {ProviderMatch} from "./src/check.js";
import type {SecurityAction, ReplacementPayload, BeforeToolCallPayload, RunContext} from "./src/report-types.js";
import {
    OC_SEC_MARKER_PREFIX,
    OC_SEC_MARKER_SUFFIX,
    OC_SEC_MARKER_REGEX,
    OC_SEC_MARKER_GLOBAL_REGEX,
    encodeOcSecPayload,
    decodeOcSecPayload,
} from "./src/oc-sec.js";
import {
    getProviderBaseUrls,
    matchProviderByUrl,
    filterSensitiveHeaders,
    reportRunStart,
    reportRunEnd,
    checkBeforeLlmCall,
    checkAfterLlmCall,
    checkBeforeToolCall,
    checkAfterToolCall,
} from "./src/check.js";
import {
    getMergedRequestHeaders,
    getMethodFromFetchArgs,
    getRequestBodyText,
    getUrlFromFetchArgs,
    headersToRecord,
    isSseResponse,
} from "./src/fetch-utils.js";
import {
    buildResponseFromAps,
    createSecurityResponse,
    guessRequestWantsSse,
} from "./src/response.js";
import {
    initLogger,
    logInfo,
    logWarn,
    logError,
    logDebug,
} from "./src/logger.js";
import {
    createRunContext,
    getRunContext,
    hasRunContext,
    nextTurn,
    setLastLlmCallId,
    getLastLlmCallId,
    setParentInfo,
    getRunIdBySessionKey,
    markNewTrace,
    cleanupRun,
    cleanupSession,
    buildReportMeta,
} from "./src/run-context.js";
import { SkillScanScheduler } from "./src/skill-scanner/skill-scan-scheduler.js";
import { createSkillMdGuard } from "./src/skill-guard/skill-md-guard.js";
import { initStatusCollector } from "./src/status/collector.js";
import { registerStatusRoutes, registerStatusCommands } from "./src/status/routes.js";
import { registerSecurityAssistantCli } from "./src/status/cli.js";

// Body preview truncation limit for debug logs
const BODY_PREVIEW_MAX_LENGTH = 500;

// 防止 fetch 重复包装的全局标记
const FETCH_WRAPPED_KEY = Symbol.for('openclaw-security-assistant.fetch-wrapped');
// 缓存插件加载前的原始 fetch，确保所有内部调用（service、hook）都使用未被包装的 fetch
const ORIGINAL_FETCH_KEY = Symbol.for('openclaw-security-assistant.original-fetch');

// 模块级持久变量：跨 register() 调用保持存活，避免 gateway restart 触发的
// 重新注册导致 hook 闭包引用新的 null 变量而 service.start() 尚未被框架调度
let skillScanScheduler: SkillScanScheduler | null = null;
let skillMdGuard: ReturnType<typeof createSkillMdGuard> | null = null;

const plugin = {
    id: "openclaw-security-assistant",
    name: "@alicloud/openclaw-security-assistant",
    configSchema: createOpenClawSecurityAssistantConfigSchema(),
    description: "Security assistant plugin by Alibaba Cloud that provides LLM request/response protection, tool call security checks.",
    register(api: OpenClawPluginApi) {
        // cli-metadata 注册模式下，框架仅收集 CLI 命令元数据，
        // 注入的 runtime 为空对象（见 loader.ts `registrationMode: "cli-metadata"` 分支），
        // 此阶段禁止访问 api.runtime.state / 注册 service / 包装 fetch。
        // 此处提前注册 `ali-osa` 命令组，确保 `openclaw ali-osa ...` 能命中 owner 插件。
        api.registerCli(
            ({ program, config: cliConfig }) => {
                registerSecurityAssistantCli(program, cliConfig);
            },
            {
                descriptors: [{
                    name: "ali-osa",
                    description: "Alibaba Cloud OpenClaw Security Assistant status and diagnostics",
                    hasSubcommands: true,
                }],
            },
        );
        if (api.registrationMode === "cli-metadata") {
            return;
        }

        // 获取插件目录
        const pluginDir = path.dirname(api.source);

        // 初始化运行时上下文（包含 machineId、installKey、系统信息等）
        const runtimeCtx = initializeRuntimeContext(api.runtime, api.config, pluginDir);

        // 读取并解析配置
        const config = resolveOpenClawSecurityAssistantConfig(api.pluginConfig);

        // 初始化日志器（只初始化一次）
        initLogger(api.logger, config.debug);

        logDebug("init", "register", {
            source: api.source,
            pluginDir,
            openclaw: runtimeCtx.openclaw.version,
            machineId: runtimeCtx.machineId,
            installKey: runtimeCtx.installKey ? "loaded" : "missing",
            protectServerAddr: config.protectServerAddr,
            managementServerAddr: config.managementServerAddr,
            debug: config.debug,
        });

        // 在首次加载时缓存原始 fetch，后续重入注册都复用这份未包装的 fetch
        if (!(globalThis as any)[ORIGINAL_FETCH_KEY] && globalThis.fetch) {
            (globalThis as any)[ORIGINAL_FETCH_KEY] = globalThis.fetch;
        }
        const originalFetch: typeof globalThis.fetch | undefined = (globalThis as any)[ORIGINAL_FETCH_KEY];

        if (!originalFetch) {
            logError("init", "fetch_unavailable", { message: "globalThis.fetch is not available" });
            return;
        }

        // 捕获配置用于闭包
        const protectServerAddr = config.protectServerAddr;
        const managementServerAddr = config.managementServerAddr;

        // 0) 注册认证服务：启动时获取 access_token，定时刷新
        api.registerService(
            createAuthService({
                api,
                originalFetch,
                pluginDir,
                config: {
                    managementServerAddr,
                },
            }),
        );

        // 1) 注册配置同步服务：定时从 APS 拉取最新配置
        api.registerService(
            createConfigSyncService({
                api,
                originalFetch,
                protectServerAddr,
                delegates: [createIdaasConfigDelegate({ api, originalFetch })],
            }),
        );

        // 2) 注册资产信息上报 service：定时上报系统资产信息
        api.registerService(
            createAssetReportService({
                api,
                originalFetch,
                protectServerAddr,
                intervalMs: 600_000, // 10min上传一次
                timeoutMs: 30_000, // 超时30s
            }),
        );

        // 3) 注册 Skill 安全扫描调度器：定时扫描 skill 变更，上报待检测文件
        api.registerService({
            id: "skill-scan-scheduler",
            start(ctx) {
                skillScanScheduler = new SkillScanScheduler({
                    stateDir: ctx.stateDir,
                    fetch: originalFetch,
                    apiBaseUrl: protectServerAddr,
                    openclawConfig: ctx.config,
                });
                skillScanScheduler.start();

                // 创建 Guard（依赖 Scheduler 的 fingerprintStore）
                skillMdGuard = createSkillMdGuard({
                    fingerprintStore: skillScanScheduler.fingerprintStore,
                    protectServerAddr,
                    originalFetch,
                });

                logDebug("init", "skill_scan_scheduler_started", {
                    stateDir: ctx.stateDir,
                    apiBaseUrl: protectServerAddr,
                });
            },
            stop() {
                skillScanScheduler?.stop();
                skillScanScheduler = null;
                skillMdGuard = null;
            },
        });

        // 3.5) 注册统一 IdaaS service：初始化 access-token + hosting 模块，实际启停由 coordinator 控制
        api.registerService(
            createIdaasService({
                api,
                config: { scanIntervalMs: 600_000 },
            }),
        );

        // 检查 fetch 是否已被包装 - 防止重复加载
        const alreadyWrapped = (globalThis as any)[FETCH_WRAPPED_KEY];
        if (alreadyWrapped) {
            logDebug("init", "skip_double_wrap", {});
        } else {
            // 用于追踪请求的计数器
            let fetchCallId = 0;

            const wrappedFetch: typeof globalThis.fetch = (async function wrappedFetch(
                input: RequestInfo | URL,
                init?: RequestInit,
            ): Promise<Response> {
                const callId = ++fetchCallId;
                const url = getUrlFromFetchArgs(input);

                // 1) 动态获取 provider baseUrl 列表并检查是否匹配
                // 使用 runtime.config.loadConfig() 获取最新配置快照，
                // 确保 provider 热更新后 wrappedFetch 能感知新的 baseUrl 列表。
                // api.config 是插件加载时的静态快照，热更新后不会自动更新。
                const liveConfig = api.runtime.config?.loadConfig?.() ?? api.config;
                const providerUrls = getProviderBaseUrls(liveConfig);
                const matchedProvider = matchProviderByUrl(url, providerUrls);

                // 未匹配任何 provider baseUrl，直接放行
                if (!matchedProvider) {
                    return originalFetch(input as any, init);
                }

                const method = getMethodFromFetchArgs(input, init);
                const reqHeaders = getMergedRequestHeaders(input, init);
                const reqBodyText = await getRequestBodyText(input, init);

                // ---- oc-sec 元数据提取 + 摘除 ----
                let cleanBodyText = reqBodyText;
                let ocSecSid: string | undefined;
                let ocSecRid: string | undefined;

                if (reqBodyText) {
                    const markerMatch = reqBodyText.match(OC_SEC_MARKER_REGEX);
                    if (markerMatch?.[1]) {
                        // base64 decode the entire payload (sid=xx&rid=yy)
                        const decoded = decodeOcSecPayload(markerMatch[1]);
                        if (decoded) {
                            ocSecSid = decoded.sid;
                            ocSecRid = decoded.rid;
                        }
                        // strip markers from body
                        cleanBodyText = reqBodyText.replace(OC_SEC_MARKER_GLOBAL_REGEX, "");

                        logInfo("oc-sec", "extract", {
                            callId,
                            sid: ocSecSid,
                            rid: ocSecRid,
                            provider: matchedProvider.providerId,
                            url,
                            originalBodyLen: reqBodyText.length,
                            cleanBodyLen: cleanBodyText.length,
                        });
                    } else {
                        logDebug("oc-sec", "no_marker_found", { callId, provider: matchedProvider.providerId });
                    }
                }

                logDebug("llm", "request", {
                    callId,
                    url,
                    provider: matchedProvider.providerId,
                    method,
                    headerKeys: Object.keys(reqHeaders),
                    bodyPreview: reqBodyText?.slice(0, BODY_PREVIEW_MAX_LENGTH),
                });

                // 聚合检测前置条件：fetch 流程中不会变化，统一判断一次
                // 优先通过 rid 直接查找 RunContext (>= v2026.3.28)
                let runCtx: RunContext | undefined;
                if (ocSecRid && ocSecRid !== "unknown") {
                    runCtx = getRunContext(ocSecRid);
                }
                // 兜底通过 sid(sessionKey) 调用 getRunIdBySessionKey 回查 (<= v2026.3.24)
                if (!runCtx && ocSecSid && ocSecSid !== "unknown") {
                    const realRunId = getRunIdBySessionKey(ocSecSid);
                    if (realRunId) {
                        runCtx = getRunContext(realRunId);
                    }
                }
                const traceCtx = runCtx
                    ? {
                        runCtx,
                        rid: runCtx.run_id,
                        llmCallId: randomUUID(),
                        turnId: nextTurn(runCtx.run_id),
                    }
                    : undefined;

                if (traceCtx) {
                    setLastLlmCallId(traceCtx.rid, traceCtx.llmCallId);
                } else {
                    logError("llm", "run_context_missing", {
                        callId,
                        url,
                        provider: matchedProvider.providerId,
                        sid: ocSecSid,
                        rid: ocSecRid,
                    });
                }

                let reqAction: SecurityAction = "allow";
                let reqContent: string | undefined;
                let reqPayload: ReplacementPayload | undefined;
                if (traceCtx) {
                    try {
                        const checkStart = Date.now();
                        const meta = buildReportMeta(traceCtx.runCtx);
                        const result = await checkBeforeLlmCall(meta, {
                            llm_call_id: traceCtx.llmCallId,
                            turn_id: traceCtx.turnId,
                            provider: traceCtx.runCtx.provider,
                            model: traceCtx.runCtx.model,
                            llm_payload: {
                                url,
                                method,
                                headers: filterSensitiveHeaders(reqHeaders),
                                body: cleanBodyText,
                            },
                        }, protectServerAddr, originalFetch);
                        reqAction = result.action;
                        reqContent = result.content;
                        reqPayload = result.payload;
                        const checkDurationMs = Date.now() - checkStart;
                        if (reqAction !== "allow") {
                            logInfo("llm", "request_check", {callId, action: reqAction, url, provider: matchedProvider.providerId, checkDurationMs});
                        }
                    } catch (e: unknown) {
                        logWarn("llm", "request_check_failed", {
                            callId,
                            url,
                            provider: matchedProvider.providerId,
                            error: String(e instanceof Error ? e.message : e),
                        });
                        reqAction = "allow";
                    }
                }

                const wantsSse = guessRequestWantsSse(url, reqHeaders, reqBodyText);

                if (reqAction === "block") {
                    logInfo("llm", "request_blocked", {
                        callId,
                        url,
                        provider: matchedProvider.providerId,
                        streaming: wantsSse,
                    });

                    // 优先使用 APS 预组装的响应
                    if (reqPayload) {
                        return buildResponseFromAps(reqPayload);
                    }
                    // 兜底：APS 未返回 responseBody，使用本地拼装
                    const blockContent = reqContent ?? "当前提示词请求存在安全风险，已被安全组件拦截";
                    return createSecurityResponse(reqAction, blockContent, {
                        isRequest: true,
                        wantsSse,
                    })!;
                }

                // do fetch — 使用摘除 oc-sec 标记后的干净 body
                // oc-sec 摘除后 LLM API 收到的是不含元数据的干净 prompt
                let resp: Response;
                const fetchStartTime = Date.now();
                try {
                    const bodyWasStripped = cleanBodyText !== reqBodyText && cleanBodyText !== undefined;
                    if (bodyWasStripped) {
                        logInfo("oc-sec", "body_stripped", {
                            callId,
                            provider: matchedProvider.providerId,
                            originalLen: reqBodyText?.length ?? 0,
                            cleanLen: cleanBodyText.length,
                        });
                        // 根据原始 fetch 参数结构决定如何替换 body
                        if (init) {
                            // init 存在：用干净 body 替换 init.body
                            const cleanInit = { ...init, body: cleanBodyText };
                            resp = await originalFetch(input as any, cleanInit as RequestInit);
                        } else if (input instanceof Request) {
                            // input 是 Request 对象且无 init：重建 Request
                            const cleanReq = new Request(input, { body: cleanBodyText });
                            resp = await originalFetch(cleanReq);
                        } else {
                            // 无法替换 body 的场景（string/URL input + 无 init），直接透传
                            resp = await originalFetch(input as any, init);
                        }
                    } else {
                        resp = await originalFetch(input as any, init);
                    }
                } catch (e: unknown) {
                    logError("fetch", "error", {
                        callId,
                        url,
                        provider: matchedProvider.providerId,
                        error: String(e instanceof Error ? e.message : e),
                        durationMs: Date.now() - fetchStartTime,
                    });
                    throw e;
                }

                const respHeaders = headersToRecord(resp.headers);
                const sse = isSseResponse(resp);

                // clone body for check (NOTE: for SSE this reads full stream; ok for initial testing)
                let respBodyForCheck = "";
                try {
                    respBodyForCheck = await resp.clone().text();
                } catch {
                    respBodyForCheck = "[unreadable response body]";
                }

                logDebug("llm", "response", {
                    callId,
                    url,
                    provider: matchedProvider.providerId,
                    status: resp.status,
                    sse,
                    durationMs: Date.now() - fetchStartTime,
                    bodyPreview: respBodyForCheck.slice(0, BODY_PREVIEW_MAX_LENGTH),
                });

                let respAction: SecurityAction = "allow";
                let respContent: string | undefined;
                let respPayload: ReplacementPayload | undefined;
                if (traceCtx) {
                    try {
                        const checkStart = Date.now();
                        const meta = buildReportMeta(traceCtx.runCtx);
                        const result = await checkAfterLlmCall(meta, {
                            llm_call_id: traceCtx.llmCallId,
                            turn_id: traceCtx.turnId,
                            provider: traceCtx.runCtx.provider,
                            model: traceCtx.runCtx.model,
                            llm_payload: {
                                url,
                                headers: filterSensitiveHeaders(respHeaders),
                                body: respBodyForCheck,
                                req_action: reqAction,
                            },
                        }, protectServerAddr, originalFetch);
                        respAction = result.action;
                        respContent = result.content;
                        respPayload = result.payload;
                        const checkDurationMs = Date.now() - checkStart;
                        if (respAction !== "allow") {
                            logInfo("llm", "response_check", {callId, action: respAction, url, provider: matchedProvider.providerId, checkDurationMs});
                        }
                    } catch (e: unknown) {
                        logWarn("llm", "response_check_failed", {
                            callId,
                            url,
                            provider: matchedProvider.providerId,
                            status: resp.status,
                            error: String(e instanceof Error ? e.message : e),
                        });
                        respAction = "allow";
                    }
                }

                // hint OR 逻辑：请求或响应任一为 hint/block 时生效
                // 优先级：block > hint > allow
                // 1. respAction=block → block（响应 block 内容）
                // 2. respAction=hint → hint（响应 hint 内容）
                // 3. reqAction=hint + respAction=allow → hint（请求 hint 内容）
                const effectiveAction: SecurityAction =
                    respAction === "block" ? "block"
                    : respAction === "hint" ? "hint"
                    : reqAction === "hint" ? "hint"
                    : "allow";

                if (effectiveAction === "block" || effectiveAction === "hint") {
                    // 根据来源选择内容
                    let content: string;
                    let logAction: string;

                    if (effectiveAction === "block") {
                        content = respContent ?? "当前大模型响应存在安全风险，已被安全组件拦截";
                        logAction = "response_blocked";
                    } else if (respAction === "hint") {
                        content = respContent ?? "\n\n[安全提示：以上内容由模型生成，请注意甄别其中的外部链接。]";
                        logAction = "response_hint";
                    } else {
                        content = reqContent ?? "\n\n[安全提示：以上内容由模型生成，请注意甄别其中的外部链接。]";
                        logAction = "request_hint_applied";
                    }

                    logInfo("llm", logAction, {
                        callId,
                        url,
                        provider: matchedProvider.providerId,
                        status: resp.status,
                        streaming: sse,
                    });

                    // 优先使用 APS 预组装的响应：
                    //   - respAction=block/hint 时 respPayload 为 APS 基于真实 LLM 响应构建的完整替换体
                    //   - respAction=allow 但 reqAction=hint 时（请求阶段提示延迟到响应阶段应用），
                    //     APS 在请求阶段无法预知真实响应内容，无法提供 payload，必须走本地拼装
                    if (respAction !== "allow" && respPayload) {
                        return buildResponseFromAps(respPayload);
                    }

                    // 兜底：APS 未返回 payload，使用本地拼装（覆盖 reqAction=hint + respAction=allow 场景）
                    const securityResp = createSecurityResponse(effectiveAction, content, {
                        isRequest: false,
                        wantsSse: sse,
                        originalResponse: resp,
                        originalBody: respBodyForCheck,
                    });

                    if (securityResp) {
                        return securityResp;
                    }
                }

                logDebug("llm", "passed", {callId, durationMs: Date.now() - fetchStartTime});

                // allow: return original
                return resp;
            } as unknown) as typeof globalThis.fetch;

            Object.assign(wrappedFetch, originalFetch);
            globalThis.fetch = wrappedFetch;
            (globalThis as any)[FETCH_WRAPPED_KEY] = true;
            logDebug("init", "fetch_interceptor_installed", {});

        } // end of if (!alreadyWrapped) fetch wrapping block

        // =========================================================================
        // 2) hook observers (focused fields)
        // =========================================================================

        api.on("before_prompt_build", async (event, ctx) => {
            const sid = ctx.sessionKey ?? "unknown";
            const rid = ctx.runId ?? "unknown";

            // Build oc-sec marker: base64-encode the entire sid=xx&rid=yy payload
            // Format: <!-- oc-sec:BASE64(sid=VALUE&rid=VALUE) -->
            const encoded = encodeOcSecPayload(sid, rid);
            const marker = `${OC_SEC_MARKER_PREFIX}${encoded}${OC_SEC_MARKER_SUFFIX}`;

            logInfo("hook", "before_prompt_build_inject", {
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                sessionId: sid,
                runId: rid,
                channelId: ctx.channelId,
                modelProviderId: ctx.modelProviderId,
                messagesCount: Array.isArray(event.messages) ? event.messages.length : 0,
                markerPreview: marker,
            });

            return { appendSystemContext: marker };
        });

        api.on("before_agent_start", async (event, ctx) => {
            logDebug("hook", "before_agent_start", {
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                messagesCount: Array.isArray(event.messages) ? event.messages.length : 0,
            });
        });

        api.on("before_dispatch", async (event, ctx) => {
            // before_dispatch 仅用户消息触发，Announce/SubAgent 不触发
            // 标记此 session 即将开始新的用户交互，供 createRunContext 区分 Main Run 和 Announce Run
            if (ctx.sessionKey) {
                markNewTrace(ctx.sessionKey);
            }
            logDebug("hook", "before_dispatch", {
                channelId: ctx.channelId,
                sessionKey: ctx.sessionKey,
            });
        });

        api.on("session_start", async (event, ctx) => {
            logDebug("hook", "session_start", {
                agentId: ctx.agentId,
                sessionId: event.sessionId,
            });
        });

        api.on("llm_input", async (event, ctx) => {
            logDebug("hook", "llm_input", {
                agentId: ctx.agentId,
                runId: event.runId,
                provider: event.provider,
                model: event.model,
            });

            // Create RunContext (consumes parentInfo if sub-agent)
            const runCtx = createRunContext({
                runId: event.runId,
                sessionId: event.sessionId,
                sessionKey: ctx.sessionKey ?? "unknown",
                agentId: ctx.agentId ?? "unknown",
                channelId: ctx.channelId ?? "unknown",
                provider: event.provider,
                model: event.model,
            });

            // fire-and-forget run_start
            const meta = buildReportMeta(runCtx);
            reportRunStart(meta, { content: event.prompt }, protectServerAddr, originalFetch).catch((e) => {
                logWarn("report", "run_start_failed", { runId: event.runId, error: String(e) });
            });
        });

        api.on("llm_output", async (event, ctx) => {
            logDebug("hook", "llm_output", {
                agentId: ctx.agentId,
                runId: event.runId,
                provider: event.provider,
                model: event.model,
                usage: event.usage,
            });

            // fire-and-forget run_end, then cleanup RunContext
            const runCtx = getRunContext(event.runId);
            if (runCtx) {
                const meta = buildReportMeta(runCtx);
                const content = event.assistantTexts?.join("\n") ?? "";
                reportRunEnd(meta, { content }, protectServerAddr, originalFetch).catch((e) => {
                    logWarn("report", "run_end_failed", { runId: event.runId, error: String(e) });
                });
                // Cleanup here after run_end report is sent (agent_end fires before llm_output)
                cleanupRun(event.runId);
            }
        });

        api.on("message_received", async (event, ctx) => {
            logDebug("hook", "message_received", {
                channelId: ctx.channelId,
                from: event.from,
            });
        });

        api.on("message_sending", async (event, ctx) => {
            logDebug("hook", "message_sending", {
                channelId: ctx.channelId,
                to: event.to,
            });

            // Observe-only: do not modify / cancel
            return;
        });

        api.on("message_sent", async (event, ctx) => {
            logDebug("hook", "message_sent", {
                channelId: ctx.channelId,
                to: event.to,
                success: event.success,
            });
        });

        api.on("before_tool_call", async (event, ctx) => {
            logDebug("tool_call", "before_tool_call", {
                toolName: event.toolName,
                params: event.params,
                hasGuard: !!skillMdGuard,
            });

            // Lookup RunContext (needed by both skill guard and tool check)
            const runCtx = event.runId ? getRunContext(event.runId) : undefined;
            if (!runCtx) {
                logError("tool_call", "run_context_missing", { toolName: event.toolName, runId: event.runId });
                return;
            }

            const meta = buildReportMeta(runCtx);
            const llmCallId = event.runId ? getLastLlmCallId(event.runId) : undefined;
            const toolCheckPayload: BeforeToolCallPayload = {
                llm_call_id: llmCallId ?? randomUUID(),
                tool_call_id: event.toolCallId ?? randomUUID(),
                tool_payload: { check_type: "tool", name: event.toolName, parameters: event.params },
            };

            // 1. Skill runtime guard (local + APS query, higher priority)
            if (skillMdGuard && event.toolName === "read") {
                try {
                    const filePath = typeof event.params?.path === "string" ? event.params.path : undefined;
                    if (filePath) {
                        const guardResult = await skillMdGuard.handleSkillMdRead(filePath, meta, toolCheckPayload);
                        if (guardResult?.block) {
                            logInfo("skill_guard", "skill_blocked", { toolName: event.toolName, path: filePath });
                            return { block: true, blockReason: guardResult.blockReason };
                        }
                    }
                } catch (e: unknown) {
                    logWarn("skill_guard", "guard_error", {
                        toolName: event.toolName,
                        error: String(e instanceof Error ? e.message : e),
                    });
                }
            }

            // 2. Tool call security check via new protocol
            try {
                const result = await checkBeforeToolCall(meta, toolCheckPayload, protectServerAddr, originalFetch);

                logDebug("tool_call", "request_check", { toolName: event.toolName, action: result.action });

                if (result.action === "block") {
                    const blockReason = result.content ?? "Tool call blocked by security policy";
                    logInfo("tool_call", "request_blocked", { toolName: event.toolName });
                    return { block: true, blockReason };
                }
            } catch (e: unknown) {
                logWarn("tool_call", "request_check_failed", {
                    toolName: event.toolName,
                    error: String(e instanceof Error ? e.message : e),
                });
            }

            return;
        });

        api.on("after_tool_call", async (event, ctx) => {
            const runCtx = event.runId ? getRunContext(event.runId) : undefined;
            if (!runCtx) {
                logError("tool_call", "after_run_context_missing", { toolName: event.toolName, runId: event.runId });
                return;
            }

            try {
                const meta = buildReportMeta(runCtx);
                const llmCallId = event.runId ? getLastLlmCallId(event.runId) : undefined;
                const result = await checkAfterToolCall(meta, {
                    llm_call_id: llmCallId ?? randomUUID(),
                    tool_call_id: event.toolCallId ?? randomUUID(),
                    tool_payload: {
                        check_type: "tool",
                        name: event.toolName,
                        parameters: event.params,
                        result: event.result,
                        error: event.error,
                        duration_ms: event.durationMs,
                    },
                }, protectServerAddr, originalFetch);

                logDebug("tool_call", "response_check", { toolName: event.toolName, action: result.action });

                if (result.action === "block" && event.result) {
                    const blockReason = result.content ?? "Tool result blocked by security policy";
                    logInfo("tool_call", "response_blocked", { toolName: event.toolName });
                    const interceptedData = {
                        error: "Intercepted",
                        message: "The result has been intercepted.",
                        reason: blockReason,
                    };
                    const mutableResult = event.result as Record<string, unknown>;
                    const newContent = [
                        { type: "text", text: JSON.stringify(interceptedData, null, 2) },
                    ];
                    if (Array.isArray(mutableResult.content) || mutableResult.content === undefined) {
                        mutableResult.content = newContent;
                    } else {
                        logWarn("tool_call", "unexpected_content_type", {
                            toolName: event.toolName,
                            contentType: typeof mutableResult.content,
                        });
                    }
                    mutableResult.details = interceptedData;
                }
            } catch (e: unknown) {
                logWarn("tool_call", "response_check_failed", {
                    toolName: event.toolName,
                    error: String(e instanceof Error ? e.message : e),
                });
            }
        });

        api.on("session_end", async (event, ctx) => {
            // 清理 sessionKey 维度的所有状态（sessionRunId、sessionTrace、pendingNewTrace、parentInfo）
            if (ctx.sessionKey) {
                cleanupSession(ctx.sessionKey);
            }
            logDebug("hook", "session_end", {
                agentId: ctx.agentId,
                sessionId: event.sessionId,
                messageCount: event.messageCount,
                durationMs: event.durationMs,
            });
        });

        api.on("subagent_spawned", async (event, ctx) => {
            if (ctx.requesterSessionKey && ctx.runId) {
                // ctx.runId 是子的 runId（框架行为），通过父 sessionKey 反查父的真实 runId
                const actualParentRunId = getRunIdBySessionKey(ctx.requesterSessionKey);
                // 查找父 RunContext 获取 trace_id
                const parentRunCtx = actualParentRunId ? getRunContext(actualParentRunId) : undefined;
                setParentInfo(event.childSessionKey, {
                    parentSessionKey: ctx.requesterSessionKey,
                    parentRunId: actualParentRunId ?? ctx.runId,
                    traceId: parentRunCtx?.trace_id,
                });
            }
            logDebug("hook", "subagent_spawned", {
                childSessionKey: event.childSessionKey,
                parentSessionKey: ctx.requesterSessionKey,
                parentRunId: getRunIdBySessionKey(ctx.requesterSessionKey ?? ""),
                childRunId: ctx.runId,
            });
        });

        api.on("agent_end", async (event, ctx) => {
            logDebug("hook", "agent_end", {
                runId: ctx.runId,
                success: event.success,
                durationMs: event.durationMs,
            });
            // NOTE: Do NOT cleanupRun here. agent_end fires before llm_output,
            // and llm_output needs the RunContext to send run_end report.
            // Cleanup is done in llm_output after the report is sent.
            // Safety net: deferred cleanup in case llm_output never fires.
            if (ctx.runId) {
                const runId = ctx.runId;
                setTimeout(() => {
                    if (hasRunContext(runId)) {
                        logWarn("run_context", "deferred_cleanup", { runId, reason: "llm_output did not fire within timeout" });
                        cleanupRun(runId);
                    }
                }, 30_000);
            }
        });

        logDebug("init", "hooks_registered", {});

        // =========================================================================
        // 3) Status reporting routes
        // =========================================================================

        const statusCollector = initStatusCollector(
            "openclaw-security-assistant",
            SDK_VERSION,
        );

        // Register health signals provider (reads live state from auth-service)
        statusCollector.registerHealthSignals(() => ({
            authReady: isAuthServiceReady(),
            authErrMsg: getAuthErrMsg(),
        }));

        // Register module status providers
        statusCollector.registerProvider("auth", () => {
            const jwtPayload = getJwtPayload();
            return {
                ready: isAuthServiceReady(),
                installKeyPresent: !!runtimeCtx.installKey,
                userId: jwtPayload?.tenant_id || null,
                agentId: runtimeCtx.agentId ?? null,
                tokenExpiry: jwtPayload?.exp
                    ? new Date(jwtPayload.exp * 1000).toISOString()
                    : null,
            };
        });

        statusCollector.registerProvider("assetReport", () => ({
            lastReportAt: getLastAssetReportAt(),
            lastReportErrMsg: getLastAssetReportErrMsg(),
        }));

        statusCollector.registerProvider("skillSecurity", () => {
            const sched = skillScanScheduler;
            if (!sched) {
                return {
                    status: "stopped",
                    pendingCount: 0,
                    lastScanAt: null,
                    fingerprintStore: { totalSkills: 0, uploadedSkills: 0, skippedSkills: 0 },
                };
            }
            return {
                status: sched.isRunning ? "running" : "stopped",
                pendingCount: sched.pendingCount,
                lastScanAt: sched.lastCycleAt,
                fingerprintStore: sched.fingerprintStore.getStats(),
            };
        });

        statusCollector.registerProvider("config", () => ({
            endpointAddr: config.endpointAddr,
            protectServerAddr: config.protectServerAddr,
            managementServerAddr: config.managementServerAddr,
            debug: config.debug,
        }));

        statusCollector.registerProvider("runtime", () => ({
            machineId: runtimeCtx.machineId,
            openclawVersion: runtimeCtx.openclaw.version,
            platform: runtimeCtx.system.platform,
            arch: runtimeCtx.system.arch,
            nodeVersion: runtimeCtx.nodeRuntime.version,
            initializedAt: runtimeCtx.initializedAt,
        }));

        // Register HTTP routes for health and status endpoints
        registerStatusRoutes(api, statusCollector);

        // Register CLI commands for chat-facing status queries
        registerStatusCommands(api, statusCollector);

        // NOTE: `ali-osa` 命令组已在 register 开头（cli-metadata 模式前）注册，
        // 此处不再重复注册，避免 full 模式下 registerCli 冲突。

        logDebug("init", "status_routes_registered", {});
    },
};

export default plugin;
