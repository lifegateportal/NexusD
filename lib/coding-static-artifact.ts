import {
  isCodingStaticSensitivePath,
  MAX_CODING_STATIC_ARCHIVE_BYTES,
  MAX_CODING_STATIC_OUTPUT_BYTES,
  MAX_CODING_STATIC_ENTRY_COUNT,
  MAX_CODING_STATIC_PATH_BYTES,
  MAX_CODING_STATIC_SEGMENT_BYTES,
} from "@/lib/coding-static-policy";

export {
  MAX_CODING_STATIC_ARCHIVE_BYTES,
  MAX_CODING_STATIC_OUTPUT_BYTES,
  MAX_CODING_STATIC_ENTRY_COUNT,
} from "@/lib/coding-static-policy";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const MAX_CENTRAL_DIRECTORY_BYTES = 2 * 1024 * 1024;

type ZipEntry = {
  name: string;
  isDirectory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  flags: number;
  compression: number;
  crc32: number;
};

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function decodeZipName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The static ZIP contains an invalid file name.");
  }
}

function validateZipPath(name: string, isDirectory: boolean): string {
  const path = isDirectory ? name.slice(0, -1) : name;
  const segments = path.split("/");
  if (
    !path
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes(":")
    || /[\u0000-\u001f\u007f]/.test(path)
    || /^[a-zA-Z]:/.test(path)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("The static ZIP contains an unsafe file path.");
  }
  const encoder = new TextEncoder();
  if (
    encoder.encode(path).byteLength > MAX_CODING_STATIC_PATH_BYTES
    || segments.some((segment) => encoder.encode(segment).byteLength > MAX_CODING_STATIC_SEGMENT_BYTES)
  ) {
    throw new Error("The static ZIP contains a path that is too long.");
  }
  if (isCodingStaticSensitivePath(path)) {
    throw new Error("The static ZIP must not contain credentials or private keys.");
  }
  return path;
}

function parseZipEntries(bytes: Uint8Array): ZipEntry[] {
  const minimumEndRecordOffset = Math.max(0, bytes.length - MAX_ZIP_COMMENT_BYTES - 22);
  let endRecordOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimumEndRecordOffset; offset -= 1) {
    if (readUint32(bytes, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = readUint16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.length) {
      endRecordOffset = offset;
      break;
    }
  }
  if (endRecordOffset < 0) throw new Error("The static artifact is not a valid ZIP archive.");

  const diskNumber = readUint16(bytes, endRecordOffset + 4);
  const centralDirectoryDisk = readUint16(bytes, endRecordOffset + 6);
  const entriesOnDisk = readUint16(bytes, endRecordOffset + 8);
  const entryCount = readUint16(bytes, endRecordOffset + 10);
  const centralDirectorySize = readUint32(bytes, endRecordOffset + 12);
  const centralDirectoryOffset = readUint32(bytes, endRecordOffset + 16);
  if (
    diskNumber !== 0
    || centralDirectoryDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0
    || entryCount > MAX_CODING_STATIC_ENTRY_COUNT
    || entryCount === 0xffff
    || centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES
    || centralDirectoryOffset + centralDirectorySize !== endRecordOffset
  ) {
    throw new Error("The static ZIP uses unsupported or oversized archive features.");
  }

  const entries: ZipEntry[] = [];
  const entryTypes = new Map<string, boolean>();
  let totalOutputBytes = 0;
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > endRecordOffset
      || readUint32(bytes, cursor) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new Error("The static ZIP contains an invalid central directory.");
    }

    const flags = readUint16(bytes, cursor + 8);
    const compression = readUint16(bytes, cursor + 10);
    const crc32 = readUint32(bytes, cursor + 16);
    const compressedSize = readUint32(bytes, cursor + 20);
    const uncompressedSize = readUint32(bytes, cursor + 24);
    const nameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const startDisk = readUint16(bytes, cursor + 34);
    const externalAttributes = readUint32(bytes, cursor + 38);
    const localHeaderOffset = readUint32(bytes, cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      recordEnd > endRecordOffset
      || startDisk !== 0
      || (flags & ~0x0800) !== 0
      || (compression !== 0 && compression !== 8)
      || extraLength !== 0
      || commentLength !== 0
      || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff
    ) {
      throw new Error("The static ZIP contains unsupported file metadata.");
    }

    const rawName = decodeZipName(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const isDirectory = rawName.endsWith("/");
    const name = validateZipPath(rawName, isDirectory);
    const unixMode = externalAttributes >>> 16;
    const unixFileType = unixMode & 0xf000;
    if (
      (unixFileType !== 0 && unixFileType !== 0x8000 && unixFileType !== 0x4000)
      || (isDirectory && unixFileType === 0x8000)
      || (!isDirectory && unixFileType === 0x4000)
      || (isDirectory && (uncompressedSize !== 0 || compressedSize !== 0))
    ) {
      throw new Error("The static ZIP contains a link or unsupported file type.");
    }

    if (entryTypes.has(name)) throw new Error("The static ZIP contains duplicate file paths.");
    const segments = name.split("/");
    for (let parentIndex = 1; parentIndex < segments.length; parentIndex += 1) {
      const parent = segments.slice(0, parentIndex).join("/");
      if (entryTypes.get(parent) === false) {
        throw new Error("The static ZIP contains conflicting file paths.");
      }
    }
    if (!isDirectory && Array.from(entryTypes.keys()).some((existing) => existing.startsWith(`${name}/`))) {
      throw new Error("The static ZIP contains conflicting file paths.");
    }
    entryTypes.set(name, isDirectory);

    const localHeaderEnd = localHeaderOffset + 30;
    if (
      localHeaderEnd > centralDirectoryOffset
      || readUint32(bytes, localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE
    ) {
      throw new Error("The static ZIP contains an invalid local file header.");
    }
    const localFlags = readUint16(bytes, localHeaderOffset + 6);
    const localCompression = readUint16(bytes, localHeaderOffset + 8);
    const localCrc32 = readUint32(bytes, localHeaderOffset + 14);
    const localCompressedSize = readUint32(bytes, localHeaderOffset + 18);
    const localUncompressedSize = readUint32(bytes, localHeaderOffset + 22);
    const localNameLength = readUint16(bytes, localHeaderOffset + 26);
    const localExtraLength = readUint16(bytes, localHeaderOffset + 28);
    const localDataOffset = localHeaderEnd + localNameLength + localExtraLength;
    const localName = decodeZipName(bytes.subarray(localHeaderEnd, localHeaderEnd + localNameLength));
    if (
      localFlags !== flags
      || localCompression !== compression
      || localCrc32 !== crc32
      || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize
      || localExtraLength !== 0
      || localName !== rawName
      || localDataOffset + compressedSize > centralDirectoryOffset
    ) {
      throw new Error("The static ZIP contains mismatched local and central file records.");
    }

    if (!isDirectory) {
      totalOutputBytes += uncompressedSize;
      if (totalOutputBytes > MAX_CODING_STATIC_OUTPUT_BYTES) {
        throw new Error("Built static files must total less than 50 MB when unpacked.");
      }
    }
    entries.push({
      name,
      isDirectory,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      flags,
      compression,
      crc32,
    });
    cursor = recordEnd;
  }

  if (cursor !== endRecordOffset) throw new Error("The static ZIP contains trailing central directory data.");
  const localRecords = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  let previousRecordEnd = 0;
  for (const entry of localRecords) {
    const localHeaderEnd = entry.localHeaderOffset + 30;
    const nameLength = readUint16(bytes, entry.localHeaderOffset + 26);
    const extraLength = readUint16(bytes, entry.localHeaderOffset + 28);
    const recordEnd = localHeaderEnd + nameLength + extraLength + entry.compressedSize;
    if (entry.localHeaderOffset < previousRecordEnd) {
      throw new Error("The static ZIP contains overlapping file records.");
    }
    previousRecordEnd = recordEnd;
  }
  if (previousRecordEnd > centralDirectoryOffset) {
    throw new Error("The static ZIP contains overlapping file data.");
  }

  const rootIndex = entries.find((entry) => entry.name === "index.html" && !entry.isDirectory);
  if (!rootIndex) throw new Error("The built static output must contain index.html at its root.");
  return entries;
}

export function validateCodingStaticArtifact(bytes: Uint8Array): void {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_CODING_STATIC_ARCHIVE_BYTES) {
    throw new Error("The built static ZIP must be smaller than 25 MB.");
  }
  parseZipEntries(bytes);
}
