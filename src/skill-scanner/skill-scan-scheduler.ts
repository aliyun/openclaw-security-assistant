/**
 * Skill 安全扫描调度器
 *
 * 核心职责：
 * 1. 解析所有 skill 目录路径（managed、personal、project、workspace、extra）
 * 2. 周期性（60 秒）扫描所有 skill 目录
 * 3. 对比签名表，变化的 skill 入队扫描队列
 * 4. 管理签名表的更新与持久化
 * 5. 生命周期管理（start / stop）
 *
 * 签名更新策略：
 * - enqueue 成功 → 立即更新签名表（不等 API 结果）
 * - enqueue 失败 → 不更新签名表，下个扫描周期自动重试
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { SCAN_CYCLE_INTERVAL_MS, FORCE_RESCAN_TTL_MS, FORCE_RESCAN_EVERY_N_CYCLES, AUTH_WAIT_INTERVAL_MS, AUTH_WAIT_MAX_MS } from "./constants.js";
import { SkillFingerprintStore, computeFingerprint } from "./skill-fingerprint-store.js";
import { SkillScanQueue } from "./skill-scan-queue.js";
import { resolveSkillRootDirs, collectSkillPaths } from "./skill-path-resolver.js";
import { isAuthServiceReady } from "../auth-service.js";
import { logInfo, logDebug, logWarn } from "../logger.js";

// ============================================================================
// 调度器
// ============================================================================

export class SkillScanScheduler {
    /** 签名表 */
    private readonly store: SkillFingerprintStore;
    /** 扫描任务队列 */
    private readonly queue: SkillScanQueue;
    /** OpenClaw 全局配置（用于解析 skill 目录） */
    private readonly openclawConfig: OpenClawConfig;
    /** 状态目录路径（managed skills 位于 stateDir/skills） */
    private readonly stateDir: string;
    /** 定时器句柄 */
    private timer: ReturnType<typeof setInterval> | null = null;
    /** 调度器是否已启动 */
    private running = false;
    /** 当前是否正在执行扫描周期（防止重叠） */
    private scanning = false;
    /** 强制重扫周期计数器（每 FORCE_RESCAN_EVERY_N_CYCLES 个周期执行一次） */
    private forceRescanCycleCounter = 0;
    /** 最近一轮扫描周期完成时间 */
    private lastCycleAtValue: string | null = null;

    constructor(params: {
        stateDir: string;
        fetch: typeof globalThis.fetch;
        apiBaseUrl: string;
        openclawConfig: OpenClawConfig;
    }) {
        this.stateDir = params.stateDir;
        this.openclawConfig = params.openclawConfig;
        this.store = new SkillFingerprintStore(params.stateDir);
        this.queue = new SkillScanQueue(
            params.fetch,
            params.apiBaseUrl,
            this.store,
        );
    }

    // ========================================================================
    // 生命周期
    // ========================================================================

    /**
     * 启动调度器
     *
     * 等待认证服务就绪后再启动扫描周期和队列。
     * 队列在此启动后持续运行，enqueue 时自动触发处理。
     */
    start(): void {
        if (this.running) return;
        this.running = true;

        // fire-and-forget：等待 auth 就绪后再启动扫描
        this.waitForAuthAndStart();
    }

    /**
     * 停止调度器
     */
    stop(): void {
        if (!this.running) return;
        this.running = false;

        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.queue.stop();

        logInfo("skill_scanner", "scheduler_stopped", {});
    }

    /**
     * 等待认证服务就绪后启动扫描周期和队列
     *
     * 最多等待 5 分钟，每 10 秒检查一次。等待期间若被 stop()，立即退出。
     */
    private async waitForAuthAndStart(): Promise<void> {
        const startTime = Date.now();

        while (!isAuthServiceReady()) {
            if (!this.running) return;
            if (Date.now() - startTime > AUTH_WAIT_MAX_MS) {
                logWarn("skill_scanner", "auth_wait_timeout", {
                    message: "auth service not ready after 5min, scheduler will not start",
                });
                return;
            }
            logDebug("skill_scanner", "waiting_for_auth", {});
            await new Promise((resolve) => setTimeout(resolve, AUTH_WAIT_INTERVAL_MS));
        }

        // 等待期间可能被 stop()
        if (!this.running) return;

        logInfo("skill_scanner", "scheduler_started", {
            cycleIntervalMs: SCAN_CYCLE_INTERVAL_MS,
        });

        // 启动队列
        this.queue.start();

        // 首次立即执行（fire-and-forget，异常已在 runCycle 内捕获）
        this.runCycle();

        // 后续定时执行
        this.timer = setInterval(() => {
            this.runCycle();
        }, SCAN_CYCLE_INTERVAL_MS);
    }

    // ========================================================================
    // 公开访问器
    // ========================================================================

    /** 获取签名表实例（供 Guard 只读访问） */
    get fingerprintStore(): SkillFingerprintStore {
        return this.store;
    }

    /** 调度器是否正在运行 */
    get isRunning(): boolean {
        return this.running;
    }

    /** 最近一轮扫描周期完成时间 */
    get lastCycleAt(): string | null {
        return this.lastCycleAtValue;
    }

    /** 待扫描的 skill 数量（队列积压） */
    get pendingCount(): number {
        return this.queue.size;
    }

    // ========================================================================
    // 扫描周期
    // ========================================================================

    /**
     * 执行一轮完整的扫描周期
     *
     * 流程：
     * 1. 解析所有 skill 根目录
     * 2. 从根目录中收集具体的 skill 路径（含 SKILL.md 的目录）
     * 3. 差集清理已删除的 skill（先清理再计算签名，减少无效计算）
     * 4. 计算每个 skill 的 fingerprint 并与签名表对比
     * 5. 变化的 skill 入队 → 更新签名表（仅 enqueue 成功时）
     * 6. 批量持久化签名表
     */
    private async runCycle(): Promise<void> {
        // 防止扫描周期重叠（上一轮尚未结束时跳过）
        if (this.scanning) {
            logDebug("skill_scanner", "cycle_skipped_overlap", {});
            return;
        }
        this.scanning = true;
        const startTime = Date.now();

        try {
            // 1. 解析所有 skill 根目录
            const rootDirs = resolveSkillRootDirs({
                stateDir: this.stateDir,
                openclawConfig: this.openclawConfig,
            });
            if (rootDirs.length === 0) {
                logDebug("skill_scanner", "cycle_no_root_dirs", {});
                return;
            }

            // 2. 收集具体的 skill 路径
            const skillPaths = await collectSkillPaths(rootDirs);
            if (skillPaths.length === 0) {
                logDebug("skill_scanner", "cycle_no_skills", {
                    rootDirsCount: rootDirs.length,
                });
                return;
            }

            // 3. 差集清理已删除的 skill（先于签名计算，避免对已删除 skill 做无效工作）
            const validPaths = new Set(skillPaths);
            this.store.removeStale(validPaths);

            // 4-5. 计算签名、对比、入队
            let changedCount = 0;

            for (const skillPath of skillPaths) {
                const result = await computeFingerprint(skillPath);
                if (!result) continue;

                const existing = this.store.get(skillPath);

                // 签名未变化且已有 zipSha256，跳过
                // 签名未变化且已在队列中等待处理，跳过（避免无效替换重置 retryCount）
                // 注意：fingerprint 相同但 zipSha256 为 null 且不在队列中，说明上次入队后未处理完就重启了，需要重新入队
                if (existing && existing.fingerprint === result.fingerprint) {
                    if (existing.zipSha256 || this.queue.has(skillPath)) {
                        continue;
                    }
                }

                // 签名变化（新增或修改），检查是否截断或超大
                if (result.truncated || result.oversize) {
                    // 超过文件数上限或原始大小上限的 skill 跳过检测，仅更新签名表避免重复计算
                    this.store.set(skillPath, {
                        fingerprint: result.fingerprint,
                        fileCount: result.fileCount,
                        truncated: true,
                        zipSha256: null,
                    });
                    logDebug("skill_scanner", "scan_skip_truncated", {
                        skillPath,
                        fileCount: result.fileCount,
                        reason: result.oversize ? "oversize" : "truncated",
                    });
                    continue;
                }

                // 尝试入队（携带缓存的文件路径，避免 ZIP 打包时重复遍历）
                const enqueued = this.queue.enqueue(skillPath, result.fingerprint, 0, result.filePaths);

                if (enqueued) {
                    // 立即更新签名表（不等 API 结果）
                    this.store.set(skillPath, {
                        fingerprint: result.fingerprint,
                        fileCount: result.fileCount,
                        truncated: result.truncated,
                        zipSha256: null,
                    });
                    changedCount++;
                }
                // enqueue 失败时不更新签名表，下个扫描周期自动重试
            }

            // 4b. 强制重新扫描过期条目（每 N 个周期执行一次，每次处理 1 个最老的）
            let forceRescanCount = 0;
            this.forceRescanCycleCounter++;

            if (this.forceRescanCycleCounter >= FORCE_RESCAN_EVERY_N_CYCLES) {
                this.forceRescanCycleCounter = 0;
                const now = Date.now();

                // 收集过期条目，按 updatedAt 升序（最老优先）
                const expired = skillPaths
                    .filter((p) => {
                        const entry = this.store.get(p);
                        if (!entry || entry.truncated) return false;
                        const age = now - new Date(entry.updatedAt).getTime();
                        return age > FORCE_RESCAN_TTL_MS;
                    })
                    .sort((a, b) => {
                        const ea = this.store.get(a)!;
                        const eb = this.store.get(b)!;
                        return new Date(ea.updatedAt).getTime() - new Date(eb.updatedAt).getTime();
                    });

                // 每次仅处理 1 个最老的过期 skill
                const oldest = expired[0];
                if (oldest) {
                    const result = await computeFingerprint(oldest);
                    if (result && !result.truncated && !result.oversize) {
                        const enqueued = this.queue.enqueue(oldest, result.fingerprint, 0, result.filePaths);
                        if (enqueued) {
                            this.store.set(oldest, {
                                fingerprint: result.fingerprint,
                                fileCount: result.fileCount,
                                truncated: result.truncated,
                                zipSha256: null,
                            });
                            forceRescanCount = 1;
                        }
                    }
                }

                logDebug("skill_scanner", "force_rescan_tick", {
                    expiredCount: expired.length,
                    forceRescanCount,
                });
            }

            // 6. 批量持久化签名表
            this.store.persistToDisk();

            logDebug("skill_scanner", "cycle_complete", {
                rootDirsCount: rootDirs.length,
                skillPathsCount: skillPaths.length,
                changedCount,
                forceRescanCount,
                queueSize: this.queue.size,
                durationMs: Date.now() - startTime,
            });

            this.lastCycleAtValue = new Date().toISOString();
        } catch (err) {
            logWarn("skill_scanner", "cycle_error", {
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - startTime,
            });
        } finally {
            this.scanning = false;
        }
    }
}
