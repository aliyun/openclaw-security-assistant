/**
 * 状态透出模块 - 类型定义
 *
 * 定义 health（用户视角）和 status（运维视角）两个端点的响应类型。
 */

// ============================================================================
// Health Endpoint Types (User-facing)
// ============================================================================

/** 插件整体健康状态 */
export type HealthStatus = "ok" | "waiting" | "error";

/** 用户视角响应 - 简洁概览 */
export type HealthResponse = {
    /** 插件名称 */
    name: string;
    /** 插件版本号 */
    version: string;
    /** 整体状态 */
    status: HealthStatus;
    /** 状态描述文案（人类可读） */
    message: string;
    /** 报告时间（ISO 格式） */
    timestamp: string;
};

// ============================================================================
// Status Endpoint Types (Ops-facing)
// ============================================================================

/** 认证状态 */
export type AuthStatus = {
    /** 认证服务是否就绪 */
    ready: boolean;
    /** 是否存在安装密钥 */
    installKeyPresent: boolean;
    /** 用户 ID（来自 JWT） */
    userId: string | null;
    /** 智能体 ID（来自 JWT sub） */
    agentId: string | null;
    /** Token 过期时间（ISO 格式） */
    tokenExpiry: string | null;
};

/** 资产上报状态 */
export type AssetReportStatus = {
    /** 上次上报时间（ISO 格式） */
    lastReportAt: string | null;
    /** 上次上报错误信息，无错误时为 null */
    lastReportErrMsg: string | null;
};

/** Skill 指纹库状态 */
export type FingerprintStoreStatus = {
    /** 已发现的 skill 总数 */
    totalSkills: number;
    /** 已上传到 APS 的 skill 数 */
    uploadedSkills: number;
    /** 因规模问题跳过的 skill 数 */
    skippedSkills: number;
};

/** Skill 安全检测状态 */
export type SkillSecurityStatus = {
    /** 扫描器状态 */
    status: "running" | "stopped";
    /** 待扫描的 skill 数量 */
    pendingCount: number;
    /** 最近一次扫描时间（ISO 格式） */
    lastScanAt: string | null;
    /** 指纹库状态 */
    fingerprintStore: FingerprintStoreStatus;
};

/** 配置信息 */
export type ConfigStatus = {
    /** 统一端点地址 */
    endpointAddr: string;
    /** 保护服务地址 */
    protectServerAddr: string;
    /** 管理服务地址 */
    managementServerAddr: string;
    /** 调试模式开关 */
    debug: boolean;
};

/** 运行时环境 */
export type RuntimeStatus = {
    /** 实例唯一标识 */
    machineId: string;
    /** OpenClaw 版本号 */
    openclawVersion: string;
    /** 操作系统平台 */
    platform: string;
    /** CPU 架构 */
    arch: string;
    /** Node.js 版本 */
    nodeVersion: string;
    /** 插件初始化时间（ISO 格式） */
    initializedAt: string;
};

/** 运维视角响应 - 详细诊断 */
export type StatusResponse = {
    /** 插件名称 */
    name: string;
    /** 插件版本号 */
    version: string;
    /** 报告时间（ISO 格式） */
    timestamp: string;
    /** 各模块状态数据（key 为模块名，value 为模块状态） */
    [key: string]: unknown;
};

// ============================================================================
// Status Provider
// ============================================================================

/** 状态数据提供者函数 */
export type StatusProvider = () => unknown;
