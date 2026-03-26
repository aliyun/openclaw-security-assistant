import path from "node:path";
import type {OpenClawPluginApi} from "openclaw/plugin-sdk";
import {
    createOpenClawSecurityAssistantConfigSchema,
    resolveOpenClawSecurityAssistantConfig,
} from "./src/config.js";
import {createAssetReportService} from "./src/asset-report-service.js";
import {createAuthService} from "./src/auth-service.js";
import {initializeRuntimeContext, getRuntimeContext} from "./src/runtime.js";
import type {ProviderMatch, SecurityAction} from "./src/types.js";
import {
    checkLlmRequest,
    checkLlmResponse,
    checkToolCallRequest,
    checkToolCallResponse,
    getProviderBaseUrls,
    matchProviderByUrl
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

// Body preview truncation limit for debug logs
const BODY_PREVIEW_MAX_LENGTH = 500;

// 防止 fetch 重复包装的全局标记
const FETCH_WRAPPED_KEY = Symbol.for('openclaw-security-assistant.fetch-wrapped');
// 缓存插件加载前的原始 fetch，确保所有内部调用（service、hook）都使用未被包装的 fetch
const ORIGINAL_FETCH_KEY = Symbol.for('openclaw-security-assistant.original-fetch');

const plugin = {
    id: "openclaw-security-assistant",
    name: "@alicloud/openclaw-security-assistant",
    configSchema: createOpenClawSecurityAssistantConfigSchema(),
    description: "Security assistant plugin by Alibaba Cloud that provides LLM request/response protection, tool call security checks.",
    register(api: OpenClawPluginApi) {
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

        // 1) 注册资产信息上报 service：定时上报系统资产信息
        api.registerService(
            createAssetReportService({
                api,
                originalFetch,
                protectServerAddr,
                intervalMs: 600_000, // 10min上传一次
                timeoutMs: 60_000, // 超时1min
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
                const providerUrls = getProviderBaseUrls(api.config);
                const matchedProvider = matchProviderByUrl(url, providerUrls);

                // 未匹配任何 provider baseUrl，直接放行
                if (!matchedProvider) {
                    return originalFetch(input as any, init);
                }

                const method = getMethodFromFetchArgs(input, init);
                const reqHeaders = getMergedRequestHeaders(input, init);
                const reqBodyText = await getRequestBodyText(input, init);

                logDebug("llm", "request", {
                    callId,
                    url,
                    provider: matchedProvider.providerId,
                    method,
                    headerKeys: Object.keys(reqHeaders),
                    bodyPreview: reqBodyText?.slice(0, BODY_PREVIEW_MAX_LENGTH),
                });

                let reqAction: SecurityAction = "allow";
                let reqContent: string | undefined;
                try {
                    const checkStart = Date.now();
                    const result = await checkLlmRequest(
                        {
                            url,
                            method,
                            headers: reqHeaders,
                            bodyText: reqBodyText,
                        },
                        protectServerAddr,
                        originalFetch,
                        api.logger,
                    );
                    reqAction = result.action;
                    reqContent = result.content;
                    const checkDurationMs = Date.now() - checkStart;
                    if (reqAction !== "allow") {
                        logInfo("llm", "request_check", {callId, action: reqAction, url, provider: matchedProvider.providerId, checkDurationMs});
                    }
                    logDebug("llm", "request_check_result", {callId, checkDurationMs});
                } catch (e: any) {
                    logWarn("llm", "request_check_failed", {
                        callId,
                        url,
                        provider: matchedProvider.providerId,
                        error: String(e?.message || e),
                    });
                    reqAction = "allow";
                }

                const wantsSse = guessRequestWantsSse(url, reqHeaders, reqBodyText);

                if (reqAction === "block") {
                    const blockContent = reqContent ?? "当前提示词请求存在安全风险，已被安全组件拦截";
                    logInfo("llm", "request_blocked", {
                        callId,
                        url,
                        provider: matchedProvider.providerId,
                        streaming: wantsSse,
                    });

                    return createSecurityResponse(reqAction, blockContent, {
                        isRequest: true,
                        wantsSse,
                    })!;
                }

                // do fetch
                let resp: Response;
                const fetchStartTime = Date.now();
                try {
                    resp = await originalFetch(input as any, init);
                } catch (e: any) {
                    logError("fetch", "error", {
                        callId,
                        url,
                        provider: matchedProvider.providerId,
                        error: String(e?.message || e),
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
                try {
                    const checkStart = Date.now();
                    const result = await checkLlmResponse(
                        {
                            url,
                            method,
                            status: resp.status,
                            headers: respHeaders,
                            respText: respBodyForCheck,
                        },
                        protectServerAddr,
                        originalFetch,
                        api.logger,
                    );
                    respAction = result.action;
                    respContent = result.content;
                    const checkDurationMs = Date.now() - checkStart;
                    if (respAction !== "allow") {
                        logInfo("llm", "response_check", {callId, action: respAction, url, provider: matchedProvider.providerId, checkDurationMs});
                    }
                    logDebug("llm", "response_check_result", {callId, checkDurationMs});
                } catch (e: any) {
                    logWarn("llm", "response_check_failed", {
                        callId,
                        url,
                        provider: matchedProvider.providerId,
                        status: resp.status,
                        error: String(e?.message || e),
                    });
                    respAction = "allow";
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
            logDebug("hook", "before_prompt_build", {
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                messagesCount: Array.isArray(event.messages) ? event.messages.length : 0,
            });
        });

        api.on("before_agent_start", async (event, ctx) => {
            logDebug("hook", "before_agent_start", {
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                messagesCount: Array.isArray(event.messages) ? event.messages.length : 0,
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
        });

        api.on("llm_output", async (event, ctx) => {
            logDebug("hook", "llm_output", {
                agentId: ctx.agentId,
                runId: event.runId,
                provider: event.provider,
                model: event.model,
                usage: event.usage,
            });
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
            // Tool Call 请求安全检测
            try {
                const result = await checkToolCallRequest(
                    {
                        name: event.toolName,
                        parameters: event.params,
                    },
                    protectServerAddr,
                    originalFetch,
                );

                logDebug("tool_call", "request_check", {toolName: event.toolName, action: result.action});

                if (result.action === "block") {
                    const blockReason = result.content ?? "Tool call blocked by security policy";
                    logInfo("tool_call", "request_blocked", {toolName: event.toolName});
                    return {block: true, blockReason};
                }
            } catch (e: any) {
                logWarn("tool_call", "request_check_failed", {
                    toolName: event.toolName,
                    error: String(e?.message || e),
                });
            }

            return;
        });

        api.on("after_tool_call", async (event, ctx) => {
            // Tool Call 响应安全检测
            try {
                const result = await checkToolCallResponse(
                    {
                        name: event.toolName,
                        parameters: event.params,
                        result: event.result,
                        error: event.error,
                    },
                    protectServerAddr,
                    originalFetch,
                );

                logDebug("tool_call", "response_check", {toolName: event.toolName, action: result.action});

                if (result.action === "block" && event.result) {
                    const blockReason = result.content ?? "Tool result blocked by security policy";
                    logInfo("tool_call", "response_blocked", {toolName: event.toolName});
                    const interceptedData = {
                        error: "Intercepted",
                        message: "The result has been intercepted.",
                        reason: blockReason,
                    };
                    const mutableResult = event.result as Record<string, unknown>;
                    const newContent = [
                        {type: "text", text: JSON.stringify(interceptedData, null, 2)},
                    ];
                    // Only overwrite content when it is an array or absent;
                    // skip assignment for unexpected types to avoid corrupting unknown structures.
                    if (Array.isArray(mutableResult.content) || mutableResult.content === undefined) {
                        mutableResult.content = newContent;
                    } else {
                        logWarn("tool_call", "unexpected_content_type", {
                            toolName: event.toolName,
                            contentType: typeof mutableResult.content,
                        });
                    }
                    // Always attach interception metadata so downstream can detect the block
                    mutableResult.details = interceptedData;
                }
            } catch (e: any) {
                logWarn("tool_call", "response_check_failed", {
                    toolName: event.toolName,
                    error: String(e?.message || e),
                });
            }
        });

        api.on("session_end", async (event, ctx) => {
            logDebug("hook", "session_end", {
                agentId: ctx.agentId,
                sessionId: event.sessionId,
                messageCount: event.messageCount,
                durationMs: event.durationMs,
            });
        });

        logDebug("init", "hooks_registered", {});
    },
};

export default plugin;
