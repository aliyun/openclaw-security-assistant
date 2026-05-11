/**
 * 状态透出模块 - 状态收集器
 *
 * 模块级单例，各业务模块通过 registerProvider(key, provider) 注册自己的状态提供函数。
 * 收集器负责聚合所有模块状态并计算健康概览。
 */

import type {
    HealthResponse,
    HealthStatus,
    StatusProvider,
    StatusResponse,
} from "./types.js";
import { logDebug } from "../logger.js";

// ============================================================================
// Status Collector
// ============================================================================

/** Health 状态判断所需的关键信号 */
export type HealthSignals = {
    /** 认证服务是否就绪（isReady = true） */
    authReady: boolean;
    /** 认证服务错误信息（仅不可恢复错误时非 null） */
    authErrMsg: string | null;
};

/** Health 信号提供函数 */
export type HealthSignalProvider = () => HealthSignals;

export class StatusCollector {
    /** 插件名称 */
    private _pluginName: string;
    /** 插件版本号 */
    private _pluginVersion: string;
    /** 各模块的状态提供函数 */
    private readonly providers = new Map<string, StatusProvider>();
    /** Health 信号提供函数 */
    private healthSignalProvider: HealthSignalProvider | null = null;

    constructor(pluginName: string, pluginVersion: string) {
        this._pluginName = pluginName;
        this._pluginVersion = pluginVersion;
    }

    /** 插件名称（公开只读） */
    get pluginName(): string {
        return this._pluginName;
    }

    /** 插件版本号（公开只读） */
    get pluginVersion(): string {
        return this._pluginVersion;
    }

    /**
     * 更新插件名称和版本号（用于插件升级后重新注册时刷新实例信息）
     */
    updateInfo(pluginName: string, pluginVersion: string): void {
        this._pluginName = pluginName;
        this._pluginVersion = pluginVersion;
    }

    /**
     * 注册模块状态提供函数
     *
     * @param key 模块标识（如 "auth", "assetReport", "skillSecurity"）
     * @param provider 返回该模块当前状态数据的函数
     */
    registerProvider(key: string, provider: StatusProvider): void {
        this.providers.set(key, provider);
    }

    /**
     * 注册 health 信号提供函数
     *
     * Health 端点的状态判断逻辑与具体模块解耦，通过此函数注入关键信号。
     */
    registerHealthSignals(provider: HealthSignalProvider): void {
        this.healthSignalProvider = provider;
    }

    /**
     * 计算用户视角的健康概览
     */
    computeHealth(): HealthResponse {
        const signals = this.healthSignalProvider?.();

        let status: HealthStatus;
        let message: string;

        // health 的计算逻辑：
        // 1. signals 未就绪 → waiting（信号源尚未注册）
        // 2. authErrMsg 非 null → error（优先反映不可恢复错误；即便 isReady 仍为 true，
        //    也不会被 ok 覆盖，避免"服务端已废弃 token 但 /health 仍报 ok"的状态错位）
        // 3. authReady → ok
        // 4. 其余情况 → waiting（正在获取/验证 token）
        if (!signals) {
            status = "waiting";
            message = "状态信号未就绪";
        } else if (signals.authErrMsg) {
            status = "error";
            message = signals.authErrMsg;
        } else if (signals.authReady) {
            status = "ok";
            message = "安全防护已启用";
        } else {
            status = "waiting";
            message = "正在连接安全服务...";
        }

        return {
            name: this.pluginName,
            version: this.pluginVersion,
            status,
            message,
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * 收集运维视角的完整状态数据
     */
    collect(): StatusResponse {
        const result: StatusResponse = {
            name: this.pluginName,
            version: this.pluginVersion,
            timestamp: new Date().toISOString(),
        };

        for (const [key, provider] of this.providers) {
            try {
                result[key] = provider();
            } catch {
                result[key] = { error: "failed to collect status" };
            }
        }

        return result;
    }
}

// ============================================================================
// Module-level Singleton
// ============================================================================

let instance: StatusCollector | null = null;

/**
 * 初始化状态收集器（插件注册时调用一次）
 */
export function initStatusCollector(pluginName: string, pluginVersion: string): StatusCollector {
    if (!instance) {
        instance = new StatusCollector(pluginName, pluginVersion);
    } else if (instance.pluginName !== pluginName || instance.pluginVersion !== pluginVersion) {
        logDebug("status", "init_update", {
            previous: { name: instance.pluginName, version: instance.pluginVersion },
            updated: { name: pluginName, version: pluginVersion },
        });
        instance.updateInfo(pluginName, pluginVersion);
    }
    return instance;
}

/**
 * 获取状态收集器实例
 */
export function getStatusCollector(): StatusCollector | null {
    return instance;
}
