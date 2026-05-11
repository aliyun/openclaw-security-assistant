/**
 * Skill 签名表管理
 *
 * 维护 skillPath → fingerprint 的映射关系，用于检测 skill 目录是否发生变化。
 * - 内存层：Map 存储，读写高效
 * - 磁盘层：JSON 文件持久化，原子写入（write tmp → rename）
 * - 签名计算：基于目录内所有文件的 relativePath|sizeBytes|mtimeMs 拼接后取 SHA256
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { FingerprintEntry, FingerprintStoreData } from "./types.js";
import {
    FINGERPRINT_STORE_FILENAME,
    FINGERPRINT_STORE_VERSION,
    MAX_FILES_PER_SKILL,
    MAX_SKILL_RAW_BYTES,
} from "./constants.js";
import { walkSkillDirectory } from "./skill-file-utils.js";
import { logDebug, logWarn, logError } from "../logger.js";

// ============================================================================
// 签名计算
// ============================================================================

/** computeFingerprint 返回结果 */
export type FingerprintResult = {
    /** SHA256 签名 */
    fingerprint: string;
    /** 参与计算的文件数量 */
    fileCount: number;
    /** 是否因超过文件数上限而截断 */
    truncated: boolean;
    /** 是否因原始文件总大小超过上限而跳过 */
    oversize: boolean;
    /** 遍历收集的文件路径列表（已排序，可直接用于 ZIP 打包，避免重复遍历） */
    filePaths: Array<{ relativePath: string; fullPath: string }>;
};

/**
 * 计算 skill 目录的 fingerprint
 *
 * 流程：遍历目录收集文件路径 → 逐个 stat 获取文件信息 → 拼接 SHA256。
 * 遍历结果通过 filePaths 返回，供后续 ZIP 打包复用，避免重复遍历。
 *
 * @returns fingerprint 信息（含文件路径），计算失败时返回 null
 */
export async function computeFingerprint(
    skillPath: string,
): Promise<FingerprintResult | null> {
    try {
        const { files, truncated } = await walkSkillDirectory(skillPath, MAX_FILES_PER_SKILL);

        if (files.length === 0) {
            return null;
        }

        // 逐个 stat，收集成功的文件用于签名计算和路径复用
        const statParts: string[] = [];
        const validFiles: Array<{ relativePath: string; fullPath: string }> = [];
        let totalBytes = 0;

        for (const file of files) {
            try {
                const stat = await fs.promises.stat(file.fullPath);
                statParts.push(`${file.relativePath}|${stat.size}|${Math.floor(stat.mtimeMs)}`);
                validFiles.push(file);
                totalBytes += stat.size;
            } catch (err) {
                logDebug("skill_scanner", "file_stat_skipped", {
                    path: file.fullPath,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        if (statParts.length === 0) {
            return null;
        }

        const oversize = totalBytes > MAX_SKILL_RAW_BYTES;
        const fingerprint = crypto.createHash("sha256").update(statParts.join("|")).digest("hex");

        return {
            fingerprint,
            fileCount: validFiles.length,
            truncated,
            oversize,
            filePaths: validFiles,
        };
    } catch (err) {
        logWarn("skill_scanner", "compute_fingerprint_failed", {
            skillPath,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

// ============================================================================
// 签名表存储
// ============================================================================

export class SkillFingerprintStore {
    /** 内存签名表 */
    private entries: Map<string, FingerprintEntry> = new Map();
    /** 磁盘持久化文件路径 */
    private readonly filePath: string;
    /** 是否有未持久化的变更 */
    private dirty = false;

    constructor(stateDir: string) {
        this.filePath = path.join(stateDir, FINGERPRINT_STORE_FILENAME);
        this.loadFromDisk();
    }

    // ========================================================================
    // 读取操作
    // ========================================================================

    /**
     * 获取指定 skill 的签名条目
     */
    get(skillPath: string): FingerprintEntry | undefined {
        return this.entries.get(skillPath);
    }

    /**
     * 获取所有已记录的 skillPath 列表
     */
    allPaths(): string[] {
        return Array.from(this.entries.keys());
    }

    /**
     * 统计签名表各类别的 skill 数量（单次遍历）
     *
     * - totalSkills: 条目总数
     * - uploadedSkills: zipSha256 !== null（已上传到 APS）
     * - skippedSkills: truncated === true（因规模问题跳过）
     */
    getStats(): { totalSkills: number; uploadedSkills: number; skippedSkills: number } {
        let uploaded = 0;
        let skipped = 0;
        for (const entry of this.entries.values()) {
            if (entry.zipSha256 !== null) uploaded++;
            if (entry.truncated) skipped++;
        }
        return { totalSkills: this.entries.size, uploadedSkills: uploaded, skippedSkills: skipped };
    }

    // ========================================================================
    // 写入操作
    // ========================================================================

    /**
     * 更新指定 skill 的签名（标记 dirty，需调用 persistToDisk 写入磁盘）
     *
     * updatedAt 由 store 自动设置为当前时间，调用方无需传入。
     */
    set(skillPath: string, entry: Omit<FingerprintEntry, "updatedAt">): void {
        const full: FingerprintEntry = { ...entry, updatedAt: new Date().toISOString() };
        this.entries.set(skillPath, full);
        this.dirty = true;
    }

    /**
     * 乐观锁回填 zipSha256
     *
     * 仅当 entry 存在且 fingerprint 仍与预期一致时写入。
     * 若 fingerprint 已变（说明 skill 在 scan 期间被修改），丢弃本次回填。
     *
     * @returns 是否成功写入
     */
    setZipSha256(skillPath: string, expectedFingerprint: string, zipSha256: string): boolean {
        const entry = this.entries.get(skillPath);
        if (!entry || entry.fingerprint !== expectedFingerprint) {
            return false;
        }
        entry.zipSha256 = zipSha256;
        // 与 set() 保持一致：变更即刷新 updatedAt
        entry.updatedAt = new Date().toISOString();
        this.dirty = true;
        return true;
    }

    /**
     * 删除指定 skill 的签名（标记 dirty）
     */
    delete(skillPath: string): boolean {
        const deleted = this.entries.delete(skillPath);
        if (deleted) {
            this.dirty = true;
        }
        return deleted;
    }

    // ========================================================================
    // 差集清理
    // ========================================================================

    /**
     * 移除签名表中不存在于 validPaths 集合中的条目
     *
     * @param validPaths - 当前磁盘上实际存在的 skill 路径集合
     * @returns 被移除的路径数量
     */
    removeStale(validPaths: Set<string>): number {
        let removed = 0;
        const allPaths = Array.from(this.entries.keys());
        for (const skillPath of allPaths) {
            if (!validPaths.has(skillPath)) {
                this.entries.delete(skillPath);
                removed++;
                this.dirty = true;
            }
        }
        if (removed > 0) {
            logDebug("skill_scanner", "stale_entries_removed", { count: removed });
        }
        return removed;
    }

    // ========================================================================
    // 持久化
    // ========================================================================

    /**
     * 将内存签名表持久化到磁盘（仅在有变更时写入）
     */
    persistToDisk(): void {
        if (!this.dirty) {
            return;
        }

        const data: FingerprintStoreData = {
            version: FINGERPRINT_STORE_VERSION,
            entries: Object.fromEntries(this.entries),
        };

        const dir = path.dirname(this.filePath);
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch (err) {
            logError("skill_scanner", "ensure_dir_failed", {
                dir,
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        const tmpPath = `${this.filePath}.tmp`;
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
            fs.renameSync(tmpPath, this.filePath);
            this.dirty = false;
        } catch (err) {
            logError("skill_scanner", "persist_failed", {
                filePath: this.filePath,
                error: err instanceof Error ? err.message : String(err),
            });
            // 清理临时文件
            try {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            } catch {
                // 忽略清理失败
            }
        }
    }

    // ========================================================================
    // 磁盘加载
    // ========================================================================

    /**
     * 从磁盘加载签名表到内存
     */
    private loadFromDisk(): void {
        if (!fs.existsSync(this.filePath)) {
            return;
        }

        try {
            const raw = fs.readFileSync(this.filePath, "utf-8");
            const parsed: FingerprintStoreData = JSON.parse(raw);

            // 版本校验：不兼容时丢弃旧数据
            if (parsed.version !== FINGERPRINT_STORE_VERSION) {
                logWarn("skill_scanner", "fingerprint_store_version_mismatch", {
                    expected: FINGERPRINT_STORE_VERSION,
                    actual: parsed.version,
                });
                return;
            }

            if (parsed.entries && typeof parsed.entries === "object") {
                for (const [skillPath, entry] of Object.entries(parsed.entries)) {
                    if (entry && typeof entry.fingerprint === "string") {
                        this.entries.set(skillPath, entry);
                    }
                }
            }

            logDebug("skill_scanner", "fingerprint_store_loaded", {
                count: this.entries.size,
            });
        } catch (err) {
            logWarn("skill_scanner", "fingerprint_store_load_failed", {
                filePath: this.filePath,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
