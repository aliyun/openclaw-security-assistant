/**
 * IdaaS 配置协调器（Coordinator）
 *
 * 作为 config-sync-service 的唯一 IdaaS delegate，
 * 按依赖顺序统一处理 SdkConfig.idaas 配置变更：
 *
 * Layer 1: profile + CLI 下载（一切的前提）
 * Layer 2: access token 刷新开关 + 间隔
 * Layer 3: 凭据托管开关 + 扫描间隔
 *
 * 各阶段独立 try/catch，单阶段失败不影响后续阶段。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/core";
import type { ConfigDelegate, SdkConfig } from "../config-sync-types.js";
import { processIdaasConfig } from "./idaas-config.js";
import { initIdaasAccessTokenService, applyAccessTokenConfig } from "./idaas-access-token-service.js";
import { initCredentialHostingService, stopCredentialHostingService, applyHostSecretConfig } from "./credential-hosting-service.js";
import { logDebug, logError } from "../logger.js";

/**
 * 创建 IdaaS 配置委派处理器
 *
 * 注册到 config-sync-service 的 delegates 列表，
 * 当远端配置更新时按依赖顺序应用 IdaaS 相关配置。
 */
export function createIdaasConfigDelegate(deps: {
    api: OpenClawPluginApi;
    originalFetch: typeof globalThis.fetch;
}): ConfigDelegate {
    return {
        id: "idaas-config",
        onConfigUpdate: async (config: SdkConfig) => {
            const idaas = config.idaas;
            if (!idaas) return;

            const stateDir = deps.api.runtime.state.resolveStateDir();

            logDebug("idaas_coordinator", "config_update", {
                hasConfig: !!idaas.config,
                hasCliUrl: !!idaas.cli_url,
                hasAccessToken: !!idaas.access_token,
                hasHostSecret: !!idaas.host_secret,
            });

            // Layer 1: profile + CLI 下载（一切的前提）
            try {
                await processIdaasConfig({
                    stateDir,
                    idaasConfig: idaas,
                    originalFetch: deps.originalFetch,
                });
            } catch (e: unknown) {
                logError("idaas_coordinator", "process_config_error", {
                    error: String(e instanceof Error ? e.message : e),
                });
            }

            // 确保子系统初始化（幂等，onConfigUpdate 可能先于 service start 执行）
            initIdaasAccessTokenService({ stateDir });
            initCredentialHostingService({ api: deps.api, stateDir });

            // Layer 2: access token 刷新开关 + 间隔
            if (idaas.access_token) {
                try {
                    applyAccessTokenConfig({
                        enable: idaas.access_token.enable,
                        intervalMs: idaas.access_token.exchange_interval_s * 1000,
                    });
                } catch (e: unknown) {
                    logError("idaas_coordinator", "apply_access_token_error", {
                        error: String(e instanceof Error ? e.message : e),
                    });
                }
            }

            // Layer 3: 凭据托管开关 + 扫描间隔
            if (idaas.host_secret) {
                try {
                    applyHostSecretConfig({
                        enable: idaas.host_secret.enable,
                        intervalMs: idaas.host_secret.interval_s * 1000,
                        aiscAppId: idaas.aisc_app_id,
                    });
                } catch (e: unknown) {
                    logError("idaas_coordinator", "apply_host_secret_error", {
                        error: String(e instanceof Error ? e.message : e),
                    });
                }
            }
        },
    };
}

// ============================================================================
// Unified IdaaS Service
// ============================================================================

/** createIdaasService 的可选配置 */
export type IdaasServiceConfig = {
    /** 凭据扫描间隔（毫秒） */
    scanIntervalMs?: number;
    /** 就绪轮询间隔（毫秒） */
    readinessCheckIntervalMs?: number;
    /** 就绪轮询最大等待时间（毫秒） */
    readinessMaxWaitMs?: number;
};

/**
 * 创建统一的 IdaaS Service
 *
 * 合并 access-token 和 credential-hosting 两个模块的初始化/清理到一个 service 中。
 * 实际启停逻辑仍由 coordinator delegate 通过 applyAccessTokenConfig / applyHostSecretConfig 控制。
 */
export function createIdaasService(params: {
    api: OpenClawPluginApi;
    config?: IdaasServiceConfig;
}): OpenClawPluginService {
    return {
        id: "openclaw-security-assistant-idaas",
        start: async () => {
            // init 已由 onConfigUpdate 幂等保证，此处无需重复
        },
        stop: async () => {
            // 按反向依赖顺序关闭
            stopCredentialHostingService();
            applyAccessTokenConfig({ enable: false });
        },
    };
}
