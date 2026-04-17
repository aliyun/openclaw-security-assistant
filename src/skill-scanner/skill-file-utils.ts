/**
 * Skill 文件遍历共享工具
 *
 * 提供目录递归遍历能力，供 skill-fingerprint-store 和 skill-scan-queue 共同使用。
 * 遍历顺序与 Python os.walk() + dirs.sort() + files.sort() 一致：
 *  - 每个目录内先产出所有文件，再递归子目录
 *  - 文件和子目录均按名称字典序排列
 * 不过滤任何文件（与服务端压缩逻辑保持一致）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logDebug } from "../logger.js";

/** 遍历收集的文件条目 */
export type SkillFile = {
    /** 相对于 skill 根目录的路径（统一使用 / 分隔符） */
    relativePath: string;
    /** 文件绝对路径 */
    fullPath: string;
};

/**
 * 递归遍历 skill 目录，收集所有文件路径
 *
 * - 遍历顺序与 Python os.walk() + dirs.sort() + files.sort() 一致
 * - 不过滤任何文件（与服务端压缩逻辑保持一致）
 * - 文件数达到上限时停止并标记截断
 *
 * @param rootDir - skill 目录绝对路径
 * @param maxFiles - 文件数上限
 */
export async function walkSkillDirectory(
    rootDir: string,
    maxFiles: number,
): Promise<{ files: SkillFile[]; truncated: boolean }> {
    const files: SkillFile[] = [];
    const truncated = await collectPaths(rootDir, rootDir, files, maxFiles);
    return { files, truncated };
}

// ============================================================================
// 内部递归辅助
// ============================================================================

/**
 * 递归收集目录内文件路径（os.walk 顺序：当前目录文件 → 子目录递归）
 */
async function collectPaths(
    dirPath: string,
    baseDir: string,
    files: SkillFile[],
    maxFiles: number,
): Promise<boolean> {
    let dirEntries: fs.Dirent[];
    try {
        dirEntries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
        return false;
    }

    // 按名称排序（与 Python os.walk + dirs.sort() + files.sort() 对齐）
    // 使用基础字符串比较（Unicode 码点序），与 Python str 默认排序行为一致
    dirEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // 先收集当前目录的文件，再递归子目录（与 Python os.walk 行为一致）
    const subdirs: string[] = [];

    for (const entry of dirEntries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            subdirs.push(fullPath);
        } else if (entry.isFile()) {
            if (files.length >= maxFiles) {
                logDebug("skill_scanner", "walk_files_truncated", {
                    dir: dirPath,
                    file: entry.name,
                    maxFiles,
                });
                return true;
            }
            const relativePath = path.relative(baseDir, fullPath).split(path.sep).join("/");
            files.push({ relativePath, fullPath });
        }
    }

    for (const subdir of subdirs) {
        const truncated = await collectPaths(subdir, baseDir, files, maxFiles);
        if (truncated) return true;
    }

    return false;
}
