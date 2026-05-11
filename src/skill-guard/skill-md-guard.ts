/**
 * Skill 运行时安全 Guard
 *
 * 在 before_tool_call 阶段拦截 SKILL.md 的读取操作，
 * 利用 FingerprintStore 中已有的 zipSha256 查询 APS 检测结果，
 * 对存在安全风险的 skill 进行阻断。
 *
 * 设计原则：
 * - Guard 严格只读 FingerprintStore，不做任何写入、不计算 fingerprint、不生成 ZIP
 * - 降级放行：遇到任何查不到、查不通的情况一律放行，不阻碍用户
 * - APS 通信委托给 check.ts 统一处理（共享 headers、token 刷新、错误降级）
 */

import path from "node:path";
import type { SkillFingerprintStore } from "../skill-scanner/skill-fingerprint-store.js";
import type { ReportMeta, BeforeToolCallPayload } from "../report-types.js";
import { checkBeforeToolCall } from "../check.js";
import { logDebug } from "../logger.js";

/** 默认阻断消息（APS 未返回具体原因时使用） */
const DEFAULT_BLOCK_REASON = "security policy violation detected, stop reading SKILL.md";

/** Guard 决策结果 */
type GuardResult = {
    block: true;
    blockReason: string;
};

/** Guard 依赖注入 */
type SkillMdGuardDeps = {
    /** FingerprintStore 引用（只读访问） */
    fingerprintStore: SkillFingerprintStore;
    /** APS 服务地址 */
    protectServerAddr: string;
    /** 原始 fetch（未被安全助手包装的版本） */
    originalFetch: typeof globalThis.fetch;
};

/**
 * 创建 Skill SKILL.md 读取 Guard
 *
 * 返回 handleSkillMdRead 方法，供 before_tool_call hook 调用。
 */
export function createSkillMdGuard(deps: SkillMdGuardDeps) {
    const { fingerprintStore, protectServerAddr, originalFetch } = deps;

    /**
     * 处理 SKILL.md 文件读取请求
     *
     * Guard 决策逻辑（完全信任 FingerprintStore，零文件系统操作）：
     * 1. 路径匹配：basename === "SKILL.md" → 否则放行
     * 2. 解析 skillDir：dirname(resolvedPath)
     * 3. 查 FingerprintStore：无条目则放行
     * 4. 检查 zipSha256：null 则放行
     * 5. 查 APS（通过 check.ts 统一通信）：action !== block 则放行
     * 6. 判断结果：block → 返回阻断信息；否则放行
     *
     * @param resolvedPath - before_tool_call event.params 中的 path 值
     * @param meta - Run 级上报 Meta
     * @param payload - before_tool_call 的完整 Payload（已含 llm_call_id、tool_call_id、tool_payload）
     * @returns GuardResult 表示阻断，undefined 表示放行
     */
    async function handleSkillMdRead(
        resolvedPath: string,
        meta: ReportMeta,
        payload: BeforeToolCallPayload,
    ): Promise<GuardResult | undefined> {
        // 1. 路径匹配：仅拦截 SKILL.md 文件读取
        if (path.basename(resolvedPath) !== "SKILL.md") {
            return undefined;
        }

        // 2. 解析 skillDir（SKILL.md 所在目录的绝对路径即为 skillPath）
        // path.resolve 标准化路径，消除 ".."、"." 和相对路径，确保与 FingerprintStore 中的键匹配
        const skillPath = path.resolve(path.dirname(resolvedPath));
        const skillName = path.basename(skillPath);

        logDebug("skill_guard", "guard_check_start", {
            skillPath,
            skillName,
        });

        // 3. 查 FingerprintStore
        const entry = fingerprintStore.get(skillPath);
        if (!entry) {
            logDebug("skill_guard", "guard_no_entry", { skillPath });
            return undefined;
        }

        // 4. 检查 zipSha256
        if (entry.zipSha256 === null) {
            logDebug("skill_guard", "guard_no_zipsha256", { skillPath });
            return undefined;
        }

        // 5. 查 APS（注入 skill 字段后复用 checkBeforeToolCall 接口）
        const skillPayload: BeforeToolCallPayload = {
            ...payload,
            tool_payload: {
                ...payload.tool_payload,
                check_type: "skill" as const,
                skill_sha256: entry.zipSha256,
                skill_name: skillName,
            },
        };
        const result = await checkBeforeToolCall(meta, skillPayload, protectServerAddr, originalFetch);

        // 6. 判断结果（checkBeforeToolCall 内部已处理降级，此处仅判断 action）
        if (result.action === "block") {
            const blockReason = result.content || DEFAULT_BLOCK_REASON;
            logDebug("skill_guard", "guard_blocked", {
                skillPath,
                reason: blockReason,
            });
            return { block: true, blockReason };
        }

        logDebug("skill_guard", "guard_allowed", { skillPath });
        return undefined;
    }

    return { handleSkillMdRead };
}
