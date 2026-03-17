import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
    createOpenClawSecurityAssistantConfigSchema,
    resolveOpenClawSecurityAssistantConfig,
} from "./src/config.js";
import { createAssetReportService } from "./src/asset-report-service.js";
import { createAuthService } from "./src/auth-service.js";
import { initializeRuntimeContext, getRuntimeContext } from "./src/runtime.js";
import type { ProviderMatch, SecurityAction } from "./src/types.js";
import { checkLlmRequest, checkLlmResponse, checkToolCallRequest, checkToolCallResponse, getProviderBaseUrls, matchProviderByUrl } from "./src/check.js";
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

        logDebug("init", "plugin_source", { source: api.source });
        logDebug("init", "plugin_directory", { directory: pluginDir });

        logInfo("init", "runtime_initialized", {
            openclaw: runtimeCtx.openclaw.version,
            machineId: runtimeCtx.machineId,
        });
        logInfo("init", "install_key_status", { status: runtimeCtx.installKey ? "loaded" : "missing" });

        logInfo("config", "loaded", {
            protectServerAddr: config.protectServerAddr,
            managementServerAddr: config.managementServerAddr,
            debug: config.debug,
        });

        const originalFetch = globalThis.fetch;

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

        const wrappedFetch: typeof globalThis.fetch = (async function wrappedFetch(
            input: RequestInfo | URL,
            init?: RequestInit,
        ): Promise<Response> {
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

            // 调试日志：请求详情
            logDebug("fetch", "request", {
                url,
                method,
                provider: matchedProvider.providerId,
            });

            // 2) request check
            let reqAction: SecurityAction = "pass";
            let reqContent: string | undefined;
            try {
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
                // 关键日志：LLM 请求检查结果
                logInfo("llm", "request_check", {
                    url,
                    provider: matchedProvider.providerId,
                    action: reqAction,
                });
                // 调试日志：详细内容
                logDebug("llm", "request_check_detail", { content: reqContent });
            } catch (e: any) {
                logWarn("llm", "request_check_failed", {
                    url,
                    provider: matchedProvider.providerId,
                    error: String(e?.message || e),
                });
                reqAction = "pass";
            }

            const wantsSse = guessRequestWantsSse(url, reqHeaders, reqBodyText);

            if (reqAction === "block") {
                const blockContent = reqContent ?? "当前提示词请求存在安全风险，已被安全组件拦截";

                // 关键日志：请求被拦截
                logInfo("llm", "request_blocked", {
                    url,
                    provider: matchedProvider.providerId,
                    streaming: wantsSse,
                });

                return createSecurityResponse(reqAction, blockContent, {
                    isRequest: true,
                    wantsSse,
                })!;
            }

            // 3) do fetch
            let resp: Response;
            try {
                resp = await originalFetch(input as any, init);
            } catch (e: any) {
                logError("fetch", "error", {
                    url,
                    provider: matchedProvider.providerId,
                    error: String(e?.message || e),
                });
                throw e;
            }

            const respHeaders = headersToRecord(resp.headers);
            const sse = isSseResponse(resp);

            // 4) clone body for check (NOTE: for SSE this reads full stream; ok for initial testing)
            let respBodyForCheck = "";
            try {
                respBodyForCheck = await resp.clone().text();
            } catch {
                respBodyForCheck = "[unreadable response body]";
            }

            // 调试日志：响应详情
            logDebug("fetch", "response_raw", {
                url,
                provider: matchedProvider.providerId,
                status: resp.status,
            });

            // 5) response check
            let respAction: SecurityAction = "pass";
            let respContent: string | undefined;
            try {
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
                // 关键日志：LLM 响应检查结果
                logInfo("llm", "response_check", {
                    url,
                    provider: matchedProvider.providerId,
                    status: resp.status,
                    action: respAction,
                });
                // 调试日志：详细内容
                logDebug("llm", "response_check_detail", { content: respContent });
            } catch (e: any) {
                logWarn("llm", "response_check_failed", {
                    url,
                    provider: matchedProvider.providerId,
                    status: resp.status,
                    error: String(e?.message || e),
                });
                respAction = "pass";
            }

            if (respAction === "block" || respAction === "hint") {
                const content = respContent ?? (respAction === "block" ? "当前大模型响应存在安全风险，已被安全组件拦截" : "");

                // 关键日志：响应被拦截
                logInfo("llm", `response_${respAction}`.replace("response_block", "response_blocked"), {
                    url,
                    provider: matchedProvider.providerId,
                    status: resp.status,
                    streaming: sse,
                });

                const securityResp = createSecurityResponse(respAction, content, {
                    isRequest: false,
                    wantsSse: sse,
                    originalResponse: resp,
                    originalBody: respBodyForCheck,
                });

                if (securityResp) {
                    return securityResp;
                }
            }

            // 调试日志：响应放行
            logDebug("fetch", "response_passed", {
                url,
                provider: matchedProvider.providerId,
                status: resp.status,
                streaming: sse,
            });

            // allow: return original
            return resp;
        } as unknown) as typeof globalThis.fetch;

        Object.assign(wrappedFetch, originalFetch);
        globalThis.fetch = wrappedFetch;
        logInfo("init", "fetch_interceptor_installed", {});

        // =========================================================================
        // 2) hook observers (focused fields)
        // =========================================================================

        api.on("before_prompt_build", async (event, ctx) => {
            logDebug("observer", "before_prompt_build", {
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                messagesCount: Array.isArray(event.messages) ? event.messages.length : 0,
            });
        });

        api.on("before_agent_start", async (event, ctx) => {
            logDebug("observer", "before_agent_start", {
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                messagesCount: Array.isArray(event.messages) ? event.messages.length : undefined,
            });
        });

        api.on("session_start", async (event, ctx) => {
            logDebug("observer", "session_start", {
                agentId: ctx.agentId,
                sessionId: event.sessionId,
            });
        });

        api.on("llm_input", async (event, ctx) => {
            logDebug("observer", "llm_input", {
                agentId: ctx.agentId,
                runId: event.runId,
                provider: event.provider,
                model: event.model,
            });
        });

        api.on("llm_output", async (event, ctx) => {
            logDebug("observer", "llm_output", {
                agentId: ctx.agentId,
                runId: event.runId,
                provider: event.provider,
                model: event.model,
                usage: event.usage,
            });
        });

        api.on("message_received", async (event, ctx) => {
            logDebug("observer", "message_received", {
                channelId: ctx.channelId,
                from: event.from,
            });
        });

        api.on("message_sending", async (event, ctx) => {
            logDebug("observer", "message_sending", {
                channelId: ctx.channelId,
                to: event.to,
            });

            // Observe-only: do not modify / cancel
            return;
        });

        api.on("message_sent", async (event, ctx) => {
            logDebug("observer", "message_sent", {
                channelId: ctx.channelId,
                to: event.to,
                success: event.success,
            });
        });

        api.on("before_tool_call", async (event, ctx) => {
            logDebug("observer", "before_tool_call", {
                agentId: ctx.agentId,
                toolName: event.toolName,
            });

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

                // 关键日志：Tool Call 请求检查结果
                logInfo("tool_call", "request_check", {
                    toolName: event.toolName,
                    action: result.action,
                });
                // 调试日志：详细内容
                logDebug("tool_call", "request_check_detail", { content: result.content });

                if (result.action === "block") {
                    const blockReason = result.content ?? "Tool call blocked by security policy";
                    // 关键日志：Tool Call 被拦截
                    logInfo("tool_call", "request_blocked", {
                        toolName: event.toolName,
                    });
                    return { block: true, blockReason };
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
            logDebug("observer", "after_tool_call", {
                agentId: ctx.agentId,
                toolName: event.toolName,
                durationMs: event.durationMs,
                hasError: !!event.error,
            });

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

                // 关键日志：Tool Call 响应检查结果
                logInfo("tool_call", "response_check", {
                    toolName: event.toolName,
                    action: result.action,
                });
                // 调试日志：详细内容
                logDebug("tool_call", "response_check_detail", { content: result.content });

                if (result.action === "block" && event.result) {
                    const blockReason = result.content ?? "Tool result blocked by security policy";
                    // 关键日志：Tool Call 响应被拦截
                    logInfo("tool_call", "response_blocked", {
                        toolName: event.toolName,
                    });
                    const interceptedData = {
                        error: "Intercepted",
                        message: "The result has been intercepted.",
                        reason: blockReason,
                    };
                    event.result.content = [
                        { type: "text", text: JSON.stringify(interceptedData, null, 2) },
                    ];
                    event.result.details = interceptedData;
                }
            } catch (e: any) {
                logWarn("tool_call", "response_check_failed", {
                    toolName: event.toolName,
                    error: String(e?.message || e),
                });
            }
        });

        api.on("session_end", async (event, ctx) => {
            logDebug("observer", "session_end", {
                agentId: ctx.agentId,
                sessionId: event.sessionId,
                messageCount: event.messageCount,
                durationMs: event.durationMs,
            });
        });

        logInfo("init", "hooks_registered", {
            hooks: "before_prompt_build, before_agent_start, llm_input, llm_output, message_received, message_sending, message_sent, before_tool_call, after_tool_call, session_start, session_end",
        });
    },
};

export default plugin;
