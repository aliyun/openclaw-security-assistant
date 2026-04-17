/**
 * Skill 扫描队列
 *
 * 管理扫描任务的入队、去重、串行处理、失败重试。
 * 单个任务处理流程：收集文件 → 创建 ZIP → 计算 SHA256 → 预检 API → 上传 API（如需）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ScanTask, SkillCheckResponse, SkillUploadResponse } from "./types.js";
import type { SkillFingerprintStore } from "./skill-fingerprint-store.js";
import {
    MAX_QUEUE_SIZE,
    MAX_RETRY_COUNT,
    MAX_ZIP_BYTES,
    MAX_FILES_PER_SKILL,
    QUEUE_PROCESS_INTERVAL_MS,
} from "./constants.js";
import { walkSkillDirectory, type SkillFile } from "./skill-file-utils.js";
import { createSkillZip } from "./zip-generator.js";
import { buildApsHeaders, buildUrl } from "../utils.js";
import { getRuntimeContext } from "../runtime.js";
import { logDebug, logInfo, logWarn, logError } from "../logger.js";

// ============================================================================
// API 路径常量
// ============================================================================

/** Skill 预检/上传接口路径（GET 预检、POST 上传，共用同一路径通过 HTTP 方法区分） */
const API_PATH_SKILL_CHECK = "/v1/agent/skill/check";

// ============================================================================
// 扫描队列
// ============================================================================

export class SkillScanQueue {
    /** 任务队列 */
    private queue: ScanTask[] = [];
    /** 当前是否正在处理任务（防止定时器回调重叠） */
    private processing = false;
    /** 当前正在处理的 skillPath（用于 has() 可见性，防止在途任务被重复入队） */
    private inFlightPath: string | null = null;
    /** 定时器句柄 */
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        /** 原始 fetch（未被安全助手包装的版本） */
        private readonly fetch: typeof globalThis.fetch,
        /** API 基础地址 */
        private readonly apiBaseUrl: string,
        /** 签名表实例（用于回填 zipSha256） */
        private readonly fingerprintStore?: SkillFingerprintStore,
    ) {}

    /** 当前队列长度 */
    get size(): number {
        return this.queue.length;
    }

    // ========================================================================
    // 入队与去重
    // ========================================================================

    /**
     * 入队扫描任务
     *
     * 去重策略：同一 skillPath 如已在队列中，用新状态替换旧任务（保留队列位置），
     * 确保队列中始终是最新的 fingerprint 和 filePaths。
     *
     * @param filePaths - 可选，首次遍历收集的文件路径缓存（避免 ZIP 打包时重复遍历）
     * @returns 是否成功入队（含替换）
     */
    enqueue(
        skillPath: string,
        expectedFingerprint: string,
        retryCount = 0,
        filePaths?: Array<{ relativePath: string; fullPath: string }>,
    ): boolean {
        // 去重：已有则用新状态替换（保留队列位置）
        const existingIndex = this.queue.findIndex((t) => t.skillPath === skillPath);
        if (existingIndex !== -1) {
            this.queue[existingIndex] = { skillPath, expectedFingerprint, retryCount, filePaths };
            logDebug("skill_scanner", "queue_dedup_replaced", { skillPath });
            return true;
        }

        // 队列容量检查
        if (this.queue.length >= MAX_QUEUE_SIZE) {
            logWarn("skill_scanner", "queue_full", {
                skillPath,
                maxSize: MAX_QUEUE_SIZE,
            });
            return false;
        }

        this.queue.push({ skillPath, expectedFingerprint, retryCount, filePaths });
        logDebug("skill_scanner", "task_enqueued", {
            skillPath,
            retryCount,
            queueSize: this.queue.length,
        });
        return true;
    }

    /** Check whether a task for the given skillPath is queued or currently in-flight. */
    has(skillPath: string): boolean {
        return this.inFlightPath === skillPath || this.queue.some((t) => t.skillPath === skillPath);
    }

    // ========================================================================
    // 生命周期
    // ========================================================================

    /**
     * 启动定时处理循环
     *
     * 每 QUEUE_PROCESS_INTERVAL_MS 尝试从队列取一个任务处理。
     * 队列为空或上一任务仍在处理中时自动跳过，无额外开销。
     */
    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.processTick(), QUEUE_PROCESS_INTERVAL_MS);
        this.timer.unref?.();
    }

    /**
     * 停止定时处理循环
     */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    // ========================================================================
    // 定时处理
    // ========================================================================

    /**
     * 单次 tick：从队头取一个任务并处理
     *
     * 通过 processing 标志保证串行：上一任务未完成时跳过本次 tick。
     */
    private async processTick(): Promise<void> {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        const task = this.queue.shift()!;
        this.inFlightPath = task.skillPath;
        try {
            await this.processTask(task);
        } catch (err) {
            logError("skill_scanner", "task_process_error", {
                skillPath: task.skillPath,
                retryCount: task.retryCount,
                error: err instanceof Error ? err.message : String(err),
            });
            this.handleFailure(task);
        } finally {
            this.inFlightPath = null;
            this.processing = false;
        }
    }

    // ========================================================================
    // 单任务处理
    // ========================================================================

    private async processTask(task: ScanTask): Promise<void> {
        const { skillPath, filePaths } = task;
        const skillName = path.basename(skillPath);
        const taskStartMs = Date.now();

        // 1. 验证目录是否仍存在
        try {
            const stat = await fs.promises.stat(skillPath);
            if (!stat.isDirectory()) {
                logDebug("skill_scanner", "scan_skip_not_dir", { skillPath });
                return;
            }
        } catch {
            logDebug("skill_scanner", "scan_skip_not_found", { skillPath });
            return;
        }

        // 2. 创建 ZIP（优先使用缓存路径，避免重复遍历）
        const zipStartMs = Date.now();
        const zipBuffer = await this.createZip(skillPath, filePaths);
        if (!zipBuffer) {
            return;
        }
        const zipDurationMs = Date.now() - zipStartMs;

        // 3. 计算 ZIP 的 SHA256
        const sha256 = crypto.createHash("sha256").update(zipBuffer).digest("hex");

        logDebug("skill_scanner", "zip_created", {
            skillPath,
            zipBytes: zipBuffer.length,
            sha256,
            zipDurationMs,
        });

        // 4. 预检 API：判断是否需要上传
        const checkStartMs = Date.now();
        const needUpload = await this.checkSkill(sha256);
        const checkDurationMs = Date.now() - checkStartMs;

        if (!needUpload) {
            // 服务端已持有该 ZIP，视为成功，回填 zipSha256
            this.writeBackZipSha256(task, sha256);
            logDebug("skill_scanner", "scan_no_upload_needed", {
                skillPath,
                sha256,
                checkDurationMs,
                totalDurationMs: Date.now() - taskStartMs,
                queueSize: this.queue.length,
            });
            return;
        }

        // 5. 上传 ZIP
        const uploadStartMs = Date.now();
        await this.uploadSkill({ sha256, skillName, skillPath, zipBuffer });
        const uploadDurationMs = Date.now() - uploadStartMs;

        // 上传成功，回填 zipSha256
        this.writeBackZipSha256(task, sha256);

        logDebug("skill_scanner", "scan_uploaded", {
            skillPath,
            sha256,
            zipBytes: zipBuffer.length,
            zipDurationMs,
            checkDurationMs,
            uploadDurationMs,
            totalDurationMs: Date.now() - taskStartMs,
            queueSize: this.queue.length,
        });
    }

    // ========================================================================
    // FingerprintStore 回填
    // ========================================================================

    /**
     * 回填 zipSha256 到 FingerprintStore（乐观锁）
     *
     * 仅在 check/upload 成功后调用，确保 zipSha256 只代表"服务端已持有"状态。
     */
    private writeBackZipSha256(task: ScanTask, sha256: string): void {
        if (!this.fingerprintStore) return;
        const written = this.fingerprintStore.setZipSha256(
            task.skillPath,
            task.expectedFingerprint,
            sha256,
        );
        if (written) {
            this.fingerprintStore.persistToDisk();
        } else {
            logDebug("skill_scanner", "zipsha256_writeback_skipped_stale", {
                skillPath: task.skillPath,
            });
        }
    }

    // ========================================================================
    // ZIP 创建
    // ========================================================================

    /**
     * 将 skill 目录打包为 ZIP（对齐 Python zipfile 二进制格式）
     *
     * - 格式对齐：与服务端 Python zipfile.ZipFile("w", ZIP_DEFLATED) 逐字节一致
     * - 非阻塞：zlib.deflateRaw() 异步压缩（libuv 线程池），不占用 JS 主线程
     * - 体积感知：逐文件累计，超过 MAX_ZIP_BYTES 立即中止
     * - 归档路径：baseName/relativePath（与服务端 _create_zip 一致）
     *
     * @param cachedFilePaths - 可选，首次遍历收集的缓存路径。
     *                          可用时直接使用，避免重复遍历；重试场景无缓存时回退到重新遍历。
     * @returns ZIP Buffer，无文件或体积超限时返回 null（内部已日志）
     */
    private async createZip(
        skillPath: string,
        cachedFilePaths?: Array<{ relativePath: string; fullPath: string }>,
    ): Promise<Buffer | null> {
        let entries: SkillFile[];

        if (cachedFilePaths && cachedFilePaths.length > 0) {
            entries = cachedFilePaths;
            logDebug("skill_scanner", "zip_using_cached_paths", {
                skillPath,
                fileCount: entries.length,
            });
        } else {
            // 回退：重新遍历（重试场景或缓存不可用）
            const { files } = await walkSkillDirectory(skillPath, MAX_FILES_PER_SKILL);
            entries = files;
        }

        if (entries.length === 0) {
            logDebug("skill_scanner", "zip_skip_empty", { skillPath });
            return null;
        }

        const zipBuffer = await createSkillZip(skillPath, entries, MAX_ZIP_BYTES);
        if (!zipBuffer) {
            logWarn("skill_scanner", "zip_size_exceeded_or_empty", {
                skillPath,
                maxBytes: MAX_ZIP_BYTES,
            });
            return null;
        }

        return zipBuffer;
    }

    // ========================================================================
    // API 交互
    // ========================================================================

    /**
     * 预检接口：GET /v1/agent/skill/check?sha256={hash}
     *
     * @returns 是否需要上传 ZIP 实体文件
     */
    private async checkSkill(sha256: string): Promise<boolean> {
        const headers = buildApsHeaders({ contentType: "application/json" });
        const requestId = headers["X-Request-Id"];
        const url = buildUrl(this.apiBaseUrl, `${API_PATH_SKILL_CHECK}?sha256=${encodeURIComponent(sha256)}`);

        const response = await this.fetch(url, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            throw new Error(`Check API responded ${response.status} ${response.statusText}`);
        }

        const data: SkillCheckResponse = await response.json();

        logDebug("skill_scanner", "check_api_response", {
            requestId: data.request_id,
            sha256,
            needUpload: data.need_upload,
        });

        return data.need_upload ?? false;
    }

    /**
     * 上传接口：POST /v1/agent/skill/check (multipart/form-data)
     *
     * 异步模式：上传成功即结束，无需等待最终检测结果
     */
    private async uploadSkill(params: {
        sha256: string;
        skillName: string;
        skillPath: string;
        zipBuffer: Buffer;
    }): Promise<void> {
        // 不设置 Content-Type，由 fetch 自动生成 multipart boundary
        const headers = buildApsHeaders();
        const url = buildUrl(this.apiBaseUrl, API_PATH_SKILL_CHECK);

        // 构建 multipart/form-data（不设置 Content-Type，由 fetch 自动生成 boundary）
        const formData = new FormData();
        formData.append("sha256", params.sha256);
        formData.append("skill_name", params.skillName);
        formData.append("instance_id", this.resolveAgentId());
        formData.append("skill_path", params.skillPath);
        formData.append(
            "file",
            new Blob([new Uint8Array(params.zipBuffer)]),
            `${params.skillName}.zip`,
        );

        const response = await this.fetch(url, {
            method: "POST",
            headers,
            body: formData,
        });

        if (!response.ok) {
            throw new Error(`Upload API responded ${response.status} ${response.statusText}`);
        }

        const data: SkillUploadResponse = await response.json();
        logDebug("skill_scanner", "upload_api_response", {
            requestId: data.request_id,
            code: data.code,
            message: data.message,
        });
    }

    // ========================================================================
    // 失败重试
    // ========================================================================

    /**
     * 处理任务失败：重入队尾（不超过最大重试次数，且不重复入队）
     */
    private handleFailure(task: ScanTask): void {
        const nextRetry = task.retryCount + 1;
        if (nextRetry > MAX_RETRY_COUNT) {
            logWarn("skill_scanner", "task_max_retries_exceeded", {
                skillPath: task.skillPath,
                maxRetries: MAX_RETRY_COUNT,
            });
            return;
        }
        // enqueue 内部已含去重检查
        this.enqueue(task.skillPath, task.expectedFingerprint, nextRetry);
    }

    // ========================================================================
    // 工具方法
    // ========================================================================

    /**
     * 从运行时上下文获取 agentId（认证成功后由 auth-service 设置）
     *
     * 认证未完成时抛出异常，任务会通过重试机制自愈。
     */
    private resolveAgentId(): string {
        const agentId = getRuntimeContext().agentId;
        if (!agentId) {
            throw new Error("agentId not available yet (auth not completed)");
        }
        return agentId;
    }
}
