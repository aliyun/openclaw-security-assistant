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

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { SCAN_CYCLE_INTERVAL_MS, FORCE_RESCAN_TTL_MS, FORCE_RESCAN_EVERY_N_CYCLES, AUTH_WAIT_INTERVAL_MS, AUTH_WAIT_MAX_MS } from "./constants.js";
import { SkillFingerprintStore, computeFingerprint } from "./skill-fingerprint-store.js";
import { SkillScanQueue } from "./skill-scan-queue.js";
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
            const rootDirs = this.resolveSkillRootDirs();
            if (rootDirs.length === 0) {
                logDebug("skill_scanner", "cycle_no_root_dirs", {});
                return;
            }

            // 2. 收集具体的 skill 路径
            const skillPaths = await this.collectSkillPaths(rootDirs);
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
        } catch (err) {
            logWarn("skill_scanner", "cycle_error", {
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - startTime,
            });
        } finally {
            this.scanning = false;
        }
    }

    // ========================================================================
    // Skill 目录解析
    // ========================================================================

    /**
     * 解析所有需要扫描的 skill 根目录
     *
     * 覆盖以下来源：
     * - 用户主目录下的固定路径（~/.openclaw/skills、~/.agents/skills）
     * - stateDir 关联路径（兼容 OPENCLAW_STATE_DIR 环境变量覆盖场景）
     * - 用户配置的额外目录（config.skills.load.extraDirs）
     * - 所有 Agent workspace 下的 skills 和 .agents/skills
     * - 已安装插件的 skill 目录（installPath/skills + 清单声明路径）
     * - OpenClaw bundled skills（随应用发布，版本更新时可能变化）
     */
    private resolveSkillRootDirs(): string[] {
        const roots = new Set<string>();
        const home = os.homedir();

        // 固定路径：用户主目录下的标准 skill 位置
        roots.add(path.join(home, ".openclaw", "skills"));
        roots.add(path.join(home, ".agents", "skills"));

        // stateDir 关联路径（当 OPENCLAW_STATE_DIR 覆盖默认目录时与上述路径不同）
        if (this.stateDir) {
            roots.add(path.join(this.stateDir, "skills"));
            roots.add(path.join(this.stateDir, ".agents", "skills"));
        }

        // 用户配置的额外 skill 目录
        this.appendExtraDirs(roots);

        // Agent workspace 下的 skill 目录（支持多 agent 多 workspace）
        for (const wsDir of this.resolveAgentWorkspaceDirs()) {
            roots.add(path.join(wsDir, "skills"));
            roots.add(path.join(wsDir, ".agents", "skills"));
        }

        // 已安装插件的 skill 目录
        this.appendPluginSkillDirs(roots);

        // OpenClaw bundled skills（随应用发布）
        this.appendBundledSkillsDir(roots);

        return Array.from(roots);
    }

    /**
     * 从 skills.load.extraDirs 配置收集额外 skill 目录
     */
    private appendExtraDirs(roots: Set<string>): void {
        const extraDirs = this.openclawConfig.skills?.load?.extraDirs;
        if (!Array.isArray(extraDirs)) return;

        for (const raw of extraDirs) {
            const cleaned = cleanPathInput(raw);
            if (cleaned) {
                roots.add(path.resolve(cleaned));
            }
        }
    }

    /**
     * 从 agents 配置中收集所有 workspace 路径
     *
     * 包含 agents.defaults.workspace 和每个 agent 实例的独立 workspace。
     */
    private resolveAgentWorkspaceDirs(): string[] {
        const config = this.openclawConfig;
        const seen = new Set<string>();
        const result: string[] = [];

        const tryAdd = (raw: unknown): void => {
            if (typeof raw !== "string") return;
            const cleaned = cleanPathInput(raw);
            if (!cleaned) return;
            const resolved = path.resolve(cleaned);
            if (seen.has(resolved)) return;
            seen.add(resolved);
            result.push(resolved);
        };

        tryAdd(config.agents?.defaults?.workspace);

        for (const agent of config.agents?.list ?? []) {
            tryAdd(agent?.workspace);
        }

        return result;
    }

    /**
     * 从已安装插件中查找 skill 目录
     *
     * 两种发现方式：
     * 1. 读取插件清单（openclaw.plugin.json）中显式声明的 skills 路径
     * 2. 约定式查找 installPath/skills 子目录（兜底）
     *
     * 仅在目录实际存在时添加，避免为大量无 skill 的插件创建无效路径。
     */
    private appendPluginSkillDirs(roots: Set<string>): void {
        const installs = this.openclawConfig.plugins?.installs;
        if (!installs || typeof installs !== "object") return;

        for (const record of Object.values(installs)) {
            const cleaned = cleanPathInput(record?.installPath);
            if (!cleaned) continue;

            // 方式 1: 从插件清单读取显式声明的 skill 目录
            this.readManifestSkillDirs(cleaned, roots);

            // 方式 2: 约定式 skills 子目录
            const conventionDir = path.join(cleaned, "skills");
            try {
                if (fs.existsSync(conventionDir)) {
                    roots.add(conventionDir);
                }
            } catch {
                // existsSync 可能在损坏的挂载点或权限问题时抛出异常
            }
        }
    }

    /**
     * 读取插件清单中声明的 skill 目录路径
     */
    private readManifestSkillDirs(pluginDir: string, roots: Set<string>): void {
        try {
            const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
            const raw = fs.readFileSync(manifestPath, "utf-8");
            const manifest = JSON.parse(raw);
            if (!Array.isArray(manifest.skills)) return;

            for (const entry of manifest.skills) {
                const cleaned = cleanPathInput(entry);
                if (!cleaned) continue;
                const resolved = path.resolve(pluginDir, cleaned);
                // 安全检查：路径不得逃逸出插件根目录
                const relative = path.relative(pluginDir, resolved);
                if (relative.startsWith("..") || path.isAbsolute(relative)) {
                    logDebug("skill_scanner", "manifest_skill_path_escaped", {
                        pluginDir,
                        declaredPath: String(entry),
                        resolved,
                    });
                    continue;
                }
                try {
                    if (fs.existsSync(resolved)) {
                        roots.add(resolved);
                        logDebug("skill_scanner", "manifest_skill_dir_added", {
                            pluginDir,
                            skillDir: resolved,
                        });
                    }
                } catch {
                    // ignore
                }
            }
        } catch (err) {
            // 清单不存在时属正常情况（大多数插件无 skills 声明），仅记录 debug
            logDebug("skill_scanner", "manifest_read_skipped", {
                pluginDir,
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * 定位 OpenClaw bundled skills 目录并添加到扫描根集合
     *
     * 查找策略（与框架 resolveBundledSkillsDir 对齐）：
     * 1. 环境变量 OPENCLAW_BUNDLED_SKILLS_DIR 覆盖
     * 2. 从 process.argv[1]（openclaw.mjs 入口）定位包根目录
     *    - 直接路径 + symlink 解析两种候选
     *    - 逐级向上查找 package.json.name === "openclaw"
     * 3. 在包根目录下查找 skills/ 子目录
     */
    private appendBundledSkillsDir(roots: Set<string>): void {
        // 环境变量覆盖（与框架 resolveBundledSkillsDir 行为一致）
        const override = process.env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
        if (override) {
            try {
                if (fs.existsSync(override)) {
                    roots.add(override);
                    logDebug("skill_scanner", "bundled_skills_dir_env", { dir: override });
                }
            } catch {
                // ignore
            }
            return;
        }

        // 从 process.argv[1] 定位 OpenClaw 包根目录
        const argv1 = process.argv[1];
        if (!argv1) return;

        // 收集候选起始目录：直接路径 + symlink 解析
        const candidates: string[] = [path.dirname(path.resolve(argv1))];
        try {
            const resolved = fs.realpathSync(path.resolve(argv1));
            if (resolved !== path.resolve(argv1)) {
                candidates.push(path.dirname(resolved));
            }
        } catch {
            // realpathSync 在路径不存在时可能抛异常
        }

        // 逐级向上查找 package.json.name === "openclaw"，最多 6 层
        for (const start of candidates) {
            let current = start;
            for (let depth = 0; depth < 6; depth++) {
                try {
                    const pkgRaw = fs.readFileSync(path.join(current, "package.json"), "utf-8");
                    const pkg = JSON.parse(pkgRaw) as { name?: unknown };
                    if (pkg.name === "openclaw") {
                        const skillsDir = path.join(current, "skills");
                        if (fs.existsSync(skillsDir)) {
                            roots.add(skillsDir);
                            logDebug("skill_scanner", "bundled_skills_dir_found", { dir: skillsDir });
                            return;
                        }
                    }
                } catch {
                    // package.json 不存在或解析失败，继续向上
                }
                const parent = path.dirname(current);
                if (parent === current) break;
                current = parent;
            }
        }

        logDebug("skill_scanner", "bundled_skills_dir_not_found", {});
    }

    // ========================================================================
    // Skill 路径收集
    // ========================================================================

    /**
     * 从 skill 根目录中收集具体的 skill 路径
     *
     * 两种结构：
     * 1. 根目录本身就是 skill（包含 SKILL.md）→ 直接收录
     * 2. 根目录下的子目录各自是 skill → 收录包含 SKILL.md 的子目录
     *
     * 使用 realpath 去重，避免符号链接导致同一 skill 被重复扫描。
     */
    private async collectSkillPaths(rootDirs: string[]): Promise<string[]> {
        const skillPaths: string[] = [];
        const seen = new Set<string>();

        for (const rootDir of rootDirs) {
            // 检查根目录是否存在
            try {
                const stat = await fs.promises.stat(rootDir);
                if (!stat.isDirectory()) continue;
            } catch {
                continue;
            }

            // 情况 1: 根目录本身是 skill
            const rootSkillMd = path.join(rootDir, "SKILL.md");
            if (await fileExists(rootSkillMd)) {
                const realPath = await safeRealpath(rootDir);
                if (realPath && !seen.has(realPath)) {
                    seen.add(realPath);
                    skillPaths.push(rootDir);
                }
                // 根目录本身是 skill，不再扫描子目录
                continue;
            }

            // 情况 2: 扫描子目录
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const skillDir = path.join(rootDir, entry.name);
                const skillMd = path.join(skillDir, "SKILL.md");

                if (!(await fileExists(skillMd))) continue;

                const realPath = await safeRealpath(skillDir);
                if (!realPath || seen.has(realPath)) continue;

                seen.add(realPath);
                skillPaths.push(skillDir);
            }
        }

        return skillPaths;
    }
}

// ============================================================================
// 工具函数
// ============================================================================

/** 检查文件是否存在 */
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.promises.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/** 安全获取 realpath（失败时返回 null） */
async function safeRealpath(dirPath: string): Promise<string | null> {
    try {
        return await fs.promises.realpath(dirPath);
    } catch {
        return null;
    }
}

/**
 * 清理路径输入：类型检查 + 去除空白 + 移除 null 字节 + ~ 展开
 *
 * 防御配置中可能出现的脏数据，返回 null 表示输入无效。
 */
function cleanPathInput(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    let cleaned = raw.trim().replace(/\0/g, "");
    if (!cleaned) return null;
    // 支持 ~ 前缀展开为用户主目录（与核心 resolveUserPath 行为一致）
    if (cleaned === "~") {
        cleaned = os.homedir();
    } else if (cleaned.startsWith("~/")) {
        cleaned = path.join(os.homedir(), cleaned.slice(2));
    }
    return cleaned;
}
