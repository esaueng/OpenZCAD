import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';

import type { ShaprImportLimits } from './limits';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_SYMLINK = 0xa000;
const STREAM_CHUNK_BYTES = 64 * 1024;

export interface ShaprArchiveEntry {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  compression: 0 | 8;
}

export interface ShaprArchiveInspection {
  entries: ShaprArchiveEntry[];
  workspace: ShaprArchiveEntry;
  declaredOutputBytes: number;
}

export interface ExtractedShaprArchive {
  workspace: Uint8Array;
  inspection: ShaprArchiveInspection;
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.length - (0xffff + 22));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (readU32(view, offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error('SHAPR archive has no valid ZIP central directory.');
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) {
    throw new Error('SHAPR archive entry names must use UTF-8 or ASCII.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('SHAPR archive contains an invalid UTF-8 entry name.');
  }
}

function validateEntryName(name: string, maxBytes: number): void {
  if (
    name.length === 0 ||
    new TextEncoder().encode(name).length > maxBytes ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error('SHAPR archive contains an unsafe entry name.');
  }
  const segments = name.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..'
    )
  ) {
    throw new Error('SHAPR archive contains an unsafe entry path.');
  }
}

export function inspectShaprArchive(
  bytes: Uint8Array,
  limits: ShaprImportLimits
): ShaprArchiveInspection {
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new Error(
      `SHAPR archive exceeds the ${Math.round(limits.maxArchiveBytes / 1024 / 1024)} MB import limit.`
    );
  }
  if (bytes.byteLength < 22) {
    throw new Error('SHAPR archive is truncated.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  const disk = readU16(view, endOffset + 4);
  const centralDisk = readU16(view, endOffset + 6);
  const diskEntries = readU16(view, endOffset + 8);
  const totalEntries = readU16(view, endOffset + 10);
  const centralBytes = readU32(view, endOffset + 12);
  const centralOffset = readU32(view, endOffset + 16);
  const commentBytes = readU16(view, endOffset + 20);

  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0
  ) {
    throw new Error('Multi-disk and empty SHAPR archives are unsupported.');
  }
  if (
    totalEntries === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 SHAPR archives are unsupported.');
  }
  if (totalEntries > limits.maxEntries) {
    throw new Error(
      `SHAPR archive contains more than ${limits.maxEntries} entries.`
    );
  }
  if (endOffset + 22 + commentBytes !== bytes.byteLength) {
    throw new Error('SHAPR archive has trailing or truncated ZIP data.');
  }
  if (centralOffset + centralBytes !== endOffset) {
    throw new Error('SHAPR archive central directory bounds are invalid.');
  }

  const zip64SearchStart = Math.max(0, endOffset - 56);
  for (let offset = zip64SearchStart; offset <= endOffset - 4; offset += 1) {
    const signature = readU32(view, offset);
    if (
      signature === ZIP64_END_OF_CENTRAL_DIRECTORY ||
      signature === ZIP64_END_LOCATOR
    ) {
      throw new Error('ZIP64 SHAPR archives are unsupported.');
    }
  }

  const entries: ShaprArchiveEntry[] = [];
  const localSpans: Array<{ start: number; end: number }> = [];
  const names = new Set<string>();
  let declaredOutputBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > endOffset ||
      readU32(view, offset) !== CENTRAL_DIRECTORY_ENTRY
    ) {
      throw new Error('SHAPR archive central directory is malformed.');
    }
    const flags = readU16(view, offset + 8);
    const compression = readU16(view, offset + 10);
    const compressedBytes = readU32(view, offset + 20);
    const uncompressedBytes = readU32(view, offset + 24);
    const nameBytes = readU16(view, offset + 28);
    const extraBytes = readU16(view, offset + 30);
    const entryCommentBytes = readU16(view, offset + 32);
    const externalAttributes = readU32(view, offset + 38);
    const localOffset = readU32(view, offset + 42);
    const recordBytes = 46 + nameBytes + extraBytes + entryCommentBytes;
    if (offset + recordBytes > endOffset) {
      throw new Error('SHAPR archive entry metadata is truncated.');
    }
    if ((flags & ENCRYPTED_FLAG) !== 0) {
      throw new Error('Encrypted SHAPR archive entries are unsupported.');
    }
    if (compression !== 0 && compression !== 8) {
      throw new Error(
        `SHAPR archive uses unsupported compression method ${compression}.`
      );
    }
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK) {
      throw new Error('SHAPR archive symlinks are unsupported.');
    }
    const name = decodeEntryName(
      bytes.subarray(offset + 46, offset + 46 + nameBytes),
      (flags & UTF8_FLAG) !== 0
    );
    validateEntryName(name, limits.maxEntryNameBytes);
    if (names.has(name)) {
      throw new Error(`SHAPR archive contains duplicate entry "${name}".`);
    }
    names.add(name);

    if (
      localOffset + 30 > centralOffset ||
      readU32(view, localOffset) !== LOCAL_FILE_HEADER
    ) {
      throw new Error('SHAPR archive local entry metadata is malformed.');
    }
    const localFlags = readU16(view, localOffset + 6);
    const localCompression = readU16(view, localOffset + 8);
    const localNameBytes = readU16(view, localOffset + 26);
    const localExtraBytes = readU16(view, localOffset + 28);
    const localDataOffset = localOffset + 30 + localNameBytes + localExtraBytes;
    if (localDataOffset + compressedBytes > centralOffset) {
      throw new Error('SHAPR archive local entry bounds are invalid.');
    }
    const localName = decodeEntryName(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameBytes),
      (localFlags & UTF8_FLAG) !== 0
    );
    if (
      localName !== name ||
      localFlags !== flags ||
      localCompression !== compression ||
      ((localFlags & DATA_DESCRIPTOR_FLAG) === 0 &&
        (readU32(view, localOffset + 18) !== compressedBytes ||
          readU32(view, localOffset + 22) !== uncompressedBytes))
    ) {
      throw new Error(
        'SHAPR archive local entry does not match its central directory.'
      );
    }
    localSpans.push({
      start: localOffset,
      end: localDataOffset + compressedBytes
    });

    const perEntryLimit =
      name === 'workspace'
        ? limits.maxWorkspaceBytes
        : limits.maxOtherEntryBytes;
    if (uncompressedBytes > perEntryLimit) {
      throw new Error(`SHAPR archive entry "${name}" exceeds its size limit.`);
    }
    if (
      uncompressedBytes > 0 &&
      (compressedBytes === 0 ||
        uncompressedBytes / compressedBytes > limits.maxCompressionRatio)
    ) {
      throw new Error(
        `SHAPR archive entry "${name}" exceeds the compression-ratio limit.`
      );
    }
    declaredOutputBytes += uncompressedBytes;
    if (declaredOutputBytes > limits.maxDeclaredOutputBytes) {
      throw new Error(
        'SHAPR archive exceeds the total decompressed-size limit.'
      );
    }
    entries.push({
      name,
      compressedBytes,
      uncompressedBytes,
      compression
    });
    offset += recordBytes;
  }
  if (offset !== endOffset) {
    throw new Error('SHAPR archive central directory has unused bytes.');
  }
  localSpans.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localSpans.length; index += 1) {
    if (localSpans[index]!.start < localSpans[index - 1]!.end) {
      throw new Error('SHAPR archive local entries overlap.');
    }
  }
  const workspace = entries.find((entry) => entry.name === 'workspace');
  if (!workspace) {
    throw new Error('SHAPR archive does not contain a workspace database.');
  }
  return { entries, workspace, declaredOutputBytes };
}

export function extractShaprArchive(
  bytes: Uint8Array,
  limits: ShaprImportLimits
): ExtractedShaprArchive {
  const inspection = inspectShaprArchive(bytes, limits);
  const output = new Uint8Array(inspection.workspace.uncompressedBytes);
  let written = 0;
  let completed = false;
  let failure: Error | null = null;
  let workspaceSeen = false;

  const unzip = new Unzip((file) => {
    if (file.name !== 'workspace') {
      file.terminate();
      return;
    }
    if (workspaceSeen) {
      failure = new Error(
        'SHAPR archive contains more than one workspace entry.'
      );
      file.terminate();
      return;
    }
    workspaceSeen = true;
    file.ondata = (error, chunk, final) => {
      if (failure) {
        return;
      }
      if (error) {
        failure = new Error(
          `SHAPR workspace decompression failed: ${error.message}`
        );
        return;
      }
      if (written + chunk.byteLength > output.byteLength) {
        failure = new Error(
          'SHAPR workspace expanded beyond its declared size.'
        );
        file.terminate();
        return;
      }
      output.set(chunk, written);
      written += chunk.byteLength;
      completed = final;
    };
    file.start();
  });
  unzip.register(UnzipPassThrough);
  unzip.register(UnzipInflate);

  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += STREAM_CHUNK_BYTES
  ) {
    if (failure) {
      break;
    }
    const end = Math.min(bytes.byteLength, offset + STREAM_CHUNK_BYTES);
    try {
      unzip.push(bytes.subarray(offset, end), end === bytes.byteLength);
    } catch (error) {
      failure = new Error(
        `SHAPR archive decompression failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (failure) {
    throw failure;
  }
  if (!workspaceSeen || !completed || written !== output.byteLength) {
    throw new Error(
      'SHAPR workspace decompression ended before the declared size.'
    );
  }
  return { workspace: output, inspection };
}
