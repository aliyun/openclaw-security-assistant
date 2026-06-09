import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

// ============================================================================
// SDK Version Constants
// ============================================================================

export const SDK_VERSION = "1.4.2";

// ============================================================================
// Plugin Configuration Types
// ============================================================================

export type OpenClawSecurityAssistantConfig = {
    /** 统一端点地址，作为 protectServerAddr 和 managementServerAddr 的默认值 */
    endpointAddr?: string;
    /** 保护服务地址（优先级高于 endpointAddr） */
    protectServerAddr?: string;
    /** 管理服务地址（优先级高于 endpointAddr） */
    managementServerAddr?: string;
    /** 调试模式（默认 false），开启后输出详细日志 */
    debug?: boolean;
};

export type ResolvedOpenClawSecurityAssistantConfig = {
    endpointAddr: string;
    protectServerAddr: string;
    managementServerAddr: string;
    debug: boolean;
};

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_CONFIG: ResolvedOpenClawSecurityAssistantConfig = {
    endpointAddr: "https://cn-shanghai.agent-security.aliyuncs.com",
    protectServerAddr: "",
    managementServerAddr: "",
    debug: false,
};

// ============================================================================
// Configuration Validation Helpers
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidUrl(value: string): boolean {
    try {
        new URL(value);
        return true;
    } catch {
        return false;
    }
}

// ============================================================================
// Configuration Parsing
// ============================================================================

type ParseResult =
    | { ok: true; value: OpenClawSecurityAssistantConfig | undefined }
    | { ok: false; message: string };

function parseOpenClawSecurityAssistantConfig(value: unknown): ParseResult {
    if (value === undefined) {
        return { ok: true, value: undefined };
    }
    if (!isRecord(value)) {
        return { ok: false, message: "expected config object" };
    }

    const allowedKeys = new Set(["endpointAddr", "protectServerAddr", "managementServerAddr", "debug"]);
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
            return { ok: false, message: `unknown config key: ${key}` };
        }
    }

    const endpointAddr = value.endpointAddr;
    if (
        endpointAddr !== undefined &&
        (typeof endpointAddr !== "string" || endpointAddr.trim() === "")
    ) {
        return { ok: false, message: "endpointAddr must be a non-empty string" };
    }
    if (endpointAddr !== undefined && !isValidUrl(endpointAddr as string)) {
        return { ok: false, message: "endpointAddr must be a valid URL" };
    }

    const protectServerAddr = value.protectServerAddr;
    if (
        protectServerAddr !== undefined &&
        (typeof protectServerAddr !== "string" || protectServerAddr.trim() === "")
    ) {
        return { ok: false, message: "protectServerAddr must be a non-empty string" };
    }
    if (protectServerAddr !== undefined && !isValidUrl(protectServerAddr as string)) {
        return { ok: false, message: "protectServerAddr must be a valid URL" };
    }

    const managementServerAddr = value.managementServerAddr;
    if (
        managementServerAddr !== undefined &&
        (typeof managementServerAddr !== "string" || managementServerAddr.trim() === "")
    ) {
        return { ok: false, message: "managementServerAddr must be a non-empty string" };
    }
    if (managementServerAddr !== undefined && !isValidUrl(managementServerAddr as string)) {
        return { ok: false, message: "managementServerAddr must be a valid URL" };
    }

    const debug = value.debug;
    if (debug !== undefined && typeof debug !== "boolean") {
        return { ok: false, message: "debug must be a boolean" };
    }

    return {
        ok: true,
        value: {
            endpointAddr: typeof endpointAddr === "string" ? endpointAddr.trim() : undefined,
            protectServerAddr: typeof protectServerAddr === "string" ? protectServerAddr.trim() : undefined,
            managementServerAddr: typeof managementServerAddr === "string" ? managementServerAddr.trim() : undefined,
            debug: typeof debug === "boolean" ? debug : undefined,
        },
    };
}

// ============================================================================
// Configuration Schema Factory
// ============================================================================

export function createOpenClawSecurityAssistantConfigSchema(): OpenClawPluginConfigSchema {
    return {
        safeParse(value: unknown):
            | { success: true; data?: unknown }
            | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } } {
            const parsed = parseOpenClawSecurityAssistantConfig(value);
            if (parsed.ok) {
                return { success: true, data: parsed.value };
            }
            return {
                success: false,
                error: {
                    issues: [{ path: [], message: parsed.message }],
                },
            };
        },
        jsonSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                endpointAddr: { type: "string", default: DEFAULT_CONFIG.endpointAddr },
                protectServerAddr: { type: "string", default: DEFAULT_CONFIG.protectServerAddr },
                managementServerAddr: { type: "string", default: DEFAULT_CONFIG.managementServerAddr },
                debug: { type: "boolean", default: DEFAULT_CONFIG.debug },
            },
        },
    };
}

// ============================================================================
// Configuration Resolution
// ============================================================================

export function resolveOpenClawSecurityAssistantConfig(rawConfig: unknown): ResolvedOpenClawSecurityAssistantConfig {
    const parsed = parseOpenClawSecurityAssistantConfig(rawConfig);
    if (!parsed.ok) {
        throw new Error(parsed.message);
    }
    const normalized = parsed.value ?? {};
    // endpointAddr 作为 protectServerAddr 和 managementServerAddr 的默认值
    const endpointAddr = normalized.endpointAddr ?? DEFAULT_CONFIG.endpointAddr;
    return {
        endpointAddr,
        protectServerAddr: normalized.protectServerAddr ?? endpointAddr,
        managementServerAddr: normalized.managementServerAddr ?? endpointAddr,
        debug: normalized.debug ?? DEFAULT_CONFIG.debug,
    };
}
