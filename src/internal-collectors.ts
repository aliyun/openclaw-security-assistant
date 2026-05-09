/**
 * 进程内资产数据采集器
 *
 * 替代原 CLI 子进程调用（openclaw skills list / openclaw plugins list），
 * 直接读取文件系统完成等价的数据采集，彻底消除 CLI 依赖。
 *
 * Skills 采集：复用 skill-scanner 的路径解析 + SKILL.md frontmatter 解析 + eligibility 评估
 * Plugins 采集：磁盘发现插件目录 + 读取 openclaw.plugin.json manifest + 评估 enable 状态
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk";
import type { SkillInfo } from "./asset-types.js";
import { logDebug, logWarn } from "./logger.js";
import {
    resolveSkillRootDirs,
    collectSkillPaths,
    cleanPathInput,
    findOpenClawPackageRoot,
} from "./skill-scanner/skill-path-resolver.js";

// ============================================================================
// Skills Internal Collector
// ============================================================================

/**
 * 采集结果：对外 SkillInfo 列表（按 A2 粒度精简到 name/description/source）
 * + 内部 eligibleIds（格式 `source/name`，供 agent.skills 过滤使用）。
 *
 * eligibleIds 仍按原规则评估（disabled / allowlist / requirements），但仅保留在进程内，
 * 不再写入对外发送的 SkillInfo，避免 APS SLS/DB 不消费的字段继续占用 payload。
 */
export type SkillCollectResult = {
    skills: SkillInfo[];
    eligibleIds: string[];
};

/**
 * 进程内采集 Skills 列表（替代 `openclaw skills list --verbose --json`）
 *
 * 流程：
 * 1. 解析所有 skill 根目录（复用 skill-scanner 的路径解析）
 * 2. 收集含 SKILL.md 的目录
 * 3. 解析 SKILL.md YAML frontmatter
 * 4. 评估 eligibility（disabled / allowlist / requirements）
 */
export async function collectSkillsInternal(api: OpenClawPluginApi): Promise<SkillCollectResult> {
    const config = api.config;
    const stateDir = api.runtime.state.resolveStateDir();

    // 1. 解析 skill 根目录
    const rootDirs = resolveSkillRootDirs({ stateDir, openclawConfig: config });
    if (rootDirs.length === 0) {
        logDebug("asset-report-service", "skills_internal_no_roots", {});
        return { skills: [], eligibleIds: [] };
    }

    // 2. 收集具体 skill 路径
    const skillPaths = await collectSkillPaths(rootDirs);
    if (skillPaths.length === 0) {
        logDebug("asset-report-service", "skills_internal_no_skills", {
            rootDirsCount: rootDirs.length,
        });
        return { skills: [], eligibleIds: [] };
    }

    // 3-4. 解析 frontmatter + 评估 eligibility
    const bundledSkillsDir = resolveBundledSkillsDirForClassification();
    const allowBundled = normalizeAllowlist(config.skills?.allowBundled);
    const skills: SkillInfo[] = [];
    const eligibleIds: string[] = [];

    for (const skillDir of skillPaths) {
        try {
            const record = buildSkillInfo(skillDir, config, bundledSkillsDir, allowBundled);
            if (record) {
                skills.push(record.skill);
                if (record.eligible) {
                    eligibleIds.push(record.sourceId);
                }
            }
        } catch (e: unknown) {
            // 单个 skill 解析失败不影响整体，但记录 debug 便于排查
            const errorMessage = e instanceof Error ? e.message : String(e);
            logDebug("asset-report-service", "skill_build_error", {
                skillDir,
                error: errorMessage,
            });
        }
    }

    logDebug("asset-report-service", "skills_internal_success", {
        total: skillPaths.length,
        skillCount: skills.length,
        eligibleCount: eligibleIds.length,
        rootDirsCount: rootDirs.length,
    });

    return { skills, eligibleIds };
}

// ============================================================================
// Plugins Internal Collector
// ============================================================================

/** Plugin 记录（对齐 PluginsListJsonOutput["plugins"][number]） */
export type PluginRecord = {
    id: string;
    name: string;
    description?: string;
    version?: string;
    source: string;
    origin: string;
    workspaceDir?: string;
    enabled: boolean;
    status: "loaded" | "disabled" | "error";
    error?: string;
    toolNames: string[];
    hookNames: string[];
    channelIds: string[];
    providerIds: string[];
    gatewayMethods: string[];
    cliCommands: string[];
    services: string[];
    commands: string[];
    httpHandlers: number;
    hookCount: number;
    configSchema: boolean;
};

/**
 * 进程内采集 Plugins 列表（替代 `openclaw plugins list --json`）
 *
 * 流程：
 * 1. 解析 plugin 源根目录（bundled / global / workspace / config extra / installs）
 * 2. 扫描含 openclaw.plugin.json 的子目录
 * 3. 读取 manifest 提取元数据
 * 4. 评估 enable 状态
 *
 * 兼容性：纯磁盘发现天然兼容所有版本。
 */
export async function collectPluginsInternal(api: OpenClawPluginApi): Promise<PluginRecord[]> {
    const config = api.config;

    // 1. 解析 plugin 源根目录
    const sourceRoots = resolvePluginSourceRoots(config);

    // 2-3. 扫描并读取 manifest
    const seen = new Set<string>();
    const plugins: PluginRecord[] = [];

    for (const { dir, origin } of sourceRoots) {
        try {
            const discovered = discoverPluginsInDirectory(dir, origin, seen);
            plugins.push(...discovered);
        } catch (e: unknown) {
            // 单个源目录失败不影响整体，但记录 debug 便于排查
            const errorMessage = e instanceof Error ? e.message : String(e);
            logDebug("asset-report-service", "plugin_source_scan_error", {
                dir,
                origin,
                error: errorMessage,
            });
        }
    }

    // 4. 评估 enable 状态
    applyPluginEnableState(plugins, config);

    logDebug("asset-report-service", "plugins_internal_success", {
        pluginCount: plugins.length,
        enabledCount: plugins.filter((p) => p.enabled).length,
        sourceRootsCount: sourceRoots.length,
    });

    return plugins;
}

// ============================================================================
// Skills: SKILL.md Frontmatter Parsing
// ============================================================================

/**
 * SKILL.md frontmatter 解析结果（轻量版，仅资产上报 + eligibility 评估需要的字段）
 *
 * 已移除 emoji / homepage：A2 粒度下 SkillInfo 不再外发。
 * `primaryEnv` 仅用于 `env` requirement 里 apiKey 匹配（对齐 core `shouldIncludeSkill`
 * 的 hasEnv 兜底），不写入对外 SkillInfo。
 */
type SkillFrontmatter = {
    name?: string;
    description?: string;
    always?: boolean;
    os?: string[];
    primaryEnv?: string;
    requires?: {
        bins?: string[];
        anyBins?: string[];
        env?: string[];
        config?: string[];
    };
};

/**
 * 从 SKILL.md 中提取 YAML frontmatter
 *
 * 轻量实现：用正则提取 --- 之间的 YAML block，手动解析扁平 key-value。
 * 不引入 YAML parser 依赖以控制供应链攻击面。
 *
 * **支持的语法子集**（满足 SKILL.md 的基本需求）：
 * - 顶层键值对：key: value（字符串、布尔值 "true"/"false"）
 * - 简单行内数组：key: [item1, item2]
 * - requires 下的一级嵌套列表：bins / anyBins / env / config
 * - os 顶层列表
 * - 单/双引号包裹的字符串值（简单去引号）
 *
 * **不支持**：多行字符串（|、>）、转义字符（\n、\t）、嵌套对象、
 * YAML 原生类型（null、数字）、锚点/别名、注释内联值。
 */
function parseSkillFrontmatter(content: string): SkillFrontmatter {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return {};

    const yamlBlock = match[1];
    const result: SkillFrontmatter = {};
    const lines = yamlBlock.split("\n");

    let currentSection: string | null = null;
    let currentList: string[] = [];

    const flushList = () => {
        if (currentSection && currentList.length > 0) {
            if (!result.requires) result.requires = {};
            if (currentSection === "bins") result.requires.bins = currentList;
            else if (currentSection === "any_bins" || currentSection === "anyBins")
                result.requires.anyBins = currentList;
            else if (currentSection === "env") result.requires.env = currentList;
            else if (currentSection === "config") result.requires.config = currentList;
            else if (currentSection === "os") result.os = currentList;
        }
        currentSection = null;
        currentList = [];
    };

    let inRequires = false;

    for (const line of lines) {
        const trimmed = line.trimEnd();

        // Skip empty/comment lines
        if (!trimmed || trimmed.startsWith("#")) continue;

        // Detect list item
        const listMatch = trimmed.match(/^\s+-\s+(.+)/);
        if (listMatch && currentSection) {
            currentList.push(listMatch[1].trim().replace(/^["']|["']$/g, ""));
            continue;
        }

        // Detect nested key under requires:
        if (inRequires) {
            const nestedMatch = trimmed.match(/^\s{2,}(\w+)\s*:/);
            if (nestedMatch) {
                flushList();
                currentSection = nestedMatch[1];
                // Check inline value
                const inlineValue = trimmed.slice(trimmed.indexOf(":") + 1).trim();
                if (inlineValue && inlineValue.startsWith("[")) {
                    // Inline array: [a, b, c]
                    const items = inlineValue
                        .replace(/[\[\]]/g, "")
                        .split(",")
                        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
                        .filter(Boolean);
                    currentList = items;
                    flushList();
                }
                continue;
            }
        }

        // Top-level key
        const topMatch = trimmed.match(/^(\w+)\s*:\s*(.*)/);
        if (!topMatch) continue;

        flushList();
        const key = topMatch[1];
        const value = topMatch[2].trim().replace(/^["']|["']$/g, "");

        if (key === "requires") {
            inRequires = true;
            continue;
        }

        inRequires = false;

        switch (key) {
            case "name":
                result.name = value || undefined;
                break;
            case "description":
                result.description = value || undefined;
                break;
            case "always":
                result.always = value === "true";
                break;
            case "primaryEnv":
            case "primary_env":
                result.primaryEnv = value || undefined;
                break;
            case "os":
                if (value.startsWith("[")) {
                    result.os = value
                        .replace(/[\[\]]/g, "")
                        .split(",")
                        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
                        .filter(Boolean);
                } else {
                    currentSection = "os";
                }
                break;
        }
    }

    flushList();
    return result;
}

// ============================================================================
// Skills: Eligibility Evaluation
// ============================================================================

/** 检查 PATH 中是否存在指定二进制 */
function hasBinary(bin: string): boolean {
    const pathEnv = process.env.PATH ?? "";
    const parts = pathEnv.split(path.delimiter).filter(Boolean);
    const extensions =
        process.platform === "win32"
            ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
            : [""];

    for (const part of parts) {
        for (const ext of extensions) {
            try {
                fs.accessSync(path.join(part, bin + ext), fs.constants.X_OK);
                return true;
            } catch {
                // continue
            }
        }
    }
    return false;
}

/**
 * 构建单个 SkillInfo 记录
 *
 * 返回 `{ skill, eligible, sourceId }`：
 * - `skill`：对外发送的 SkillInfo（A2 粒度，仅 name/description/source）
 * - `eligible`：基于 disabled + allowlist + requirements 计算的可用性（进程内使用，供 agent.skills 过滤）
 * - `sourceId`：`${source}/${name}` 形式的稳定 ID
 *
 * requirements 评估仍然执行，但**不再组装 `missing` 结构化对象**——只需要一个布尔结果。
 */
function buildSkillInfo(
    skillDir: string,
    config: OpenClawConfig,
    bundledSkillsDir: string | undefined,
    allowBundled: string[] | undefined,
): { skill: SkillInfo; eligible: boolean; sourceId: string } | null {
    const skillMdPath = path.join(skillDir, "SKILL.md");
    let content: string;
    try {
        content = fs.readFileSync(skillMdPath, "utf-8");
    } catch {
        return null;
    }

    const fm = parseSkillFrontmatter(content);
    const skillName = fm.name ?? path.basename(skillDir);
    const source = classifySkillSource(skillDir, bundledSkillsDir);
    const bundled = source === "openclaw-bundled";

    // Resolve skill key (used for config lookup)
    const skillKey = bundled ? skillName : `${source}/${skillName}`;

    // Disabled check
    const skillConfig = resolveSkillConfigEntry(config, skillKey, skillName);
    const disabled = skillConfig?.enabled === false;

    // Allowlist check
    const blockedByAllowlist =
        bundled &&
        allowBundled != null &&
        allowBundled.length > 0 &&
        !allowBundled.includes(skillKey) &&
        !allowBundled.includes(skillName);

    // Requirements check（仅计算布尔结果，不再构造 missing 对象）
    let requirementsSatisfied = true;

    // OS check
    if (fm.os && fm.os.length > 0 && !fm.os.includes(process.platform)) {
        requirementsSatisfied = false;
    }

    // Bins check（全部必需）
    if (requirementsSatisfied && fm.requires?.bins && fm.requires.bins.length > 0) {
        if (fm.requires.bins.some((b) => !hasBinary(b))) {
            requirementsSatisfied = false;
        }
    }

    // Any bins check（至少一个存在）
    if (requirementsSatisfied && fm.requires?.anyBins && fm.requires.anyBins.length > 0) {
        if (!fm.requires.anyBins.some((b) => hasBinary(b))) {
            requirementsSatisfied = false;
        }
    }

    // Env check（对齐 core `shouldIncludeSkill` 的 hasEnv 语义：
    //   process.env → skillConfig.env → `apiKey && primaryEnv===envName` 兜底）
    if (requirementsSatisfied && fm.requires?.env && fm.requires.env.length > 0) {
        const missingEnv = fm.requires.env.some((envName) => {
            if (process.env[envName]) return false;
            if (skillConfig?.env?.[envName]) return false;
            if (skillConfig?.apiKey && fm.primaryEnv === envName) return false;
            return true;
        });
        if (missingEnv) {
            requirementsSatisfied = false;
        }
    }

    // Config path check
    if (requirementsSatisfied && fm.requires?.config && fm.requires.config.length > 0) {
        if (fm.requires.config.some((c) => !isConfigPathTruthy(config, c))) {
            requirementsSatisfied = false;
        }
    }

    // always=true skills 绕过 requirements
    if (fm.always === true) {
        requirementsSatisfied = true;
    }

    const eligible = !disabled && !blockedByAllowlist && requirementsSatisfied;

    return {
        skill: {
            name: skillName,
            description: fm.description,
            source,
        },
        eligible,
        sourceId: `${source}/${skillName}`,
    };
}

/** 判断来源分类 */
function classifySkillSource(skillDir: string, bundledSkillsDir: string | undefined): string {
    if (!bundledSkillsDir) return "unknown";
    try {
        const resolved = path.resolve(skillDir);
        const bundledResolved = path.resolve(bundledSkillsDir);
        if (resolved.startsWith(bundledResolved + path.sep) || resolved === bundledResolved) {
            return "openclaw-bundled";
        }
    } catch {
        // ignore
    }
    return "unknown";
}

/** 获取 bundled skills 目录（仅用于分类判断） */
function resolveBundledSkillsDirForClassification(): string | undefined {
    const override = process.env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
    if (override) return override;

    const pkgRoot = findOpenClawPackageRoot();
    if (!pkgRoot) return undefined;

    const skillsDir = path.join(pkgRoot, "skills");
    return fs.existsSync(skillsDir) ? skillsDir : undefined;
}

/** 解析 skill 配置条目 */
function resolveSkillConfigEntry(
    config: OpenClawConfig,
    skillKey: string,
    skillName: string,
): { enabled?: boolean; env?: Record<string, string>; apiKey?: string } | undefined {
    const entries = config.skills?.entries;
    if (!entries || typeof entries !== "object") return undefined;
    const record = entries as Record<
        string,
        { enabled?: boolean; env?: Record<string, string>; apiKey?: string } | undefined
    >;
    return record[skillKey] ?? record[skillName];
}

/**
 * 与 core `src/shared/config-eval.ts#isTruthy` 等价。
 * bool→自身；number→非 0；string→trim 非空；其它非 nullish → true。
 */
function isTruthy(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value.trim().length > 0;
    return true;
}

/** 按 "a.b.c" 路径解析配置值，中间节点非对象返回 undefined */
function resolveConfigPath(config: unknown, pathStr: string): unknown {
    const parts = pathStr.split(".").filter(Boolean);
    let current: unknown = config;
    for (const part of parts) {
        if (current == null || typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

/**
 * 与 core `src/agents/skills/config.ts#DEFAULT_CONFIG_VALUES` 保持同步。
 * 仅当配置路径 === undefined 时回退；用户显式写入 false / "" / 0 视为用户意图。
 */
const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
    "browser.enabled": true,
    "browser.evaluateEnabled": true,
};

/** Config path truthy 检查（对齐 core `isConfigPathTruthyWithDefaults` 语义） */
function isConfigPathTruthy(config: OpenClawConfig, pathStr: string): boolean {
    const value = resolveConfigPath(config, pathStr);
    if (value === undefined && Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG_VALUES, pathStr)) {
        return DEFAULT_CONFIG_VALUES[pathStr] ?? false;
    }
    return isTruthy(value);
}

/** 标准化 allowBundled 白名单 */
function normalizeAllowlist(input: unknown): string[] | undefined {
    if (!Array.isArray(input)) return undefined;
    const result = input
        .filter((v): v is string => typeof v === "string")
        .map((s) => s.trim())
        .filter(Boolean);
    return result.length > 0 ? result : undefined;
}

// ============================================================================
// Plugins: Source Root Resolution
// ============================================================================

/** Plugin manifest 文件名 */
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";

/** 扫描时忽略的目录名 */
const IGNORE_DIRS = new Set([
    ".git",
    ".hg",
    ".svn",
    ".turbo",
    ".yarn",
    ".yarn-cache",
    "build",
    "coverage",
    "dist",
    "node_modules",
]);

type PluginSourceRoot = { dir: string; origin: string };

/**
 * 解析 plugin 源根目录（对齐 resolvePluginSourceRoots + discoverOpenClawPlugins 的发现范围）
 *
 * 来源优先级：config extra → workspace → bundled → global
 * 额外来源：config.plugins.installs 中的 installPath（兼容旧版直接安装）
 */
function resolvePluginSourceRoots(config: OpenClawConfig): PluginSourceRoot[] {
    const roots: PluginSourceRoot[] = [];
    const seen = new Set<string>();

    const addRoot = (dir: string, origin: string) => {
        const resolved = path.resolve(dir);
        if (seen.has(resolved)) return;
        seen.add(resolved);
        if (directoryExists(resolved)) {
            roots.push({ dir: resolved, origin });
        }
    };

    // Config extra paths (load.paths)
    const loadPaths = config.plugins?.load?.paths;
    if (Array.isArray(loadPaths)) {
        for (const raw of loadPaths) {
            const cleaned = cleanPathInput(raw);
            if (cleaned) addRoot(cleaned, "config");
        }
    }

    // Workspace extensions
    const workspaceDir = resolveWorkspaceDir(config);
    if (workspaceDir) {
        addRoot(path.join(workspaceDir, ".openclaw", "extensions"), "workspace");
    }

    // Bundled extensions
    const bundledDir = resolveBundledPluginsDir();
    if (bundledDir) {
        addRoot(bundledDir, "bundled");
    }

    // Global extensions
    const home = os.homedir();
    addRoot(path.join(home, ".openclaw", "extensions"), "global");

    // Config installs (兼容旧版：直接从 config 中读取 installPath)
    const installs = config.plugins?.installs;
    if (installs && typeof installs === "object") {
        for (const record of Object.values(installs)) {
            const cleaned = cleanPathInput(record?.installPath);
            if (cleaned && directoryExists(cleaned)) {
                // installPath 直接指向插件根目录，不是父目录
                // 只要含有 manifest 就作为独立插件处理
                addPluginDirDirectly(cleaned, "installed", seen, roots);
            }
        }
    }

    return roots;
}

/** 直接添加单个插件目录（非扫描子目录） */
function addPluginDirDirectly(
    pluginDir: string,
    origin: string,
    seen: Set<string>,
    roots: PluginSourceRoot[],
): void {
    const resolved = path.resolve(pluginDir);
    if (seen.has(resolved)) return;
    const manifestPath = path.join(resolved, PLUGIN_MANIFEST_FILENAME);
    if (fileExistsSync(manifestPath)) {
        seen.add(resolved);
        // 标记为"直接插件目录"供 discoverPluginsInDirectory 使用
        roots.push({ dir: resolved, origin: `${origin}:direct` });
    }
}

/** 解析 workspaceDir（从 config 或 agents 配置推断） */
function resolveWorkspaceDir(config: OpenClawConfig): string | undefined {
    // 优先用 agents defaults workspace
    const defaultWs = config.agents?.defaults?.workspace;
    if (typeof defaultWs === "string" && defaultWs.trim()) {
        const cleaned = cleanPathInput(defaultWs);
        if (cleaned) return cleaned;
    }
    // 尝试第一个 agent 的 workspace
    const firstAgent = config.agents?.list?.[0];
    if (firstAgent?.workspace) {
        const cleaned = cleanPathInput(firstAgent.workspace);
        if (cleaned) return cleaned;
    }
    return undefined;
}

/**
 * 解析 bundled plugins 目录（对齐 resolveBundledPluginsDir 逻辑）
 *
 * 查找策略：
 * 1. OPENCLAW_BUNDLED_PLUGINS_DIR 环境变量
 * 2. OPENCLAW_DISABLE_BUNDLED_PLUGINS → 空临时目录
 * 3. argv[1] / cwd 包根 → extensions/ 或 dist/extensions/ 或 dist-runtime/extensions/
 * 4. 向上遍历找 extensions/ 子目录
 */
function resolveBundledPluginsDir(): string | undefined {
    // Disabled check
    const disabled = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS?.trim()?.toLowerCase();
    if (disabled === "1" || disabled === "true") return undefined;

    // Env override
    const override = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
    if (override && directoryExists(override)) return override;

    // From argv[1] package root
    const argv1 = process.argv[1];
    if (!argv1) return undefined;

    const candidates: string[] = [path.dirname(path.resolve(argv1))];
    try {
        const resolved = fs.realpathSync(path.resolve(argv1));
        if (resolved !== path.resolve(argv1)) {
            candidates.push(path.dirname(resolved));
        }
    } catch {
        /* ignore */
    }

    for (const start of candidates) {
        let current = start;
        for (let depth = 0; depth < 6; depth++) {
            try {
                const pkgRaw = fs.readFileSync(path.join(current, "package.json"), "utf-8");
                const pkg = JSON.parse(pkgRaw) as { name?: unknown };
                if (pkg.name === "openclaw") {
                    // Check dist-runtime/extensions first, then dist/extensions, then extensions
                    for (const subDir of ["dist-runtime/extensions", "dist/extensions", "extensions"]) {
                        const candidate = path.join(current, subDir);
                        if (directoryExists(candidate)) return candidate;
                    }
                }
            } catch {
                /* ignore */
            }
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    }

    // Fallback: walk up from module
    // Since we can't use import.meta.url in all contexts, use argv[1] based search
    return undefined;
}

// ============================================================================
// Plugins: Directory Scanning & Manifest Reading
// ============================================================================

/**
 * 扫描目录中的插件（读取 openclaw.plugin.json manifest）
 *
 * 支持两种模式：
 * - origin 以 ":direct" 结尾：dir 本身就是插件目录
 * - 否则：dir 是父目录，扫描子目录
 */
function discoverPluginsInDirectory(
    dir: string,
    origin: string,
    seen: Set<string>,
): PluginRecord[] {
    const plugins: PluginRecord[] = [];
    const cleanOrigin = origin.replace(/:direct$/, "");

    // Direct mode: dir itself is a plugin
    if (origin.endsWith(":direct")) {
        const record = readPluginFromDir(dir, cleanOrigin);
        if (record) plugins.push(record);
        return plugins;
    }

    // Scan child directories
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return plugins;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;

        const pluginDir = path.join(dir, entry.name);
        const resolved = path.resolve(pluginDir);
        if (seen.has(resolved)) continue;

        const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILENAME);
        if (!fileExistsSync(manifestPath)) continue;

        seen.add(resolved);
        const record = readPluginFromDir(pluginDir, cleanOrigin);
        if (record) plugins.push(record);
    }

    return plugins;
}

/** 从插件目录读取 manifest 并构建 PluginRecord */
function readPluginFromDir(pluginDir: string, origin: string): PluginRecord | null {
    const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILENAME);
    let raw: string;
    try {
        raw = fs.readFileSync(manifestPath, "utf-8");
    } catch {
        return null;
    }

    let manifest: Record<string, unknown>;
    try {
        manifest = JSON.parse(raw);
    } catch (e: unknown) {
        // manifest JSON 解析失败属于异常，需 warn 让运维可见
        const errorMessage = e instanceof Error ? e.message : String(e);
        logWarn("asset-report-service", "plugin_manifest_parse_error", {
            pluginDir,
            error: errorMessage,
        });
        return null;
    }

    const id = normalizeString(manifest.id);
    if (!id) return null;

    // Extract tool names from contracts.tools (string[])
    const toolNames: string[] = [];
    const contracts = manifest.contracts;
    if (contracts && typeof contracts === "object" && !Array.isArray(contracts)) {
        const tools = (contracts as Record<string, unknown>).tools;
        if (Array.isArray(tools)) {
            for (const t of tools) {
                if (typeof t === "string" && t.trim()) {
                    toolNames.push(t.trim());
                }
            }
        }
    }

    // Extract command names from commandAliases
    const commands: string[] = [];
    if (Array.isArray(manifest.commandAliases)) {
        for (const alias of manifest.commandAliases) {
            if (alias && typeof alias === "object" && typeof (alias as Record<string, unknown>).name === "string") {
                commands.push((alias as Record<string, unknown>).name as string);
            }
        }
    }

    return {
        id,
        name: normalizeString(manifest.name) ?? id,
        description: normalizeString(manifest.description),
        version: normalizeString(manifest.version),
        source: manifestPath,
        origin,
        enabled: true, // will be resolved later
        status: "loaded",
        toolNames,
        hookNames: [],
        channelIds: normalizeStringArray(manifest.channels),
        providerIds: normalizeStringArray(manifest.providers),
        gatewayMethods: [],
        cliCommands: normalizeStringArray(manifest.cliBackends),
        services: [],
        commands,
        httpHandlers: 0,
        hookCount: 0,
        configSchema: manifest.configSchema != null && typeof manifest.configSchema === "object",
    };
}

// ============================================================================
// Plugins: Enable State Resolution
// ============================================================================

/**
 * 应用 enable 状态（对齐 resolveEffectiveEnableState 简化版）
 *
 * 优先级：
 * 1. 全局开关 plugins.enabled === false → 全部 disabled
 * 2. 显式条目 plugins.entries[id].enabled → 直接用
 * 3. deny list → disabled
 * 4. allow list → 不在列表中则 disabled
 * 5. manifest enabledByDefault → 用于 bundled
 * 6. 兜底：bundled → enabled，其他 → enabled
 */
function applyPluginEnableState(plugins: PluginRecord[], config: OpenClawConfig): void {
    const pluginsConfig = config.plugins;

    // 全局开关
    const globalEnabled = pluginsConfig?.enabled;
    if (globalEnabled === false) {
        // 非常规配置：全局禁用所有插件，用 warn 让运维可见
        logWarn("asset-report-service", "plugins_globally_disabled", {
            pluginCount: plugins.length,
        });
        for (const plugin of plugins) {
            plugin.enabled = false;
            plugin.status = "disabled";
        }
        return;
    }

    // 构建 deny/allow 集合
    const deny = normalizeStringSet(pluginsConfig?.deny);
    const allow = normalizeStringSet(pluginsConfig?.allow);
    const entries = pluginsConfig?.entries;

    for (const plugin of plugins) {
        let enabled: boolean;

        // 显式条目
        const entry = entries && typeof entries === "object"
                ? (entries as Record<string, { enabled?: boolean } | undefined>)[plugin.id]
                : undefined;
        if (entry && typeof entry.enabled === "boolean") {
            enabled = entry.enabled;
        } else if (deny && deny.has(plugin.id)) {
            enabled = false;
        } else if (allow && allow.size > 0 && !allow.has(plugin.id)) {
            enabled = false;
        } else {
            // 兜底：默认 enabled
            enabled = true;
        }

        plugin.enabled = enabled;
        plugin.status = enabled ? "loaded" : "disabled";
    }
}

// ============================================================================
// Utility Helpers
// ============================================================================

function normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(normalizeString)
        .filter((s): s is string => s !== undefined);
}

function normalizeStringSet(value: unknown): Set<string> | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value
        .filter((v): v is string => typeof v === "string")
        .map(s => s.trim())
        .filter(Boolean);
    return items.length > 0 ? new Set(items) : undefined;
}

function directoryExists(dirPath: string): boolean {
    try {
        return fs.statSync(dirPath).isDirectory();
    } catch {
        return false;
    }
}

function fileExistsSync(filePath: string): boolean {
    try {
        fs.accessSync(filePath);
        return true;
    } catch {
        return false;
    }
}
