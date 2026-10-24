import {
  copyBytes,
  equalBytes,
  fromBase64Url,
  isUint,
  toBase64Url,
  toHex,
  utf8,
  type Bytes
} from './bytes';
import {
  MAX_EPOCH_AUTHENTICATOR_BYTES,
  MIN_EPOCH_AUTHENTICATOR_BYTES
} from './codes';
import {
  checkBlobReferences,
  contentBlobReferenceFromJson,
  contentBlobReferenceToJson,
  type ContentBlobReference
} from './envelope';
import { E2eeError, type E2eeErrorCode } from './errors';
import {
  HASH_BYTES,
  MAX_BLOB_IDS,
  PLAINTEXT_CEILINGS,
  isEnvelopeId,
  type ProjectEnvelopeHeaderInit,
  type ProjectEnvelopeKind
} from './header';
import { KEY_BYTES } from './primitives';

/**
 * The encrypted bodies of project envelopes: UTF-8 JSON, written by the
 * encoders here and refused by the decoders unless every field is the
 * expected type and size. Each body carries `version: 1`. Bytes are
 * unpadded base64url (hashes in `revisionVersionHashes` are lowercase hex,
 * as the app keys them). Every encoder and decoder runs
 * `checkBlobReferences` against the envelope header, so a header listing a
 * blob the body does not reference, or the reverse, is refused
 * (`context-mismatch`) on both sides.
 */
export const BODY_VERSION_1 = 1;

/** Most revisions one document body names (judgment; the ledger keeps fewer). */
export const MAX_REVISION_HASHES = 4096;
/** Most archived exports one project-info body lists. */
export const MAX_PROJECT_EXPORTS = 1024;
/** Most previous project keys one key archive carries. */
export const MAX_ARCHIVED_KEYS = 8192;
/** `MAX_PROJECT_NAME_LENGTH` in `@openzcad/shared`, in UTF-16 units. */
export const MAX_PROJECT_NAME_LENGTH = 200;
/** The Worker's `MAX_FILE_NAME_LENGTH` and `MAX_CONTENT_TYPE_LENGTH`. */
export const MAX_EXPORT_FILE_NAME_LENGTH = 255;
export const MAX_EXPORT_CONTENT_TYPE_LENGTH = 100;
/** The Worker's cap on an artifact's metadata, as serialized JSON. */
export const MAX_EXPORT_METADATA_LENGTH = 4000;

/**
 * Lexical limits checked before `JSON.parse` allocates anything. The
 * document limits mirror `MAX_DOCUMENT_DEPTH` (64) and twice
 * `MAX_DOCUMENT_VALUES` (500,000) in `@openzcad/shared`, with room for the
 * body around the document; the document validators still run on the
 * result.
 */
const DOCUMENT_JSON_LIMITS = { depth: 72, separators: 1_100_000 } as const;
// The small bodies are bounded by their 1 MiB ceiling; their limits only
// refuse nesting the format never has.
const PROJECT_INFO_JSON_LIMITS = { depth: 6, separators: 1024 * 1024 } as const;
const KEY_ARCHIVE_JSON_LIMITS = { depth: 4, separators: 1024 * 1024 } as const;

/** What a body is checked against: the header (or its init) it travels under. */
export type BodyEnvelopeHeader = Pick<
  ProjectEnvelopeHeaderInit,
  'kind' | 'keyEpoch' | 'blobIds'
>;

// --- Shared helpers -------------------------------------------------------

type Side = 'invalid-argument' | 'malformed';

/** An array check that does not narrow a typed list to `any[]`. */
function isList(value: unknown): boolean {
  return Array.isArray(value);
}

function fail(code: E2eeErrorCode, message: string): never {
  throw new E2eeError(code, message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  what: string,
  side: Side
): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(side, `${what} must be an object`);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(side, `${what} needs ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(side, `${what} has an unknown field ${key}`);
    }
  }
  return value;
}

function checkKind(
  header: BodyEnvelopeHeader,
  kinds: readonly ProjectEnvelopeKind[],
  side: Side
): void {
  if (typeof header !== 'object' || header === null) {
    fail('invalid-argument', 'A body needs its envelope header');
  }
  if (!kinds.includes(header.kind)) {
    fail(
      side === 'malformed' ? 'context-mismatch' : 'invalid-argument',
      `A ${header.kind} envelope does not carry this body`
    );
  }
}

function checkBodyVersion(value: unknown): void {
  if (value === BODY_VERSION_1) return;
  if (isUint(value, Number.MAX_SAFE_INTEGER)) {
    fail('unsupported-version', `Body version ${value} is not supported`);
  }
  fail('malformed', 'Body version must be a number');
}

/**
 * Depth and separator counts of JSON text, string contents skipped, so an
 * oversized object graph is refused before `JSON.parse` builds it.
 */
function checkJsonComplexity(
  text: string,
  limits: { readonly depth: number; readonly separators: number }
): void {
  let depth = 0;
  let separators = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === 0x5c) escaped = true;
      else if (char === 0x22) inString = false;
      continue;
    }
    if (char === 0x22) inString = true;
    else if (char === 0x7b || char === 0x5b) {
      depth += 1;
      separators += 1;
    } else if (char === 0x7d || char === 0x5d) depth -= 1;
    else if (char === 0x2c || char === 0x3a) separators += 1;
    if (depth > limits.depth || separators > limits.separators) {
      fail('limit-exceeded', 'Body JSON exceeds its structural limit');
    }
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function parseBody(
  bytes: Uint8Array,
  ceiling: number,
  limits: { readonly depth: number; readonly separators: number },
  what: string
): unknown {
  if (!(bytes instanceof Uint8Array)) {
    fail('invalid-argument', `${what} must be a Uint8Array`);
  }
  // Size first: an oversized body costs nothing to refuse.
  if (bytes.byteLength > ceiling) {
    fail('limit-exceeded', `${what} is larger than ${ceiling} bytes`);
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch (cause) {
    throw new E2eeError('malformed', `${what} is not UTF-8`, { cause });
  }
  checkJsonComplexity(text, limits);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new E2eeError('malformed', `${what} is not JSON`, { cause });
  }
}

function serialize(
  value: unknown,
  ceiling: number,
  limits: { readonly depth: number; readonly separators: number },
  what: string
): Bytes {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (cause) {
    throw new E2eeError('invalid-argument', `${what} is not JSON`, { cause });
  }
  if (text === undefined) fail('invalid-argument', `${what} is not JSON`);
  // Never write what a reader would refuse.
  checkJsonComplexity(text, limits);
  const bytes = utf8(text);
  if (bytes.byteLength > ceiling) {
    fail('limit-exceeded', `${what} is larger than ${ceiling} bytes`);
  }
  return bytes;
}

/** Canonical unpadded base64url with an exact or bounded decoded length. */
function readBase64(
  value: unknown,
  what: string,
  min: number,
  max: number
): Bytes {
  // Refuse an oversized string before decoding it.
  if (typeof value !== 'string' || value.length > Math.ceil((max * 4) / 3)) {
    fail('malformed', `${what} must be base64url`);
  }
  const bytes = fromBase64Url(value);
  if (
    bytes.byteLength < min ||
    bytes.byteLength > max ||
    toBase64Url(bytes) !== value
  ) {
    fail('malformed', `${what} must be ${min}..${max} bytes of base64url`);
  }
  return bytes;
}

function checkBytes(
  value: unknown,
  what: string,
  min: number,
  max: number
): Bytes {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < min ||
    value.byteLength > max
  ) {
    fail('invalid-argument', `${what} must be ${min}..${max} bytes`);
  }
  return copyBytes(value);
}

function readReference(value: unknown, what: string): ContentBlobReference {
  exactKeys(
    value,
    ['blobId', 'kind', 'key', 'ciphertextHash', 'plaintextLength'],
    [],
    what,
    'malformed'
  );
  return contentBlobReferenceFromJson(value);
}

function writeReference(
  reference: ContentBlobReference,
  what: string
): ReturnType<typeof contentBlobReferenceToJson> {
  try {
    return contentBlobReferenceToJson(reference);
  } catch (cause) {
    throw new E2eeError('invalid-argument', `${what} is not a reference`, {
      cause
    });
  }
}

function isWellFormedText(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return false;
  }
  try {
    utf8(value);
    return true;
  } catch {
    return false;
  }
}

// --- Document bodies ------------------------------------------------------

/**
 * The body of a `document` or `share-snapshot` envelope. Blob keys travel
 * here, never in the header. `revisionVersionHashes` maps each retained
 * revision id to the version hash it was saved as; the current head signs
 * it, so a historical read proves a revision belongs to this history
 * through the signed head instead of walking overwritten autosaves.
 */
export interface EncryptedDocumentBody {
  /** The project document; the shared document validators check it. */
  readonly document: Readonly<Record<string, unknown>>;
  readonly blobs: readonly ContentBlobReference[];
  readonly revisionVersionHashes: ReadonlyMap<string, Uint8Array>;
}

const DOCUMENT_KINDS: readonly ProjectEnvelopeKind[] = [
  'document',
  'share-snapshot'
];

export function encodeEncryptedDocumentBody(
  body: EncryptedDocumentBody,
  header: BodyEnvelopeHeader
): Bytes {
  checkKind(header, DOCUMENT_KINDS, 'invalid-argument');
  if (!isPlainRecord(body?.document)) {
    fail('invalid-argument', 'document must be an object');
  }
  if (!isList(body.blobs) || body.blobs.length > MAX_BLOB_IDS) {
    fail(
      'invalid-argument',
      `blobs must be at most ${MAX_BLOB_IDS} references`
    );
  }
  const blobs = body.blobs.map((reference) =>
    writeReference(reference, 'A document blob')
  );
  checkBlobReferences({ blobIds: header.blobIds ?? [] }, body.blobs);
  const revisions = body.revisionVersionHashes;
  if (!(revisions instanceof Map) || revisions.size > MAX_REVISION_HASHES) {
    fail(
      'invalid-argument',
      `revisionVersionHashes must be a Map of at most ${MAX_REVISION_HASHES}`
    );
  }
  const entries: [string, string][] = [];
  for (const [id, hash] of revisions) {
    if (!isEnvelopeId(id)) {
      fail('invalid-argument', 'Revision ids must be printable ASCII ids');
    }
    entries.push([id, toHex(checkBytes(hash, 'A revision hash', 32, 32))]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return serialize(
    {
      version: BODY_VERSION_1,
      document: body.document,
      blobs,
      revisionVersionHashes: Object.fromEntries(entries)
    },
    PLAINTEXT_CEILINGS[header.kind],
    DOCUMENT_JSON_LIMITS,
    'Document body'
  );
}

export function decodeEncryptedDocumentBody(
  bytes: Uint8Array,
  header: BodyEnvelopeHeader
): EncryptedDocumentBody {
  checkKind(header, DOCUMENT_KINDS, 'malformed');
  const record = exactKeys(
    parseBody(
      bytes,
      PLAINTEXT_CEILINGS[header.kind],
      DOCUMENT_JSON_LIMITS,
      'Document body'
    ),
    ['version', 'document', 'blobs', 'revisionVersionHashes'],
    [],
    'Document body',
    'malformed'
  );
  checkBodyVersion(record.version);
  if (!isPlainRecord(record.document)) {
    fail('malformed', 'document must be an object');
  }
  if (!Array.isArray(record.blobs) || record.blobs.length > MAX_BLOB_IDS) {
    fail('malformed', `blobs must be at most ${MAX_BLOB_IDS} references`);
  }
  const blobs = record.blobs.map((value) =>
    readReference(value, 'A document blob')
  );
  checkBlobReferences({ blobIds: header.blobIds ?? [] }, blobs);
  const hashes = record.revisionVersionHashes;
  if (!isPlainRecord(hashes)) {
    fail('malformed', 'revisionVersionHashes must be an object');
  }
  const ids = Object.keys(hashes);
  if (ids.length > MAX_REVISION_HASHES) {
    fail('malformed', `At most ${MAX_REVISION_HASHES} revision hashes`);
  }
  const revisionVersionHashes = new Map<string, Bytes>();
  for (const id of ids) {
    const hex = hashes[id];
    if (
      !isEnvelopeId(id) ||
      typeof hex !== 'string' ||
      !/^[0-9a-f]{64}$/.test(hex)
    ) {
      fail('malformed', 'A revision hash must be 64 lowercase hex digits');
    }
    const hash = new Uint8Array(HASH_BYTES);
    for (let i = 0; i < HASH_BYTES; i += 1) {
      hash[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    revisionVersionHashes.set(id, hash);
  }
  return {
    document: record.document,
    blobs,
    revisionVersionHashes
  };
}

// --- Project info ---------------------------------------------------------

/** An archived export: an `export` content blob and what to call it. */
export interface ProjectExportEntry {
  readonly ref: ContentBlobReference;
  readonly fileName: string;
  readonly contentType: string;
  /** Flat strings, numbers and booleans, as the Worker accepts today. */
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The body of a `project-info` envelope: what the shelf shows without
 * opening the document. Its blob ids are the thumbnail's and the exports'.
 */
export interface ProjectInfoBody {
  readonly name: string;
  readonly thumbnail?: ContentBlobReference;
  readonly exports: readonly ProjectExportEntry[];
}

function checkMetadata(value: unknown, side: Side): void {
  if (!isPlainRecord(value)) fail(side, 'Export metadata must be an object');
  for (const entry of Object.values(value)) {
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'boolean' &&
      !(typeof entry === 'number' && Number.isFinite(entry))
    ) {
      fail(side, 'Export metadata values are strings, numbers or booleans');
    }
    if (typeof entry === 'string') {
      try {
        utf8(entry);
      } catch {
        fail(side, 'Export metadata must be well-formed text');
      }
    }
  }
  if (JSON.stringify(value).length > MAX_EXPORT_METADATA_LENGTH) {
    fail(side, 'Export metadata is too large');
  }
}

function checkExportFields(
  fileName: unknown,
  contentType: unknown,
  metadata: unknown,
  side: Side
): void {
  if (!isWellFormedText(fileName, MAX_EXPORT_FILE_NAME_LENGTH)) {
    fail(
      side,
      `An export fileName is 1..${MAX_EXPORT_FILE_NAME_LENGTH} characters`
    );
  }
  if (
    typeof contentType !== 'string' ||
    contentType.length === 0 ||
    contentType.length > MAX_EXPORT_CONTENT_TYPE_LENGTH ||
    !/^[\x20-\x7e]+$/.test(contentType)
  ) {
    fail(side, 'An export contentType is printable ASCII');
  }
  checkMetadata(metadata, side);
}

function projectInfoJson(body: ProjectInfoBody, header: BodyEnvelopeHeader) {
  checkKind(header, ['project-info'], 'invalid-argument');
  if (!isWellFormedText(body?.name, MAX_PROJECT_NAME_LENGTH)) {
    fail(
      'invalid-argument',
      `name is 1..${MAX_PROJECT_NAME_LENGTH} characters`
    );
  }
  if (!isList(body.exports) || body.exports.length > MAX_PROJECT_EXPORTS) {
    fail('invalid-argument', `At most ${MAX_PROJECT_EXPORTS} exports`);
  }
  const references: ContentBlobReference[] = [];
  let thumbnail: ReturnType<typeof contentBlobReferenceToJson> | undefined;
  if (body.thumbnail !== undefined) {
    thumbnail = writeReference(body.thumbnail, 'The thumbnail');
    if (thumbnail.kind !== 'thumbnail') {
      fail('invalid-argument', 'The thumbnail must be a thumbnail blob');
    }
    references.push(body.thumbnail);
  }
  const exports = body.exports.map((item: unknown) => {
    if (!isPlainRecord(item)) fail('invalid-argument', 'Not an export entry');
    const entry = item as unknown as ProjectExportEntry;
    const ref = writeReference(entry.ref, 'An export');
    if (ref.kind !== 'export') {
      fail('invalid-argument', 'An export must be an export blob');
    }
    checkExportFields(
      entry.fileName,
      entry.contentType,
      entry.metadata,
      'invalid-argument'
    );
    references.push(entry.ref);
    return {
      ref,
      fileName: entry.fileName,
      contentType: entry.contentType,
      metadata: { ...entry.metadata }
    };
  });
  checkBlobReferences({ blobIds: header.blobIds ?? [] }, references);
  return {
    version: BODY_VERSION_1,
    name: body.name,
    ...(thumbnail ? { thumbnail } : {}),
    exports
  };
}

export function encodeProjectInfoBody(
  body: ProjectInfoBody,
  header: BodyEnvelopeHeader
): Bytes {
  return serialize(
    projectInfoJson(body, header),
    PLAINTEXT_CEILINGS['project-info'],
    PROJECT_INFO_JSON_LIMITS,
    'Project info body'
  );
}

export function decodeProjectInfoBody(
  bytes: Uint8Array,
  header: BodyEnvelopeHeader
): ProjectInfoBody {
  checkKind(header, ['project-info'], 'malformed');
  const record = exactKeys(
    parseBody(
      bytes,
      PLAINTEXT_CEILINGS['project-info'],
      PROJECT_INFO_JSON_LIMITS,
      'Project info body'
    ),
    ['version', 'name', 'exports'],
    ['thumbnail'],
    'Project info body',
    'malformed'
  );
  checkBodyVersion(record.version);
  if (!isWellFormedText(record.name, MAX_PROJECT_NAME_LENGTH)) {
    fail('malformed', `name is 1..${MAX_PROJECT_NAME_LENGTH} characters`);
  }
  const thumbnail =
    record.thumbnail === undefined
      ? undefined
      : readReference(record.thumbnail, 'The thumbnail');
  if (thumbnail && thumbnail.kind !== 'thumbnail') {
    fail('malformed', 'The thumbnail must be a thumbnail blob');
  }
  if (
    !Array.isArray(record.exports) ||
    record.exports.length > MAX_PROJECT_EXPORTS
  ) {
    fail('malformed', `At most ${MAX_PROJECT_EXPORTS} exports`);
  }
  const exports = record.exports.map((value): ProjectExportEntry => {
    const entry = exactKeys(
      value,
      ['ref', 'fileName', 'contentType', 'metadata'],
      [],
      'An export entry',
      'malformed'
    );
    const ref = readReference(entry.ref, 'An export');
    if (ref.kind !== 'export') {
      fail('malformed', 'An export must be an export blob');
    }
    checkExportFields(
      entry.fileName,
      entry.contentType,
      entry.metadata,
      'malformed'
    );
    return {
      ref,
      fileName: entry.fileName as string,
      contentType: entry.contentType as string,
      metadata: entry.metadata as Record<string, string | number | boolean>
    };
  });
  checkBlobReferences({ blobIds: header.blobIds ?? [] }, [
    ...(thumbnail ? [thumbnail] : []),
    ...exports.map((entry) => entry.ref)
  ]);
  const body: ProjectInfoBody = {
    name: record.name,
    ...(thumbnail ? { thumbnail } : {}),
    exports
  };
  // One encoding per body: anything the encoder would not have written
  // (reordered fields, escapes, other number forms) is refused.
  if (!equalBytes(encodeProjectInfoBody(body, header), bytes)) {
    fail('malformed', 'Project info body is not in canonical form');
  }
  return body;
}

// --- Key archives ---------------------------------------------------------

export interface ArchivedProjectKey {
  readonly keyEpoch: number;
  readonly key: Uint8Array;
}

/**
 * The body of a `key-archive` envelope, written once per key epoch under
 * that epoch's project key (ADR-024, What MLS does not give): every earlier
 * project key, so a member who joined later reads back to the first
 * revision; the project's dedupe secret, carried across epochs; and the
 * epoch's MLS record (GroupContext, public tree, Commit and referenced
 * proposals, as opaque bytes) with its `epoch_authenticator`, from which a
 * reader recomputes `epochBinding`. It references no content blobs.
 */
export interface KeyArchiveBody {
  /** Strictly ascending key epochs, all before the archive's own. */
  readonly previousKeys: readonly ArchivedProjectKey[];
  readonly dedupeSecret: Uint8Array;
  readonly epochRecord: Uint8Array;
  readonly epochAuthenticator: Uint8Array;
}

const KEY_ARCHIVE_CEILING = PLAINTEXT_CEILINGS['key-archive'];

function checkArchivedEpochs(
  keys: readonly ArchivedProjectKey[],
  header: BodyEnvelopeHeader,
  side: Side
): void {
  let previous = -1;
  for (const { keyEpoch } of keys) {
    if (!isUint(keyEpoch, 0xffffffff) || keyEpoch <= previous) {
      fail(side, 'Archived key epochs must be strictly ascending u32s');
    }
    previous = keyEpoch;
  }
  if (previous >= header.keyEpoch) {
    fail(
      side === 'malformed' ? 'context-mismatch' : 'invalid-argument',
      'A key archive carries only keys older than its own epoch'
    );
  }
}

function keyArchiveJson(body: KeyArchiveBody, header: BodyEnvelopeHeader) {
  checkKind(header, ['key-archive'], 'invalid-argument');
  if (
    !isList(body?.previousKeys) ||
    body.previousKeys.length > MAX_ARCHIVED_KEYS
  ) {
    fail('invalid-argument', `At most ${MAX_ARCHIVED_KEYS} archived keys`);
  }
  const previousKeys = body.previousKeys.map((entry) => ({
    keyEpoch: entry?.keyEpoch,
    key: toBase64Url(
      checkBytes(entry?.key, 'An archived key', KEY_BYTES, KEY_BYTES)
    )
  }));
  checkArchivedEpochs(body.previousKeys, header, 'invalid-argument');
  checkBlobReferences({ blobIds: header.blobIds ?? [] }, []);
  return {
    version: BODY_VERSION_1,
    previousKeys,
    dedupeSecret: toBase64Url(
      checkBytes(body.dedupeSecret, 'dedupeSecret', KEY_BYTES, KEY_BYTES)
    ),
    epochRecord: toBase64Url(
      checkBytes(body.epochRecord, 'epochRecord', 1, KEY_ARCHIVE_CEILING)
    ),
    epochAuthenticator: toBase64Url(
      checkBytes(
        body.epochAuthenticator,
        'epochAuthenticator',
        MIN_EPOCH_AUTHENTICATOR_BYTES,
        MAX_EPOCH_AUTHENTICATOR_BYTES
      )
    )
  };
}

export function encodeKeyArchiveBody(
  body: KeyArchiveBody,
  header: BodyEnvelopeHeader
): Bytes {
  return serialize(
    keyArchiveJson(body, header),
    KEY_ARCHIVE_CEILING,
    KEY_ARCHIVE_JSON_LIMITS,
    'Key archive body'
  );
}

export function decodeKeyArchiveBody(
  bytes: Uint8Array,
  header: BodyEnvelopeHeader
): KeyArchiveBody {
  checkKind(header, ['key-archive'], 'malformed');
  const record = exactKeys(
    parseBody(
      bytes,
      KEY_ARCHIVE_CEILING,
      KEY_ARCHIVE_JSON_LIMITS,
      'Key archive body'
    ),
    [
      'version',
      'previousKeys',
      'dedupeSecret',
      'epochRecord',
      'epochAuthenticator'
    ],
    [],
    'Key archive body',
    'malformed'
  );
  checkBodyVersion(record.version);
  if (
    !Array.isArray(record.previousKeys) ||
    record.previousKeys.length > MAX_ARCHIVED_KEYS
  ) {
    fail('malformed', `At most ${MAX_ARCHIVED_KEYS} archived keys`);
  }
  const previousKeys = record.previousKeys.map((value): ArchivedProjectKey => {
    const entry = exactKeys(
      value,
      ['keyEpoch', 'key'],
      [],
      'An archived key',
      'malformed'
    );
    return {
      keyEpoch: entry.keyEpoch as number,
      key: readBase64(entry.key, 'An archived key', KEY_BYTES, KEY_BYTES)
    };
  });
  checkArchivedEpochs(previousKeys, header, 'malformed');
  checkBlobReferences({ blobIds: header.blobIds ?? [] }, []);
  const body: KeyArchiveBody = {
    previousKeys,
    dedupeSecret: readBase64(
      record.dedupeSecret,
      'dedupeSecret',
      KEY_BYTES,
      KEY_BYTES
    ),
    epochRecord: readBase64(
      record.epochRecord,
      'epochRecord',
      1,
      KEY_ARCHIVE_CEILING
    ),
    epochAuthenticator: readBase64(
      record.epochAuthenticator,
      'epochAuthenticator',
      MIN_EPOCH_AUTHENTICATOR_BYTES,
      MAX_EPOCH_AUTHENTICATOR_BYTES
    )
  };
  if (!equalBytes(encodeKeyArchiveBody(body, header), bytes)) {
    fail('malformed', 'Key archive body is not in canonical form');
  }
  return body;
}
