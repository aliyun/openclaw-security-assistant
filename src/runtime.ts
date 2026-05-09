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
import type { SystemInfo, NodeRuntimeInfo, OpenClawInfo } from "./asset-types.js";
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

/** 持久化 raw machine ID 的文件名 */
const RAW_MACHINE_ID_FILENAME = ".oc_sec_raw_machine_id";

/**
 * 读取可信环境的 raw machine ID（仅 Linux wuying 场景）
 *
 * 优先级：
 * 1. 环境变量 INSTANCE_ID（ACS 容器场景，IS_ACS_INSTANCE=true 时）
 * 2. /etc/cloudstream/runtime.ini 中的 DesktopId（wuying 云桌面）
 * 3. /var/lib/cloud/seed/nocloud/meta-data 中的 desktop-id（cloud-init）
 *
 * @returns 可信 raw ID，不可用时返回 null
 */
function readTrustedRawId(): string | null {
    if (process.platform !== "linux") return null;

    // ACS 容器场景：通过环境变量获取 instance id
    if (process.env.IS_ACS_INSTANCE === "true") {
        const instanceId = process.env.INSTANCE_ID?.trim();
        if (instanceId) return instanceId;
        logDebug("runtime", "machine_id_acs_instance_id_empty", {
            reason: "IS_ACS_INSTANCE is true but INSTANCE_ID is empty or unset",
        });
    }

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

    return null;
}

/** 平台原生 machine ID 读取超时（毫秒） */
const MACHINE_ID_TIMEOUT_MS = 5_000;

/**
 * 读取平台原生 machine ID（兜底，不依赖文件持久化）
 *
 * - macOS: ioreg → IOPlatformUUID
 * - Linux: /etc/machine-id → /var/lib/dbus/machine-id
 * - Windows: Registry → MachineGuid
 *
 * @returns 平台原生 ID，不可用时返回 null
 */
function readPlatformMachineId(): string | null {
    const platform = process.platform;

    if (platform === "darwin") {
        try {
            const output = execSync(
                "/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice",
                { encoding: "utf-8", timeout: MACHINE_ID_TIMEOUT_MS },
            );
            const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
            if (match?.[1]) return match[1];
            logDebug("runtime", "machine_id_ioreg_parse_failed", {
                reason: "IOPlatformUUID not found in ioreg output",
            });
        } catch (err) {
            logDebug("runtime", "machine_id_ioreg_unavailable", {
                reason: err instanceof Error ? err.message : String(err),
            });
        }
        return null;
    }

    if (platform === "linux") {
        // /etc/machine-id（systemd 标准）
        try {
            const id = fs.readFileSync("/etc/machine-id", "utf-8").trim();
            if (id) return id;
        } catch (err) {
            logDebug("runtime", "machine_id_etc_unavailable", {
                reason: err instanceof Error ? err.message : String(err),
                fallback: "/var/lib/dbus/machine-id",
            });
        }
        // /var/lib/dbus/machine-id（dbus 兜底）
        try {
            const id = fs.readFileSync("/var/lib/dbus/machine-id", "utf-8").trim();
            if (id) return id;
        } catch (err) {
            logDebug("runtime", "machine_id_dbus_unavailable", {
                reason: err instanceof Error ? err.message : String(err),
            });
        }
        return null;
    }

    if (platform === "win32") {
        try {
            const systemRoot = process.env.SystemRoot || "C:\\Windows";
            const regPath = path.join(systemRoot, "System32", "reg.exe");
            const output = execSync(
                `"${regPath}" query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid`,
                { encoding: "utf-8", timeout: MACHINE_ID_TIMEOUT_MS },
            );
            const match = output.match(/MachineGuid\s+REG_SZ\s+(.+)/);
            if (match?.[1]) return match[1].trim();
            logDebug("runtime", "machine_id_registry_parse_failed", {
                reason: "MachineGuid not found in registry output",
            });
        } catch (err) {
            logDebug("runtime", "machine_id_registry_unavailable", {
                reason: err instanceof Error ? err.message : String(err),
            });
        }
        return null;
    }

    logDebug("runtime", "machine_id_unsupported_platform", { platform });
    return null;
}

/**
 * 按优先级获取 raw machine ID
 *
 * 策略（四层兜底）：
 * 1. 可信源优先（wuying/ACS）— 每次直接读取，不依赖文件缓存
 * 2. 读取已持久化的 raw ID 文件（stateDir/.oc_sec_raw_machine_id）
 * 3. 随机生成并持久化 — 仅持久化成功时返回，失败则降级
 * 4. 平台原生 machine ID — 稳定兜底，不依赖文件持久化
 */
function resolveRawMachineId(stateDir: string): string {
    // 1. 可信源优先（wuying/ACS）— 每次直接读，不依赖文件缓存
    const trusted = readTrustedRawId();
    if (trusted) return trusted;

    // 2. 读取已持久化的 raw ID
    const idFile = path.join(stateDir, RAW_MACHINE_ID_FILENAME);
    try {
        const existing = fs.readFileSync(idFile, "utf-8").trim();
        if (existing) return existing;
    } catch (err) {
        logDebug("runtime", "raw_machine_id_file_not_found", {
            path: idFile,
            action: "will generate and persist a new one",
        });
    }

    // 3. 随机生成并持久化 — 仅持久化成功时返回
    const generated = crypto.randomBytes(32).toString("hex");
    try {
        fs.writeFileSync(idFile, generated, "utf-8");
        return generated;
    } catch (err) {
        logWarn("runtime", "raw_machine_id_persist_failed", {
            error: err instanceof Error ? err.message : String(err),
            action: "falling back to platform machine ID",
        });
    }

    // 4. 平台原生 machine ID — 稳定兜底，不依赖文件持久化
    const platformId = readPlatformMachineId();
    if (platformId) return platformId;

    // 极端降级：所有来源都失败，使用 hostname
    const hostname = os.hostname() || "unknown-host";
    logWarn("runtime", "raw_machine_id_all_sources_failed", {
        action: "using hostname as last resort",
        hostname,
    });
    return `hostname:${hostname}`;
}

/**
 * 生成 Machine ID（基于 raw machine ID + gateway port）
 *
 * 最终格式：mid_<sha256-hex>
 */
function generateMachineId(stateDir: string, gatewayPort: number | undefined): string {
    const port = gatewayPort ?? 18789;
    const rawId = resolveRawMachineId(stateDir);
    logDebug("runtime", "raw_machine_id_resolved", { rawId });
    const combined = `${rawId}:${port}`;
    const hash = crypto.createHash("sha256").update(combined).digest("hex");
    return `mid_${hash}`;
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
    const stateDir = runtime.state.resolveStateDir();

    runtimeContext = {
        machineId: generateMachineId(stateDir, gatewayPort),
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
