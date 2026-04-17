/**
 * 插件运行时上下文管理
 *
 * 管理插件生命周期内的静态运行时信息，避免重复采集。
 * 包括：系统信息、Node 运行时信息、OpenClaw 版本号、Machine ID、Agent ID。
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { SystemInfo, NodeRuntimeInfo, OpenClawInfo } from "./types.js";
import { logDebug, logWarn } from "./logger.js";

// Re-export for convenience
export type { OpenClawInfo };

// ============================================================================
// Runtime Context Types
// ============================================================================

/** 插件运行时上下文（静态信息，启动后不变，agentId 在认证后设置） */
export type PluginRuntimeContext = {
    /** Agent 唯一标识（认证成功后从 JWT sub 获取） */
    agentId?: string;
    /** OpenClaw 实例唯一标识（基于 machine_id + gateway_port 生成） */
    machineId: string;
    /** 安装密钥（从本地文件读取） */
    installKey: string | null;
    /** 系统信息 */
    system: SystemInfo;
    /** Node 运行时信息 */
    nodeRuntime: NodeRuntimeInfo;
    /** OpenClaw 运行时信息 */
    openclaw: OpenClawInfo;
    /** 初始化时间戳（ISO 格式） */
    initializedAt: string;
};

// ============================================================================
// Singleton Runtime Context
// ============================================================================

let runtimeContext: PluginRuntimeContext | null = null;

/** 缓存的 Agent Runtime 标识 */
let cachedAgentRuntime: string | null = null;

// ============================================================================
// Initialization Functions
// ============================================================================

/**
 * 采集系统信息（仅在初始化时调用一次）
 */
function collectSystemInfo(): SystemInfo {
    const platform = os.platform();
    const arch = os.arch();
    const hostname = os.hostname();

    // 获取系统版本
    let os_version: string | undefined;
    try {
        os_version = os.release();
    } catch {
        os_version = undefined;
    }

    // 获取主机 IP 地址（取第一个非内部 IPv4 地址）
    let ip: string | undefined;
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            const nets = interfaces[name];
            if (!nets) continue;
            for (const net of nets) {
                // 跳过内部地址和 IPv6
                if (!net.internal && net.family === "IPv4") {
                    ip = net.address;
                    break;
                }
            }
            if (ip) break;
        }
    } catch {
        ip = undefined;
    }

    return {
        platform,
        arch,
        os_version,
        hostname,
        ip,
    };
}

/**
 * 采集 Node 运行时信息（仅在初始化时调用一次）
 */
function collectNodeRuntimeInfo(): NodeRuntimeInfo {
    return {
        version: process.version,
        exec_path: process.execPath,
    };
}

// ============================================================================
// Machine ID Generation
// ============================================================================

/** 读取原始机器 ID 的超时时间 */
const MACHINE_ID_TIMEOUT_MS = 5_000;

/**
 * 读取平台原始机器 ID（使用完整路径，避免 PATH 缺失问题）
 *
 * - macOS: /usr/sbin/ioreg 读取 IOPlatformUUID
 * - Linux: 直接读取 /etc/machine-id（无需 shell）
 * - Windows: reg query 读取 MachineGuid
 */
function readRawMachineId(): string {
    const platform = process.platform;

    if (platform === "darwin") {
        const output = execSync(
            "/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice",
            { encoding: "utf-8", timeout: MACHINE_ID_TIMEOUT_MS },
        );
        const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        if (match?.[1]) return match[1];
        throw new Error("Failed to parse IOPlatformUUID from ioreg output");
    }

    if (platform === "linux") {
        // 最高优先：从 wuying runtime.ini 中读取 DesktopId
        try {
            const runtimeIni = fs.readFileSync(
                "/etc/cloudstream/runtime.ini",
                "utf-8",
            );
            const iniMatch = runtimeIni.match(
                /^DesktopId\s*=\s*(.+)$/m,
            );
            if (iniMatch?.[1]) return iniMatch[1].trim();
            logDebug("runtime", "machine_id_runtime_ini_no_desktop_id", {
                reason: "DesktopId field not found in runtime.ini",
            });
        } catch (err) {
            logDebug("runtime", "machine_id_runtime_ini_unavailable", {
                reason: err instanceof Error ? err.message : String(err),
            });
        }
        // 次优先：从 cloud-init nocloud meta-data 中读取 desktop-id
        try {
            const metaData = fs.readFileSync(
                "/var/lib/cloud/seed/nocloud/meta-data",
                "utf-8",
            );
            const match = metaData.match(/^desktop-id:\s*(.+)$/m);
            if (match?.[1]) return match[1].trim();
            logDebug("runtime", "machine_id_nocloud_no_desktop_id", {
                reason: "desktop-id field not found in meta-data",
            });
        } catch (err) {
            logDebug("runtime", "machine_id_nocloud_unavailable", {
                reason: err instanceof Error ? err.message : String(err),
            });
        }
        // fallback: 读取标准 machine-id 文件
        try {
            return fs.readFileSync("/etc/machine-id", "utf-8").trim();
        } catch (err) {
            logDebug("runtime", "machine_id_etc_unavailable", {
                reason: err instanceof Error ? err.message : String(err),
                fallback: "/var/lib/dbus/machine-id",
            });
            return fs.readFileSync("/var/lib/dbus/machine-id", "utf-8").trim();
        }
    }

    if (platform === "win32") {
        const systemRoot = process.env.SystemRoot || "C:\\Windows";
        const regPath = path.join(systemRoot, "System32", "reg.exe");
        const output = execSync(
            `"${regPath}" query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid`,
            { encoding: "utf-8", timeout: MACHINE_ID_TIMEOUT_MS },
        );
        const match = output.match(/MachineGuid\s+REG_SZ\s+(.+)/);
        if (match?.[1]) return match[1].trim();
        throw new Error("Failed to read MachineGuid from registry");
    }

    throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * 生成 Machine ID（基于机器 ID + gateway port）
 *
 * 策略：
 * 1. 使用 readRawMachineId() 通过完整路径读取系统机器 ID
 * 2. 全部失败后使用 hostname + port 生成确定性 fallback（同一台机器始终相同）
 */
function generateMachineId(gatewayPort: number | undefined): string {
    const port = gatewayPort ?? 18789;

    try {
        const rawMachineId = readRawMachineId();
        const combined = `${rawMachineId}:${port}`;
        const hash = crypto.createHash("sha256").update(combined).digest("hex");
        return `mid_${hash}`;
    } catch (err) {
        // 使用 hostname 生成确定性 fallback
        logWarn("runtime", "generate_machine_id_failed", { error: String(err) });
        const hostname = os.hostname() || "unknown-host";
        const combined = `hostname:${hostname}:${port}`;
        const hash = crypto.createHash("sha256").update(combined).digest("hex");
        return `mid_${hash}`;
    }
}

/**
 * 读取 install_key 文件
 */
function readInstallKey(pluginDir: string): string | null {
    const installKeyFile = path.join(pluginDir, ".install_key");

    try {
        if (!fs.existsSync(installKeyFile)) {
            return null;
        }

        const installKey = fs.readFileSync(installKeyFile, "utf-8").trim();
        return installKey || null;
    } catch {
        return null;
    }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 初始化运行时上下文（插件启动时调用一次）
 */
export function initializeRuntimeContext(
    runtime: PluginRuntime,
    config: OpenClawConfig,
    pluginDir: string,
): PluginRuntimeContext {
    if (runtimeContext) {
        return runtimeContext;
    }

    const gatewayPort = config.gateway?.port;
    const version = config.meta?.lastTouchedVersion ?? "unknown";

    runtimeContext = {
        machineId: generateMachineId(gatewayPort),
        installKey: readInstallKey(pluginDir),
        system: collectSystemInfo(),
        nodeRuntime: collectNodeRuntimeInfo(),
        openclaw: { version },
        initializedAt: new Date().toISOString(),
    };

    cachedAgentRuntime = `openclaw@${version}`;

    return runtimeContext;
}

/**
 * 获取运行时上下文（需先调用 initializeRuntimeContext）
 */
export function getRuntimeContext(): PluginRuntimeContext {
    if (!runtimeContext) {
        throw new Error(
            "Runtime context not initialized. Call initializeRuntimeContext() first.",
        );
    }
    return runtimeContext;
}

/**
 * 设置 Agent ID（认证成功后调用）
 */
export function setAgentId(agentId: string): void {
    if (!runtimeContext) {
        throw new Error(
            "Runtime context not initialized. Call initializeRuntimeContext() first.",
        );
    }
    runtimeContext.agentId = agentId;
}

/**
 * 检查运行时上下文是否已初始化
 */
export function isRuntimeContextInitialized(): boolean {
    return runtimeContext !== null;
}

/**
 * 获取 Agent Runtime 标识（基于 OpenClaw 版本）
 * 格式：openclaw@{version}
 */
export function getAgentRuntime(): string {
    return cachedAgentRuntime ?? "openclaw@unknown";
}
