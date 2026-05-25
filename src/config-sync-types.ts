/**
 * config-sync-service 公共类型定义
 *
 * 定义远端配置拉取服务相关的数据结构，包括：
 * - APS 远端配置结构（SdkConfig 及其子结构）
 * - 配置拉取响应
 * - 配置委派处理器接口
 * - 服务创建参数
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// IdaaS Server Config Types（服务端下发的 IdaaS 配置）
// ============================================================================

/** IdaaS profile 配置结构（config 字段内部） */
export type IdaasProfileConfig = {
    version?: string;
    current_profile?: string;
    profile?: Record<string, unknown>;
};

/** 服务端下发的 IdaaS access token 刷新服务配置 */
export type IdaasAccessTokenConfig = {
    /** 是否启用 access token 刷新服务 */
    enable: boolean;
    /** 固定刷新周期（秒）；若 > (exp - now - REFRESH_LEAD_MS) 则提前调度一次 */
    exchange_interval_s: number;
};

/** 服务端下发的 IdaaS 凭据托管服务配置 */
export type IdaasHostSecretConfig = {
    /** 是否启用凭据托管服务 */
    enable: boolean;
    /** 凭据托管扫描间隔（秒） */
    interval_s: number;
};

/** 服务端下发的 IdaaS 配置结构 */
export type IdaasServerConfig = {
    /** IdaaS profile 配置 */
    config?: IdaasProfileConfig;
    /** CLI 下载地址，按 OS → arch → URL 组织 */
    cli_url?: Record<string, Record<string, string>>;
    /** AISC App ID，用于凭据 ID 生成 */
    aisc_app_id?: string;
    /** access token 刷新服务配置 */
    access_token?: IdaasAccessTokenConfig;
    /** 凭据托管服务配置 */
    host_secret?: IdaasHostSecretConfig;
};

// ============================================================================
// Config Sync Service Types
// ============================================================================

/** APS 远端配置顶层结构（仅解析到第一层） */
export type SdkConfig = {
    /** 是否启用安全防护 */
    enabled: boolean;
    /** 防护模式 */
    mode: string;
    /** 心跳上报间隔（秒） */
    heartbeat_interval_s: number;
    /** 配置拉取间隔（秒） */
    config_interval_s: number;
    /** IDaaS 相关配置 */
    idaas: IdaasServerConfig;
    /** 检测相关配置（暂不深入解析） */
    detection: Record<string, unknown>;
    /** RASP 相关配置（暂不深入解析） */
    rasp: Record<string, unknown>;
};

/** 200 响应体 */
export type ConfigSyncResponse = {
    /** 单调递增的配置版本号 */
    version: number;
    /** 完整配置 JSON */
    config: SdkConfig;
};

/** 配置委派处理器：当远端配置更新时被调用 */
export type ConfigDelegate = {
    /** 委派处理器标识，用于日志追踪 */
    id: string;
    /** 配置更新回调，接收完整的 SdkConfig */
    onConfigUpdate: (config: SdkConfig) => Promise<void> | void;
};

/** config-sync-service 创建参数 */
export type ConfigSyncServiceParams = {
    api: OpenClawPluginApi;
    originalFetch: typeof globalThis.fetch;
    protectServerAddr: string;
    timeoutMs?: number;
    /** 配置委派处理器列表，配置更新时依次调用 */
    delegates?: ConfigDelegate[];
};
