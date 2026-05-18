/**
 * IdaaS 路径常量与解析 helper
 *
 * 所有 IdaaS 相关文件的路径常量和解析函数集中在此，
 * 供 idaas-config、idaas-cli、access-token-service、credential-hosting-service 等模块复用。
 */

import path from "node:path";

// ============================================================================
// Constants
// ============================================================================

/** IdaaS 统一持久化目录名（位于 stateDir 下） */
export const IDAAS_PERSIST_DIR_NAME = "alicloud-idaas";

/** IdaaS CLI 二进制文件名（Windows 需要 .exe 后缀） */
export const IDAAS_CLI_FILENAME = process.platform === "win32"
    ? "alibaba-cloud-idaas.exe"
    : "alibaba-cloud-idaas";

/** IdaaS profile 配置文件名 */
export const IDAAS_PROFILE_FILENAME = "alibaba-cloud-idaas.json";

// ============================================================================
// Path Resolvers
// ============================================================================

/**
 * 解析 IdaaS 持久化目录的绝对路径
 *
 * @param stateDir - OpenClaw state 目录（如 ~/.openclaw）
 * @returns {stateDir}/alicloud-idaas
 */
export function resolveIdaasPersistDir(stateDir: string): string {
    return path.join(stateDir, IDAAS_PERSIST_DIR_NAME);
}

/** 根据 idaasDir 解析 CLI 绝对路径 */
export function resolveCliPath(idaasDir: string): string {
    return path.join(idaasDir, IDAAS_CLI_FILENAME);
}

/** 根据 idaasDir 解析 IdaaS profile 绝对路径 */
export function resolveProfilePath(idaasDir: string): string {
    return path.join(idaasDir, IDAAS_PROFILE_FILENAME);
}
