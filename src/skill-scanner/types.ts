/**
 * Skill 安全扫描系统类型定义
 */

// ============================================================================
// 签名表类型
// ============================================================================

/** 单个 skill 的签名条目 */
export type FingerprintEntry = {
    /** 基于 stat 信息计算的 SHA256 签名 */
    fingerprint: string;
    /** 参与计算的文件数量 */
    fileCount: number;
    /** 是否因超过文件数上限而截断 */
    truncated: boolean;
    /** 签名更新时间（ISO 格式） */
    updatedAt: string;
    /** ZIP 内容的 SHA256，scan 流程回填，用于 APS 查询。null = 尚未计算或 fingerprint 已变更待重算 */
    zipSha256: string | null;
};

/** 签名表磁盘持久化格式 */
export type FingerprintStoreData = {
    /** 格式版本号 */
    version: number;
    /** skillPath → FingerprintEntry 映射 */
    entries: Record<string, FingerprintEntry>;
};

// ============================================================================
// 扫描队列类型
// ============================================================================

/** 扫描任务 */
export type ScanTask = {
    /** skill 目录绝对路径 */
    skillPath: string;
    /** 入队时的 fingerprint，用于回填时的乐观锁校验 */
    expectedFingerprint: string;
    /** 当前重试次数（初始为 0） */
    retryCount: number;
    /** 首次遍历收集的文件路径（缓存复用，避免 ZIP 打包时重复遍历；重试时不携带，触发重新遍历） */
    filePaths?: Array<{ relativePath: string; fullPath: string }>;
};

// ============================================================================
// API 交互类型
// ============================================================================

/** GET /v1/agent/skill/check 预检接口响应 */
export type SkillCheckResponse = {
    /** 服务端请求 ID */
    request_id: string;
    /** 与请求对应的 SHA256 */
    sha256: string;
    /** 是否需要上传 ZIP 实体文件 */
    need_upload: boolean;
};

/** POST /v1/agent/skill/check 上传接口响应 */
export type SkillUploadResponse = {
    /** 服务端请求 ID */
    request_id: string;
    /** HTTP 状态码 */
    code: number;
    /** 响应消息 */
    message: string;
};
