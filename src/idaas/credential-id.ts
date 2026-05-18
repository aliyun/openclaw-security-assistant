/**
 * 凭据 ID 生成模块
 *
 * 生成托管凭据的两种唯一标识：aegisId 和 idaasId。
 */

import { createHash } from "node:crypto";

/** 凭据 ID 生成用固定盐 */
const CREDENTIAL_ID_SALT = "openclaw-idaas-credential";

// ──────────────── Helpers ────────────────

/**
 * Base32 编码（RFC 4648，无 padding）
 */
function base32Encode(buffer: Buffer): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let result = "";
    let bits = 0;
    let value = 0;
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            result += alphabet[(value >>> (bits - 5)) & 0x1f];
            bits -= 5;
        }
    }
    if (bits > 0) {
        result += alphabet[(value << (5 - bits)) & 0x1f];
    }
    return result;
}

// ──────────────── Public API ────────────────

export type CredentialIds = {
    aegisId: string;
    idaasId: string;
};

/**
 * 生成凭据标识
 *
 * aegisId:  SHA256(aiscAppId + "#" + apiKey) 十六进制
 * idaasId:  userId + "_" + Base32(SHA1(CREDENTIAL_ID_SALT, userId, aiscAppId, apiKey))
 */
export function generateCredentialId(params: {
    userId: string;
    apiKey: string;
    aiscAppId: string;
}): CredentialIds {
    const { aiscAppId, userId, apiKey } = params;

    if (!userId || !apiKey || !aiscAppId) {
        throw new Error(
            `generateCredentialId: missing required param (userId=${!!userId}, apiKey=${!!apiKey}, aiscAppId=${!!aiscAppId})`,
        );
    }

    const aegisId = createHash("sha256")
        .update(`${aiscAppId}#${apiKey}`)
        .digest("hex");

    const idaasId = `${userId}_${base32Encode(
        createHash("sha1")
            .update(CREDENTIAL_ID_SALT)
            .update(userId)
            .update(aiscAppId)
            .update(apiKey)
            .digest(),
    )}`;

    return { aegisId, idaasId };
}
