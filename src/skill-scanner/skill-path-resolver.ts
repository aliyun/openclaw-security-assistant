/**
 * Skill 根目录路径解析 — 共享模块
 *
 * 从 SkillScanScheduler 中提取为独立函数，供 skill-scanner 和 asset-report-service
 * 的 internal-collectors 共同复用。
 *
 * 覆盖以下来源：
 * - 用户主目录下的固定路径（~/.openclaw/skills、~/.agents/skills）
 * - stateDir 关联路径（兼容 OPENCLAW_STATE_DIR 环境变量覆盖场景）
 * - 用户配置的额外目录（config.skills.load.extraDirs）
 * - 所有 Agent workspace 下的 skills 和 .agents/skills
 * - 已安装插件的 skill 目录（installPath/skills + 清单声明路径）
 * - OpenClaw bundled skills（随应用发布，版本更新时可能变化）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { logDebug } from "../logger.js";

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 解析所有需要扫描的 skill 根目录
 *
 * @returns 去重后的 skill 根目录数组
 */
export function resolveSkillRootDirs(params: {
    stateDir: string;
    openclawConfig: OpenClawConfig;
}): string[] {
    const { stateDir, openclawConfig } = params;
    const roots = new Set<string>();
    const home = os.homedir();

    // 固定路径：用户主目录下的标准 skill 位置
    roots.add(path.join(home, ".openclaw", "skills"));
    roots.add(path.join(home, ".agents", "skills"));

    // stateDir 关联路径（当 OPENCLAW_STATE_DIR 覆盖默认目录时与上述路径不同）
    if (stateDir) {
        roots.add(path.join(stateDir, "skills"));
        roots.add(path.join(stateDir, ".agents", "skills"));
    }

    // 用户配置的额外 skill 目录
    appendExtraDirs(openclawConfig, roots);

    // Agent workspace 下的 skill 目录（支持多 agent 多 workspace）
    for (const wsDir of resolveAgentWorkspaceDirs(openclawConfig)) {
        roots.add(path.join(wsDir, "skills"));
        roots.add(path.join(wsDir, ".agents", "skills"));
    }

    // 已安装插件的 skill 目录
    appendPluginSkillDirs(openclawConfig, roots);

    // OpenClaw bundled skills（随应用发布）
    appendBundledSkillsDir(roots);

    return Array.from(roots);
}

/**
 * 从 skill 根目录中收集具体的 skill 路径
 *
 * 两种结构：
 * 1. 根目录本身就是 skill（包含 SKILL.md）→ 直接收录
 * 2. 根目录下的子目录各自是 skill → 收录包含 SKILL.md 的子目录
 *
 * 使用 realpath 去重，避免符号链接导致同一 skill 被重复扫描。
 */
export async function collectSkillPaths(rootDirs: string[]): Promise<string[]> {
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

// ============================================================================
// 内部 helpers
// ============================================================================

/** 从 skills.load.extraDirs 配置收集额外 skill 目录 */
function appendExtraDirs(config: OpenClawConfig, roots: Set<string>): void {
    const extraDirs = config.skills?.load?.extraDirs;
    if (!Array.isArray(extraDirs)) return;

    for (const raw of extraDirs) {
        const cleaned = cleanPathInput(raw);
        if (cleaned) {
            roots.add(path.resolve(cleaned));
        }
    }
}

/** 从 agents 配置中收集所有 workspace 路径 */
function resolveAgentWorkspaceDirs(config: OpenClawConfig): string[] {
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
 */
function appendPluginSkillDirs(config: OpenClawConfig, roots: Set<string>): void {
    const installs = config.plugins?.installs;
    if (!installs || typeof installs !== "object") return;

    for (const record of Object.values(installs)) {
        const cleaned = cleanPathInput(record?.installPath);
        if (!cleaned) continue;

        // 方式 1: 从插件清单读取显式声明的 skill 目录
        readManifestSkillDirs(cleaned, roots);

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

/** 读取插件清单中声明的 skill 目录路径 */
function readManifestSkillDirs(pluginDir: string, roots: Set<string>): void {
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
function appendBundledSkillsDir(roots: Set<string>): void {
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

    const pkgRoot = findOpenClawPackageRoot();
    if (!pkgRoot) {
        logDebug("skill_scanner", "bundled_skills_dir_not_found", {});
        return;
    }

    const skillsDir = path.join(pkgRoot, "skills");
    if (fs.existsSync(skillsDir)) {
        roots.add(skillsDir);
        logDebug("skill_scanner", "bundled_skills_dir_found", { dir: skillsDir });
    } else {
        logDebug("skill_scanner", "bundled_skills_dir_not_found", {});
    }
}

// ============================================================================
// 通用工具函数
// ============================================================================

/**
 * 从 process.argv[1] 定位 OpenClaw 包根目录
 *
 * 查找策略（与框架 resolveBundledSkillsDir 对齐）：
 * - 直接路径 + symlink 解析两种候选起始目录
 * - 逐级向上查找 package.json.name === "openclaw"，最多 6 层
 * - 返回包根目录路径，未找到返回 undefined
 *
 * 供 appendBundledSkillsDir 和 resolveBundledSkillsDirForClassification 复用。
 */
export function findOpenClawPackageRoot(): string | undefined {
    const argv1 = process.argv[1];
    if (!argv1) return undefined;

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
                    return current;
                }
            } catch {
                // package.json 不存在或解析失败，继续向上
            }
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    }

    return undefined;
}

/** 检查文件是否存在 */
export async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.promises.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/** 安全获取 realpath（失败时返回 null） */
export async function safeRealpath(dirPath: string): Promise<string | null> {
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
export function cleanPathInput(raw: unknown): string | null {
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
