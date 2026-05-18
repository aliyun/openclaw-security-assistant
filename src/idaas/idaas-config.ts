/**
 * IdaaS 配置持久化模块
 *
 * 处理服务端下发的 IdaaS 配置：
 * 1. 将 profile 配置写入本地 JSON 文件
 * 2. 根据当前 OS/arch 下载 IdaaS CLI 二进制文件（异步流式写入，不阻塞主线程）
 *
 * 所有 IdaaS 文件统一持久化到 {stateDir}/alicloud-idaas/ 目录下，
 * 包括 profile JSON、CLI 二进制、exec resolver 脚本、备份清单等。
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { logDebug, logInfo, logWarn, logError } from "../logger.js";
import { getRuntimeContext } from "../runtime.js";
import type { IdaasServerConfig } from "../config-sync-types.js";
import {
    IDAAS_CLI_FILENAME,
    IDAAS_PROFILE_FILENAME,
    resolveIdaasPersistDir,
} from "./idaas-paths.js";

// Re-export for backward compat (used by access-token-service, hosting-service, etc.)
export { IDAAS_PERSIST_DIR_NAME, resolveIdaasPersistDir } from "./idaas-paths.js";

// ============================================================================
// Private Constants
// ============================================================================

/** CLI 下载超时（毫秒） */
const CLI_DOWNLOAD_TIMEOUT_MS = 120_000;

/** CLI sha256 校验文件 URL 后缀（服务端在 {downloadUrl}.sha256 提供摘要） */
const CLI_SHA256_URL_SUFFIX = ".sha256";

/** CLI sha256 文件下载超时 */
const CLI_SHA256_FETCH_TIMEOUT_MS = 10_000;

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * 持久化 IdaaS profile 配置到本地文件
 *
 * profile 内容不做严格校验，具体逻辑由 CLI 检查中实现。
 * 写入路径：{stateDir}/alicloud-idaas/alibaba-cloud-idaas.json
 */
async function persistIdaasProfile(idaasDir: string, profile: Record<string, unknown>): Promise<boolean> {
    try {
        await fs.mkdir(idaasDir, { recursive: true });
        const filePath = path.join(idaasDir, IDAAS_PROFILE_FILENAME);
        await fs.writeFile(filePath, JSON.stringify(profile, null, 2), "utf-8");

        logInfo("idaas_config", "profile_saved", { path: filePath });
        return true;
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logError("idaas_config", "profile_save_failed", { error: errorMsg });
        return false;
    }
}

/**
 * 根据当前 OS 和 arch 选择 CLI 下载 URL
 */
function resolveCliDownloadUrl(
    cliUrl: Record<string, Record<string, string>>,
): string | null {
    const { system } = getRuntimeContext();
    const platform = system.platform;
    const arch = system.arch;

    logDebug("idaas_config", "resolve_cli_url", { platform, arch });

    // 映射 Node.js platform 到服务端 key
    let osKey: string;
    if (platform === "linux") {
        osKey = "linux";
    } else if (platform === "darwin") {
        osKey = "darwin";
    } else if (platform === "win32") {
        osKey = "windows";
    } else {
        logWarn("idaas_config", "unsupported_platform", { platform });
        return null;
    }

    // 映射 Node.js arch 到服务端 key
    let archKey: string;
    if (arch === "x64") {
        archKey = "amd64";
    } else if (arch === "arm64") {
        archKey = "arm64";
    } else {
        logWarn("idaas_config", "unsupported_arch", { arch });
        return null;
    }

    const osUrls = cliUrl[osKey];
    if (!osUrls) {
        logWarn("idaas_config", "no_cli_url_for_os", { os: osKey, available: Object.keys(cliUrl) });
        return null;
    }

    const url = osUrls[archKey];
    if (!url) {
        logWarn("idaas_config", "no_cli_url_for_arch", {
            os: osKey,
            arch: archKey,
            available: Object.keys(osUrls),
        });
        return null;
    }

    return url;
}

/**
 * 拉取服务端提供的 CLI sha256 摘要文件
 *
 * URL 规则：`${downloadUrl}${CLI_SHA256_URL_SUFFIX}`，内容为 64 位 hex 摘要。
 * 拿不到（404 / 网络失败 / 空 body）返回 null，由调用方视为完整性失败。
 * 不做 hex 格式正则校验：服务端可信，直接 trim + toLowerCase 后透传，
 * 后续与本地计算摘要做 === 比对即可暴露任何异常内容。
 */
async function fetchExpectedSha256(
    downloadUrl: string,
    originalFetch: typeof globalThis.fetch,
): Promise<string | null> {
    const sha256Url = `${downloadUrl}${CLI_SHA256_URL_SUFFIX}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), CLI_SHA256_FETCH_TIMEOUT_MS);
    try {
        const resp = await originalFetch(sha256Url, { signal: controller.signal });
        if (!resp.ok) {
            logError("idaas_config", "sha256_fetch_http_error", {
                url: sha256Url,
                status: resp.status,
                statusText: resp.statusText,
            });
            return null;
        }
        const text = await resp.text();
        const normalized = text.trim().toLowerCase();
        if (normalized.length === 0) {
            logError("idaas_config", "sha256_fetch_empty", { url: sha256Url });
            return null;
        }
        return normalized;
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logError("idaas_config", "sha256_fetch_failed", { url: sha256Url, error: errorMsg });
        return null;
    } finally {
        clearTimeout(t);
    }
}

/**
 * 流式计算文件的 sha256（hex 小写）
 *
 * 使用 pipeline(createReadStream, hash)，避免把 30MB 二进制读进内存。
 */
async function computeFileSha256(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    await pipeline(createReadStream(filePath), hash);
    return hash.digest("hex");
}

/**
 * 下载 IdaaS CLI 到本地（含 SHA256 快速路径）
 *
 * 调度流程：
 *   0. 确保 idaasDir 存在
 *   1. 拉取服务端 `{downloadUrl}.sha256` 获取期望摘要，拿不到即视为
 *      完整性失败（不降级），直接返回 false
 *   2. 快速路径：若本地 cliPath 已存在且 sha256 与服务端一致，
 *      兜底 chmod 0o755 后直接复用，跳过下载
 *   3. 否则走完整下载流程 performCliDownload，复用已拉到的 expectedHash
 *      避免二次请求
 *
 * 下载路径：{stateDir}/alicloud-idaas/alibaba-cloud-idaas
 */
async function downloadIdaasCli(
    idaasDir: string,
    downloadUrl: string,
    originalFetch: typeof globalThis.fetch,
): Promise<boolean> {
    const cliPath = path.join(idaasDir, IDAAS_CLI_FILENAME);

    try {
        await fs.mkdir(idaasDir, { recursive: true });

        // 1. 先拉期望摘要，拿不到则不做下载也不做比对
        const expectedHash = await fetchExpectedSha256(downloadUrl, originalFetch);
        if (expectedHash === null) {
            logError("idaas_config", "cli_integrity_sha256_unavailable", { url: downloadUrl });
            return false;
        }

        // 2. 快速路径：本地已有文件且 hash 一致 → 跳过下载
        let localHash: string | null = null;
        try {
            await fs.access(cliPath);
            localHash = await computeFileSha256(cliPath);
        } catch {
            // 本地不存在或不可读，localHash 保持 null，走完整下载流程
        }

        if (localHash !== null && localHash === expectedHash) {
            // 兜底执行权限：防止历史残留无 x 权限的二进制
            await fs.chmod(cliPath, 0o755).catch(() => {});
            logInfo("idaas_config", "cli_skip_download_up_to_date", {
                sha256: expectedHash,
                cliPath,
            });
            return true;
        }

        logDebug("idaas_config", "cli_download_reason", {
            reason: localHash === null ? "missing" : "hash_mismatch",
            localHash,
            expectedHash,
        });

        // 3. 走完整下载流程，复用已拉到的 expectedHash
        return await performCliDownload(idaasDir, downloadUrl, originalFetch, expectedHash);
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logError("idaas_config", "cli_download_failed", {
            error: errorMsg,
        });
        return false;
    }
}

/**
 * 完整下载 + 校验 + 归档 + 原子切换流程
 *
 * 使用 stream pipeline 将 HTTP 响应体直接流式写入磁盘，
 * 避免将整个二进制文件（~30MB）加载到内存后再同步写入。
 *
 * 安全切换流程（参考 persistAccessToken 的原子写模式）：
 *   1. 下载到临时文件 {cliPath}.tmp
 *   2. 完整性校验：tmp 非空；使用传入的 expectedHash 比对 tmp 的 sha256
 *   3. 归档现有文件 {cliPath} → {cliPath}.archived
 *   4. rename 临时文件 → {cliPath}
 * 任一步失败只清理 tmp 残留，保留原有有效 CLI 二进制；若归档后 rename
 * 失败，尝试将归档文件恢复为正式路径。
 */
async function performCliDownload(
    idaasDir: string,
    downloadUrl: string,
    originalFetch: typeof globalThis.fetch,
    expectedHash: string,
): Promise<boolean> {
    const cliPath = path.join(idaasDir, IDAAS_CLI_FILENAME);
    const tmpPath = `${cliPath}.tmp`;
    const archivedPath = `${cliPath}.archived`;

    try {
        logDebug("idaas_config", "cli_download_start", { url: downloadUrl, dest: cliPath });

        // 清理上次可能残留的 tmp，避免 createWriteStream 追加到旧内容
        await fs.unlink(tmpPath).catch(() => {});

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), CLI_DOWNLOAD_TIMEOUT_MS);

        try {
            const resp = await originalFetch(downloadUrl, {
                signal: controller.signal,
            });

            if (!resp.ok) {
                logError("idaas_config", "cli_download_http_error", {
                    status: resp.status,
                    statusText: resp.statusText,
                });
                return false;
            }

            if (!resp.body) {
                logError("idaas_config", "cli_download_no_body", {});
                return false;
            }

            // 1. 流式写入到临时文件（不直接写目标路径，避免破坏已有的有效二进制）
            const writeStream = createWriteStream(tmpPath);
            const readable = Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream);
            await pipeline(readable, writeStream);
        } finally {
            clearTimeout(t);
        }

        // 2. 完整性校验
        // 2.1 tmp 必须非空（廉价前置 sanity check）
        const tmpStat = await fs.stat(tmpPath);
        if (tmpStat.size === 0) {
            logError("idaas_config", "cli_download_empty_file", { tmpPath });
            await fs.unlink(tmpPath).catch(() => {});
            return false;
        }

        // 2.2 对 tmp 计算 sha256 并与传入的 expectedHash 比对
        const actualHash = await computeFileSha256(tmpPath);
        if (actualHash !== expectedHash) {
            logError("idaas_config", "cli_sha256_mismatch", {
                expected: expectedHash,
                actual: actualHash,
            });
            await fs.unlink(tmpPath).catch(() => {});
            return false;
        }

        // 设置可执行权限（在 tmp 上设置，rename 后权限保留）
        // Windows 上 .exe 不需要 chmod，但此处下载的是无后缀二进制，
        // 在 Unix 系统需要 0o755，Windows 上 chmod 调用无实际效果但也不会报错
        await fs.chmod(tmpPath, 0o755);

        // 3. 归档现有文件（若存在），避免直接覆盖丢失上一版可用二进制
        let archived = false;
        try {
            await fs.access(cliPath);
            // 清理可能存在的旧归档，避免 rename 在 Windows 上因目标已存在而失败
            await fs.unlink(archivedPath).catch(() => {});
            await fs.rename(cliPath, archivedPath);
            archived = true;
            logDebug("idaas_config", "cli_archived_old", { archivedPath });
        } catch {
            // cliPath 不存在，首次下载或此前被清理过，直接进入 rename 阶段
        }

        // 4. 原子切换：tmp → final
        try {
            await fs.rename(tmpPath, cliPath);
        } catch (renameErr) {
            // 切换失败，尝试将归档文件恢复为正式路径，避免留下无可用 CLI 的状态
            if (archived) {
                await fs.rename(archivedPath, cliPath).catch(() => {});
            }
            throw renameErr;
        }

        const stat = await fs.stat(cliPath);
        logInfo("idaas_config", "cli_download_success", {
            dest: cliPath,
            size: stat.size,
        });
        return true;
    } catch (e: unknown) {
        const errorMsg = String(e instanceof Error ? e.message : e);
        logError("idaas_config", "cli_download_failed", {
            error: errorMsg,
        });
        // 仅清理 tmp 残留，保留现有有效 CLI 二进制不被误删
        await fs.unlink(tmpPath).catch(() => {});
        return false;
    }
}

// ============================================================================
// Public Entry
// ============================================================================

/**
 * 处理服务端下发的 IdaaS 配置
 *
 * 由 config-sync-service 在拉取到 idaas 配置后委派调用，负责：
 * 1. 持久化 config（含 profile）到本地 JSON 文件
 * 2. 根据 OS/arch 下载 CLI 二进制文件
 *
 * 所有文件统一写入 {stateDir}/alicloud-idaas/ 目录。
 *
 * @param stateDir - OpenClaw state 目录（如 ~/.openclaw）
 * @param idaasConfig - 服务端下发的 IdaaS 配置
 * @param originalFetch - 原始 fetch（未被拦截的）
 */
export async function processIdaasConfig(params: {
    stateDir: string;
    idaasConfig: IdaasServerConfig;
    originalFetch: typeof globalThis.fetch;
}): Promise<void> {
    const { stateDir, idaasConfig, originalFetch } = params;
    const idaasDir = resolveIdaasPersistDir(stateDir);

    logDebug("idaas_config", "processing", {
        hasConfig: !!idaasConfig.config,
        hasCliUrl: !!idaasConfig.cli_url,
        hasAiscAppId: !!idaasConfig.aisc_app_id,
        configKeys: Object.keys(idaasConfig),
        idaasDir,
    });

    // 1. 持久化 config（含 version / current_profile / profile）
    if (idaasConfig.config && typeof idaasConfig.config === "object") {
        await persistIdaasProfile(idaasDir, idaasConfig.config as Record<string, unknown>);
    }

    // 2. 下载 CLI
    if (idaasConfig.cli_url && typeof idaasConfig.cli_url === "object") {
        logDebug("idaas_config", "cli_url_present", {
            osKeys: Object.keys(idaasConfig.cli_url),
        });
        const downloadUrl = resolveCliDownloadUrl(idaasConfig.cli_url);
        if (downloadUrl) {
            await downloadIdaasCli(idaasDir, downloadUrl, originalFetch);
        } else {
            logWarn("idaas_config", "cli_url_no_match", {
                message: "resolveCliDownloadUrl returned null, no matching platform/arch",
            });
        }
    } else {
        logWarn("idaas_config", "cli_url_missing", {
            message: "server config does not contain cli_url, CLI download skipped",
            cliUrlType: typeof idaasConfig.cli_url,
            cliUrlValue: idaasConfig.cli_url === undefined ? "undefined" : idaasConfig.cli_url === null ? "null" : "other-falsy",
        });
    }
}
