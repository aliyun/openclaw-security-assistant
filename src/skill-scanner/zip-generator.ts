/**
 * ZIP 生成器 — 对齐 Python zipfile 格式
 *
 * 生成的 ZIP 与 Python zipfile.ZipFile(path, "w", ZIP_DEFLATED) 逐字节一致：
 *  - 无 Data Descriptor (bit 3 = 0)
 *  - 无 Extra Field
 *  - create_system = 3 (Unix), create_version = 20
 *  - 压缩级别: Z_DEFAULT_COMPRESSION (level 6)
 *  - wbits = -15 (raw deflate)
 *  - 归档路径: baseName/relativePath
 *
 * 非阻塞：每个文件使用 zlib.deflateRaw() 异步压缩（libuv 线程池），不占用 JS 主线程。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const deflateRaw = promisify(zlib.deflateRaw);

// ============================================================================
// DOS DateTime
// ============================================================================

/**
 * Fixed DOS timestamp: 1980-01-01 00:00:00
 *
 * Using a fixed epoch ensures identical file content always produces the same
 * ZIP bytes (and therefore the same SHA-256), regardless of filesystem mtime.
 */
const DOS_EPOCH_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1; // 0x0021
const DOS_EPOCH_TIME = 0;

// ============================================================================
// 文件名编码 (对齐 Python ZipInfo._encodeFilenameFlags)
// ============================================================================

function encodeFilename(name: string): { encoded: Buffer; flagBits: number } {
    // Python: ASCII 成功 → flag=0, 否则 UTF-8 + flag=0x0800 (bit 11)
    const isAscii = /^[\x00-\x7f]*$/.test(name);
    if (isAscii) {
        return { encoded: Buffer.from(name, "ascii"), flagBits: 0 };
    }
    return { encoded: Buffer.from(name, "utf-8"), flagBits: 0x0800 };
}

// ============================================================================
// ZIP 二进制结构 (精确复刻 Python zipfile 的 struct.pack 格式)
// ============================================================================

interface ZipEntry {
    localHeaderOffset: number;
    crc: number;
    compressedSize: number;
    uncompressedSize: number;
    dosTime: number;
    dosDate: number;
    externalAttr: number;
    flagBits: number;
}

/**
 * Local File Header: struct.pack("<4s2B4HL2L2H", ...)
 * 30 bytes fixed + filename
 */
function buildLocalFileHeader(entry: ZipEntry, filenameBytes: Buffer): Buffer {
    const buf = Buffer.alloc(30);
    buf.writeUInt32LE(0x04034b50, 0);       // signature: PK\x03\x04
    buf.writeUInt8(20, 4);                   // extract version: 20
    buf.writeUInt8(0, 5);                    // reserved (extract system): 0
    buf.writeUInt16LE(entry.flagBits, 6);    // general purpose bit flags
    buf.writeUInt16LE(8, 8);                 // compression method: 8 (deflate)
    buf.writeUInt16LE(entry.dosTime, 10);    // last mod time
    buf.writeUInt16LE(entry.dosDate, 12);    // last mod date
    buf.writeUInt32LE(entry.crc, 14);        // CRC-32
    buf.writeUInt32LE(entry.compressedSize, 18);  // compressed size
    buf.writeUInt32LE(entry.uncompressedSize, 22); // uncompressed size
    buf.writeUInt16LE(filenameBytes.length, 26);   // filename length
    buf.writeUInt16LE(0, 28);                // extra field length: 0
    return Buffer.concat([buf, filenameBytes]);
}

/**
 * Central Directory Entry: struct.pack("<4s4B4HL2L5H2L", ...)
 * 46 bytes fixed + filename
 */
function buildCentralDirectoryEntry(entry: ZipEntry, filenameBytes: Buffer): Buffer {
    const buf = Buffer.alloc(46);
    buf.writeUInt32LE(0x02014b50, 0);       // signature: PK\x01\x02
    buf.writeUInt8(20, 4);                   // create version: 20
    buf.writeUInt8(3, 5);                    // create system: 3 (Unix)
    buf.writeUInt8(20, 6);                   // extract version: 20
    buf.writeUInt8(0, 7);                    // extract system: 0
    buf.writeUInt16LE(entry.flagBits, 8);    // general purpose bit flags
    buf.writeUInt16LE(8, 10);                // compression method: 8 (deflate)
    buf.writeUInt16LE(entry.dosTime, 12);    // last mod time
    buf.writeUInt16LE(entry.dosDate, 14);    // last mod date
    buf.writeUInt32LE(entry.crc, 16);        // CRC-32
    buf.writeUInt32LE(entry.compressedSize, 20);   // compressed size
    buf.writeUInt32LE(entry.uncompressedSize, 24); // uncompressed size
    buf.writeUInt16LE(filenameBytes.length, 28);   // filename length
    buf.writeUInt16LE(0, 30);                // extra field length: 0
    buf.writeUInt16LE(0, 32);                // comment length: 0
    buf.writeUInt16LE(0, 34);                // disk number start: 0
    buf.writeUInt16LE(0, 36);                // internal attributes: 0
    buf.writeUInt32LE(entry.externalAttr, 38); // external attributes
    buf.writeUInt32LE(entry.localHeaderOffset, 42); // local header offset
    return Buffer.concat([buf, filenameBytes]);
}

/**
 * End of Central Directory: struct.pack("<4s4H2LH", ...)
 * 22 bytes fixed
 */
function buildEndOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Buffer {
    const buf = Buffer.alloc(22);
    buf.writeUInt32LE(0x06054b50, 0);       // signature: PK\x05\x06
    buf.writeUInt16LE(0, 4);                 // disk number: 0
    buf.writeUInt16LE(0, 6);                 // disk start: 0
    buf.writeUInt16LE(count, 8);             // entries this disk
    buf.writeUInt16LE(count, 10);            // total entries
    buf.writeUInt32LE(cdSize, 12);           // central directory size
    buf.writeUInt32LE(cdOffset, 16);         // central directory offset
    buf.writeUInt16LE(0, 20);                // comment length: 0
    return buf;
}

// ============================================================================
// ZIP 创建
// ============================================================================

/**
 * 将文件列表打包为 ZIP Buffer（对齐 Python zipfile 二进制格式）
 *
 * - 非阻塞：每个文件通过 zlib.deflateRaw() 异步压缩（libuv 线程池）
 * - 体积感知：逐文件累计，超过 maxBytes 立即中止返回 null
 * - 归档路径：baseName/relativePath（与服务端 _create_zip 一致）
 * - 文件顺序：由调用方控制（应与 os.walk + dirs.sort() + files.sort() 一致）
 *
 * @param skillPath - skill 目录绝对路径（用于提取 baseName）
 * @param filePaths - 文件条目列表（顺序决定 ZIP 内文件顺序）
 * @param maxBytes - ZIP 最大体积（字节），超出返回 null
 * @returns ZIP Buffer；无可用文件或体积超限时返回 null
 */
export async function createSkillZip(
    skillPath: string,
    filePaths: ReadonlyArray<{ relativePath: string; fullPath: string }>,
    maxBytes: number,
): Promise<Buffer | null> {
    if (filePaths.length === 0) return null;

    const baseName = path.basename(skillPath);
    const chunks: Buffer[] = [];
    const entries: ZipEntry[] = [];
    const filenameBuffers: Buffer[] = [];
    let offset = 0;

    for (const file of filePaths) {
        // 读取文件内容 + stat（获取 mode/mtime）
        let data: Buffer;
        let stat: fs.Stats;
        try {
            [data, stat] = await Promise.all([
                fs.promises.readFile(file.fullPath),
                fs.promises.stat(file.fullPath),
            ]);
        } catch {
            // 文件在遍历和打包之间消失，跳过
            continue;
        }

        // CRC-32 (zlib.crc32 底层与 Python zipfile 使用同一 C zlib 库)
        const fileCrc = zlib.crc32(data);

        // 异步压缩 (raw deflate, Z_DEFAULT_COMPRESSION = level 6)
        const compressed = await deflateRaw(data);

        // 固定时间戳 1980-01-01 00:00:00，保证相同文件内容产出相同 ZIP 字节
        const dosTime = DOS_EPOCH_TIME;
        const dosDate = DOS_EPOCH_DATE;

        // 外部属性 (与 Python ZipInfo.from_file 一致: (st_mode & 0xFFFF) << 16)
        const externalAttr = ((stat.mode & 0xffff) << 16) >>> 0;

        // 归档路径: baseName/relativePath
        const arcName = `${baseName}/${file.relativePath}`;
        const { encoded: filenameBytes, flagBits } = encodeFilename(arcName);

        const entry: ZipEntry = {
            localHeaderOffset: offset,
            crc: fileCrc,
            compressedSize: compressed.length,
            uncompressedSize: data.length,
            dosTime,
            dosDate,
            externalAttr,
            flagBits,
        };
        entries.push(entry);
        filenameBuffers.push(filenameBytes);

        // Local File Header + 压缩数据
        const localHeader = buildLocalFileHeader(entry, filenameBytes);
        chunks.push(localHeader);
        chunks.push(compressed);
        offset += localHeader.length + compressed.length;

        // 逐文件体积检查（仅计数据部分，CD/EOCD 开销较小）
        if (offset > maxBytes) {
            return null;
        }
    }

    if (entries.length === 0) return null;

    // Central Directory
    const cdOffset = offset;
    for (let i = 0; i < entries.length; i++) {
        const cdEntry = buildCentralDirectoryEntry(entries[i], filenameBuffers[i]);
        chunks.push(cdEntry);
        offset += cdEntry.length;
    }
    const cdSize = offset - cdOffset;

    // End of Central Directory
    const eocd = buildEndOfCentralDirectory(entries.length, cdSize, cdOffset);
    chunks.push(eocd);

    const zipBuffer = Buffer.concat(chunks);

    // 最终体积检查（包含 CD + EOCD）
    if (zipBuffer.length > maxBytes) {
        return null;
    }

    return zipBuffer;
}
