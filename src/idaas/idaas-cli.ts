/**
 * IdaaS CLI 调用封装
 *
 * 封装对 alibaba-cloud-idaas CLI 工具的调用：
 * - access-token: 获取 IdaaS AccessToken（JWT），提取 payload 中的 user_id（sub 字段）
 * - put-secret: 将静态 API key 上传到 IdaaS Server 进行凭据托管
 * - get-secret: 获取/校验托管凭据
 *
 * 所有 agent 子命令均使用 --config 显式指定 IdaaS profile 路径。
 *
 * idaasDir = path.join(stateDir, IDAAS_PERSIST_DIR_NAME)，
 * CLI 二进制和 profile 均存放在该目录下。
 */

import { spawnSync } from "node:child_process";
import { logDebug, logInfo, logWarn, logError } from "../logger.js";
import { resolveCliPath, resolveProfilePath } from "./idaas-paths.js";

// Re-export resolveProfilePath for backward compat (used by idaas-access-token-service, etc.)
export { resolveProfilePath } from "./idaas-paths.js";

/** CLI 调用超时（毫秒） */
const DEFAULT_CLI_TIMEOUT_MS = 30_000;

// ──────────────── Helpers ────────────────

/**
 * 解析 JWT payload（base64url 解码中间部分）
 */
function parseJwtPayload(jwt: string): Record<string, unknown> | null {
    const parts = jwt.trim().split(".");
    if (parts.length !== 3) return null;
    try {
        const decoded = Buffer.from(parts[1], "base64url").toString("utf-8");
        return JSON.parse(decoded) as Record<string, unknown>;
    } catch {
        return null;
    }
}

// ──────────────── Types ────────────────

/** JWT payload 类型 */
export type JwtPayload = Record<string, unknown> & { sub?: string };

/** AccessToken 获取结果 */
export type AccessTokenResult = {
    success: boolean;
    /** JWT payload（包含 sub 等字段） */
    payload?: JwtPayload;
    /** 原始 JWT 字符串 */
    rawToken?: string;
    error?: string;
};

/** put-secret 结果（返回值格式待确认，暂做简易处理） */
export type PutSecretResult = {
    success: boolean;
    error?: string;
    /** CLI 原始输出（用于调试） */
    rawOutput?: string;
};

/** get-secret 响应中单条结果 */
type GetSecretEntry = {
    success: boolean;
    message: string;
    value?: {
        apiKeyContent?: { apiKey?: string } | null;
        oauthClientContent?: unknown;
    };
};

/** get-secret 结果 */
export type GetSecretResult = {
    success: boolean;
    apiKey?: string;
    error?: string;
    rawOutput?: string;
};

/**
 * 检查 idaas-cli 是否可用
 */
export function isCliAvailable(idaasDir: string): boolean {
    const cliPath = resolveCliPath(idaasDir);
    try {
        // CLI 使用 "version" 子命令（不是 --version flag）
        const result = spawnSync(cliPath, ["version"], {
            encoding: "utf-8",
            timeout: 5_000,
            stdio: ["ignore", "pipe", "pipe"],
        });

        if (result.error) {
            logDebug("idaas_cli", "not_available", {
                error: result.error.message,
                code: (result.error as NodeJS.ErrnoException).code,
            });
            return false;
        }

        logDebug("idaas_cli", "available", {
            version: result.stdout?.trim(),
        });
        return result.status === 0;
    } catch (e: unknown) {
        logDebug("idaas_cli", "check_error", {
            error: String(e instanceof Error ? e.message : e),
        });
        return false;
    }
}

/**
 * 获取 IdaaS AccessToken
 *
 * 执行 `alibaba-cloud-idaas agent access-token --config <profile>`，
 * 返回的 JWT payload 中包含 sub（user_id）字段。
 */
export function fetchAccessToken(params: {
    idaasDir: string;
    timeoutMs?: number;
}): AccessTokenResult {
    const { idaasDir, timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = params;
    const cliPath = resolveCliPath(idaasDir);
    const profilePath = resolveProfilePath(idaasDir);

    logDebug("idaas_cli", "access_token_start", { cliPath, profilePath });

    try {
        const result = spawnSync(
            cliPath,
            ["agent", "access-token", "--config", profilePath],
            {
                encoding: "utf-8",
                timeout: timeoutMs,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        if (result.error) {
            logError("idaas_cli", "access_token_spawn_error", {
                error: result.error.message,
                code: (result.error as NodeJS.ErrnoException).code,
            });
            return { success: false, error: result.error.message };
        }

        if (result.status !== 0) {
            const stderr = result.stderr?.trim() ?? "";
            logError("idaas_cli", "access_token_exit_error", {
                status: result.status,
                stderr,
            });
            return { success: false, error: stderr || `exit code ${result.status}` };
        }

        const rawToken = result.stdout?.trim();
        if (!rawToken) {
            logError("idaas_cli", "access_token_empty", {});
            return { success: false, error: "CLI returned empty access token" };
        }

        const payload = parseJwtPayload(rawToken);
        if (!payload) {
            logError("idaas_cli", "access_token_parse_failed", {
                tokenPreview: rawToken.substring(0, 50) + "...",
            });
            return { success: false, error: "Failed to parse JWT payload" };
        }

        logInfo("idaas_cli", "access_token_success", {
            sub: payload.sub,
            iss: payload.iss,
            exp: payload.exp,
        });

        return { success: true, payload: payload as JwtPayload, rawToken };
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logError("idaas_cli", "access_token_exception", { error: errorMsg });
        return { success: false, error: errorMsg };
    }
}

/**
 * 将凭据上传到 IdaaS Server 进行托管
 *
 * 执行 `alibaba-cloud-idaas agent put-secret --config <profile> --name <credentialId> --value <apiKey>`。
 *
 * 注意：--value 会将 apiKey 暴露在进程参数中，但 CLI 未提供 stdin 传入方式。
 *
 * 注意：返回值格式待确认，暂做简易处理并记录原始输出。
 */
export function putSecret(params: {
    idaasDir: string;
    credentialId: string;
    aegisId: string;
    apiKey: string;
    timeoutMs?: number;
}): PutSecretResult {
    const { idaasDir, credentialId, aegisId, apiKey, timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = params;
    const cliPath = resolveCliPath(idaasDir);
    const profilePath = resolveProfilePath(idaasDir);

    logDebug("idaas_cli", "put_secret_start", { credentialId, aegisId, cliPath, profilePath });

    try {
        const result = spawnSync(
            cliPath,
            ["agent", "put-secret", "--config", profilePath, "--name", credentialId, "--external-identifier", aegisId, "--value", apiKey],
            {
                encoding: "utf-8",
                timeout: timeoutMs,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        const rawOutput = result.stdout?.trim() ?? "";

        if (result.error) {
            logError("idaas_cli", "put_secret_spawn_error", {
                credentialId,
                error: result.error.message,
                code: (result.error as NodeJS.ErrnoException).code,
            });
            return { success: false, error: result.error.message, rawOutput };
        }

        if (result.status !== 0) {
            const stderr = result.stderr?.trim() ?? "";
            logError("idaas_cli", "put_secret_exit_error", {
                credentialId,
                status: result.status,
                stderr,
                rawOutput,
            });
            return { success: false, error: stderr || `exit code ${result.status}`, rawOutput };
        }

        // 返回值格式待确认，暂时记录原始输出供调试
        logDebug("idaas_cli", "put_secret_success", {
            credentialId,
            rawOutput,
        });

        return { success: true, rawOutput };
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logError("idaas_cli", "put_secret_exception", { credentialId, error: errorMsg });
        return { success: false, error: errorMsg };
    }
}

/**
 * 获取/校验托管凭据
 *
 * 执行 `alibaba-cloud-idaas agent get-secret --config <profile> --name <credentialId>`，
 * 解析 JSON 响应，提取 apiKey 或错误信息。
 */
export function getSecret(params: {
    idaasDir: string;
    credentialId: string;
    timeoutMs?: number;
}): GetSecretResult {
    const { idaasDir, credentialId, timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = params;
    const cliPath = resolveCliPath(idaasDir);
    const profilePath = resolveProfilePath(idaasDir);

    logDebug("idaas_cli", "get_secret_start", { credentialId, cliPath, profilePath });

    try {
        const result = spawnSync(
            cliPath,
            ["agent", "get-secret", "--config", profilePath, "--name", credentialId],
            {
                encoding: "utf-8",
                timeout: timeoutMs,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        const rawOutput = result.stdout?.trim() ?? "";

        if (result.error) {
            logWarn("idaas_cli", "get_secret_spawn_error", {
                credentialId,
                error: result.error.message,
                code: (result.error as NodeJS.ErrnoException).code,
            });
            return { success: false, error: result.error.message, rawOutput };
        }

        if (result.status !== 0) {
            const stderr = result.stderr?.trim() ?? "";
            logWarn("idaas_cli", "get_secret_exit_error", {
                credentialId,
                status: result.status,
                stderr,
                rawOutput,
            });
            return { success: false, error: stderr || `exit code ${result.status}`, rawOutput };
        }

        if (!rawOutput) {
            logWarn("idaas_cli", "get_secret_empty", { credentialId });
            return { success: false, error: "CLI returned empty output" };
        }

        // 解析 JSON 响应（带运行时格式验证）
        let parsed: Record<string, unknown>;
        try {
            const raw = JSON.parse(rawOutput);
            if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
                logWarn("idaas_cli", "get_secret_unexpected_format", { credentialId, rawOutput });
                return { success: false, error: "Unexpected CLI response format (not a plain object)", rawOutput };
            }
            parsed = raw as Record<string, unknown>;
        } catch {
            logWarn("idaas_cli", "get_secret_parse_error", { credentialId, rawOutput });
            return { success: false, error: "Failed to parse CLI JSON output", rawOutput };
        }

        // 取第一个 key 的结果
        const entries = Object.values(parsed) as GetSecretEntry[];
        if (entries.length === 0) {
            logWarn("idaas_cli", "get_secret_empty_response", { credentialId, rawOutput });
            return { success: false, error: "Empty response object", rawOutput };
        }

        const entry = entries[0];
        if (!entry.success) {
            logWarn("idaas_cli", "get_secret_not_found", {
                credentialId,
                message: entry.message,
            });
            return { success: false, error: entry.message || "Secret not found", rawOutput };
        }

        const apiKey = entry.value?.apiKeyContent?.apiKey;
        logDebug("idaas_cli", "get_secret_success", {
            credentialId,
            hasApiKey: !!apiKey,
        });

        return { success: true, apiKey: apiKey ?? undefined, rawOutput };
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logWarn("idaas_cli", "get_secret_exception", { credentialId, error: errorMsg });
        return { success: false, error: errorMsg };
    }
}
