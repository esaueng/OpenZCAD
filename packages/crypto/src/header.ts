import { ByteReader, ByteWriter, copyBytes, isUint, type Bytes } from './bytes';
import { E2eeError, type E2eeErrorCode } from './errors';

/** First three bytes of every envelope: "OZE". */
export const ENVELOPE_MAGIC: readonly number[] = [0x4f, 0x5a, 0x45];
/** AES-256-GCM STREAM chunks under a single-use 256-bit key. */
export const ENVELOPE_VERSION_1 = 1;
/** Magic, version byte and the u32 header length. */
export const ENVELOPE_FIXED_PREFIX_BYTES = 8;
export const HASH_BYTES = 32;

export const MIN_CHUNK_SIZE = 64;
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const MAX_ID_BYTES = 128;
export const MAX_BLOB_IDS = 4096;
export const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_U32 = 0xffffffff;

/** Project envelopes: bound to one project, one fresh key per version. */
export const PROJECT_ENVELOPE_KINDS = [
  'document',
  'measurements',
  'view-state',
  'share-snapshot'
] as const;
export type ProjectEnvelopeKind = (typeof PROJECT_ENVELOPE_KINDS)[number];

/** Content blobs: no project id; the referencing envelope authenticates them. */
export const CONTENT_BLOB_KINDS = [
  'import-source',
  'mesh-payload',
  'thumbnail',
  'export'
] as const;
export type ContentBlobKind = (typeof CONTENT_BLOB_KINDS)[number];

/**
 * Largest plaintext each kind may decompress to (ADR-024, Decompression
 * limits): `MAX_CLOUD_PROJECT_DOCUMENT_BYTES` (24 MiB) for documents and
 * share snapshots; 128 MiB, the app's `MAX_SOURCE_IMPORT_BYTES` and
 * `MAX_ARTIFACT_DOWNLOAD_BYTES`, for imported sources, mesh payloads and
 * archived exports; `MAX_THUMBNAIL_BYTES` and `MAX_PROJECT_MEASUREMENT_BYTES`
 * (512 KiB) for thumbnails and measurements. View state gets 1 MiB
 * (judgment: camera and saved views only). `MAX_ARTIFACT_UPLOAD_BYTES`
 * (1 GiB) is a storage reservation, never a decompression limit. A test
 * pins these to the constants they mirror.
 */
export const PLAINTEXT_CEILINGS: Readonly<
  Record<ProjectEnvelopeKind | ContentBlobKind, number>
> = {
  document: 24 * 1024 * 1024,
  'share-snapshot': 24 * 1024 * 1024,
  measurements: 512 * 1024,
  'view-state': 1024 * 1024,
  'import-source': 128 * 1024 * 1024,
  'mesh-payload': 128 * 1024 * 1024,
  export: 128 * 1024 * 1024,
  thumbnail: 512 * 1024
};

export const COMPRESSIONS = ['none', 'gzip'] as const;
export type Compression = (typeof COMPRESSIONS)[number];

/** Format parameters both classes carry; neither links a blob to a project. */
interface EnvelopeFormat {
  /** Whether the payload was compressed before encryption. */
  readonly compression: Compression;
  /** Plaintext bytes per chunk; the last chunk may be shorter. */
  readonly chunkSize: number;
  /**
   * Exact plaintext size after decompression. It is in the header, so every
   * chunk's AAD binds it, and decryption fails on any other size.
   */
  readonly plaintextLength: number;
}

export interface ProjectEnvelopeHeader extends EnvelopeFormat {
  readonly class: 'project';
  readonly kind: ProjectEnvelopeKind;
  readonly projectId: string;
  readonly documentVersion: number;
  /** `versionHash` of the previous version; null for the first. */
  readonly previousVersionHash: Bytes | null;
  /** `rosterEntryHash` of the signed roster entry this version was written under. */
  readonly rosterEntryHash: Bytes;
  readonly schemaVersion: number;
  readonly keyEpoch: number;
  /** Ids of the content blobs this version references. */
  readonly blobIds: readonly string[];
}

export interface ContentBlobHeader extends EnvelopeFormat {
  readonly class: 'content';
  readonly kind: ContentBlobKind;
  /** Immutable random id: the blob's only identity. */
  readonly blobId: string;
}

export type EnvelopeHeader = ProjectEnvelopeHeader | ContentBlobHeader;

export interface ProjectEnvelopeHeaderInit extends Omit<
  ProjectEnvelopeHeader,
  | 'class'
  | 'plaintextLength'
  | 'previousVersionHash'
  | 'rosterEntryHash'
  | 'blobIds'
  | 'compression'
  | 'chunkSize'
> {
  readonly previousVersionHash: Uint8Array | null;
  readonly rosterEntryHash: Uint8Array;
  readonly blobIds?: readonly string[];
  /** Defaults to `gzip`. */
  readonly compression?: Compression;
  /** Defaults to 1 MiB. */
  readonly chunkSize?: number;
}

const CLASS_CODES = { project: 1, content: 2 } as const;

/** Ids are printable ASCII so they compare byte-for-byte without Unicode normalization. */
export function isEnvelopeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_BYTES &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function fail(code: E2eeErrorCode, message: string): never {
  throw new E2eeError(code, message);
}

function isHash(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === HASH_BYTES;
}

/** One rule set guards what we write (`invalid-argument`) and read (`malformed`). */
export function checkHeader(header: EnvelopeHeader, code: E2eeErrorCode): void {
  if (!COMPRESSIONS.includes(header.compression)) {
    fail(code, 'Unknown compression');
  }
  if (
    !isUint(header.chunkSize, MAX_CHUNK_SIZE) ||
    header.chunkSize < MIN_CHUNK_SIZE
  ) {
    fail(code, `chunkSize must be ${MIN_CHUNK_SIZE}..${MAX_CHUNK_SIZE}`);
  }
  if (!isUint(header.plaintextLength, Number.MAX_SAFE_INTEGER)) {
    fail(code, 'plaintextLength must be a non-negative safe integer');
  }
  if (header.class === 'content') {
    if (!CONTENT_BLOB_KINDS.includes(header.kind)) {
      fail(code, 'Unknown content blob kind');
    }
    if (!isEnvelopeId(header.blobId)) {
      fail(code, 'blobId must be a printable ASCII id');
    }
    return;
  }
  if (header.class !== 'project') fail(code, 'Unknown envelope class');
  if (!PROJECT_ENVELOPE_KINDS.includes(header.kind)) {
    fail(code, 'Unknown project envelope kind');
  }
  if (!isEnvelopeId(header.projectId)) {
    fail(code, 'projectId must be a printable ASCII id');
  }
  if (!isUint(header.documentVersion, Number.MAX_SAFE_INTEGER)) {
    fail(code, 'documentVersion must be a non-negative safe integer');
  }
  if (
    header.previousVersionHash !== null &&
    !isHash(header.previousVersionHash)
  ) {
    fail(code, 'previousVersionHash must be 32 bytes or null');
  }
  if (!isHash(header.rosterEntryHash)) {
    fail(code, 'rosterEntryHash must be 32 bytes');
  }
  if (!isUint(header.schemaVersion, MAX_U32)) {
    fail(code, 'schemaVersion must be a u32');
  }
  if (!isUint(header.keyEpoch, MAX_U32)) fail(code, 'keyEpoch must be a u32');
  if (!Array.isArray(header.blobIds)) fail(code, 'blobIds must be an array');
  if (header.blobIds.length > MAX_BLOB_IDS) {
    fail(code === 'malformed' ? code : 'limit-exceeded', 'Too many blob ids');
  }
  const seen = new Set<string>();
  for (const id of header.blobIds) {
    if (!isEnvelopeId(id)) fail(code, 'Blob ids must be printable ASCII ids');
    if (seen.has(id)) fail(code, `Duplicate blob id ${id}`);
    seen.add(id);
  }
}

export function normalizeProjectHeader(
  init: ProjectEnvelopeHeaderInit,
  plaintextLength: number
): ProjectEnvelopeHeader {
  if (typeof init !== 'object' || init === null) {
    fail('invalid-argument', 'Envelope header must be an object');
  }
  const header = {
    class: 'project',
    kind: init.kind,
    projectId: init.projectId,
    documentVersion: init.documentVersion,
    plaintextLength,
    previousVersionHash: isHash(init.previousVersionHash)
      ? copyBytes(init.previousVersionHash)
      : init.previousVersionHash,
    rosterEntryHash: isHash(init.rosterEntryHash)
      ? copyBytes(init.rosterEntryHash)
      : init.rosterEntryHash,
    schemaVersion: init.schemaVersion,
    keyEpoch: init.keyEpoch,
    blobIds: Array.isArray(init.blobIds)
      ? Array.from<string>(init.blobIds)
      : (init.blobIds ?? []),
    compression: init.compression ?? 'gzip',
    chunkSize: init.chunkSize ?? DEFAULT_CHUNK_SIZE
  } as ProjectEnvelopeHeader;
  checkHeader(header, 'invalid-argument');
  return header;
}

const ascii = new TextEncoder();
const asciiDecoder = new TextDecoder();

function writeId(writer: ByteWriter, id: string): void {
  writer.u8(id.length).bytes(ascii.encode(id));
}

function readId(reader: ByteReader): string {
  return asciiDecoder.decode(reader.bytes(reader.u8()));
}

/**
 * Serializes the envelope prefix: magic, version, header length, header.
 * These exact bytes open every chunk's AAD.
 */
export function encodeEnvelopePrefix(header: EnvelopeHeader): Bytes {
  const body = new ByteWriter()
    .u8(CLASS_CODES[header.class])
    .u8(
      header.class === 'project'
        ? PROJECT_ENVELOPE_KINDS.indexOf(header.kind) + 1
        : CONTENT_BLOB_KINDS.indexOf(header.kind) + 1
    )
    .u8(COMPRESSIONS.indexOf(header.compression))
    .u32(header.chunkSize)
    .u64(header.plaintextLength);
  if (header.class === 'content') {
    writeId(body, header.blobId);
  } else {
    body
      .u32(header.schemaVersion)
      .u32(header.keyEpoch)
      .u64(header.documentVersion)
      .u8(header.previousVersionHash?.byteLength ?? 0)
      .bytes(header.previousVersionHash ?? new Uint8Array())
      .bytes(header.rosterEntryHash);
    writeId(body, header.projectId);
    body.u16(header.blobIds.length);
    for (const id of header.blobIds) writeId(body, id);
  }
  const headerBytes = body.finish();
  if (headerBytes.byteLength > MAX_HEADER_BYTES) {
    fail('limit-exceeded', 'Envelope header is too large');
  }
  return new ByteWriter()
    .bytes(Uint8Array.from(ENVELOPE_MAGIC))
    .u8(ENVELOPE_VERSION_1)
    .u32(headerBytes.byteLength)
    .bytes(headerBytes)
    .finish();
}

/**
 * Reads the fixed eight bytes and returns the full prefix length, or null
 * when fewer than eight bytes are available yet (streaming). Refuses a
 * foreign magic (`malformed`) or version (`unsupported-version`) early.
 */
export function envelopePrefixLength(bytes: Uint8Array): number | null {
  for (let i = 0; i < ENVELOPE_MAGIC.length && i < bytes.byteLength; i += 1) {
    if (bytes[i] !== ENVELOPE_MAGIC[i]) {
      fail('malformed', 'Not an OpenZCAD envelope');
    }
  }
  if (bytes.byteLength > ENVELOPE_MAGIC.length) {
    const version = bytes[ENVELOPE_MAGIC.length]!;
    if (version !== ENVELOPE_VERSION_1) {
      fail(
        'unsupported-version',
        `Envelope version ${version} is not supported`
      );
    }
  }
  if (bytes.byteLength < ENVELOPE_FIXED_PREFIX_BYTES) return null;
  const headerLength = new ByteReader(
    bytes.subarray(4, 8),
    'Envelope prefix'
  ).u32();
  if (headerLength > MAX_HEADER_BYTES) {
    fail('malformed', 'Envelope header is too large');
  }
  return ENVELOPE_FIXED_PREFIX_BYTES + headerLength;
}

export interface EnvelopePrefix {
  readonly version: typeof ENVELOPE_VERSION_1;
  readonly header: EnvelopeHeader;
  /** The exact prefix bytes, which open every chunk's AAD. */
  readonly prefix: Bytes;
}

/** Parses a complete prefix (`envelopePrefixLength` bytes). */
export function decodeEnvelopePrefix(prefix: Uint8Array): EnvelopePrefix {
  const length = envelopePrefixLength(prefix);
  if (length === null || prefix.byteLength < length) {
    fail('malformed', 'Envelope prefix is truncated');
  }
  const reader = new ByteReader(
    prefix.subarray(ENVELOPE_FIXED_PREFIX_BYTES, length),
    'Envelope header'
  );
  const classCode = reader.u8();
  const kindCode = reader.u8();
  const compression = COMPRESSIONS[reader.u8()];
  if (compression === undefined) fail('malformed', 'Unknown compression');
  const chunkSize = reader.u32();
  const plaintextLength = reader.u64();
  let header: EnvelopeHeader;
  if (classCode === CLASS_CODES.content) {
    const kind = CONTENT_BLOB_KINDS[kindCode - 1];
    if (kind === undefined) fail('malformed', 'Unknown content blob kind');
    header = {
      class: 'content',
      kind,
      blobId: readId(reader),
      compression,
      chunkSize,
      plaintextLength
    };
  } else if (classCode === CLASS_CODES.project) {
    const kind = PROJECT_ENVELOPE_KINDS[kindCode - 1];
    if (kind === undefined) fail('malformed', 'Unknown project envelope kind');
    const schemaVersion = reader.u32();
    const keyEpoch = reader.u32();
    const documentVersion = reader.u64();
    const hashLength = reader.u8();
    const previousVersionHash =
      hashLength === 0 ? null : copyBytes(reader.bytes(hashLength));
    const rosterEntryHash = copyBytes(reader.bytes(HASH_BYTES));
    const projectId = readId(reader);
    const blobIds: string[] = [];
    for (let count = reader.u16(); count > 0; count -= 1) {
      blobIds.push(readId(reader));
    }
    header = {
      class: 'project',
      kind,
      projectId,
      documentVersion,
      plaintextLength,
      previousVersionHash,
      rosterEntryHash,
      schemaVersion,
      keyEpoch,
      blobIds,
      compression,
      chunkSize
    };
  } else {
    fail('malformed', 'Unknown envelope class');
  }
  reader.end();
  checkHeader(header, 'malformed');
  return {
    version: ENVELOPE_VERSION_1,
    header,
    prefix: copyBytes(prefix.subarray(0, length))
  };
}
