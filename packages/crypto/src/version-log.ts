import {
  ByteReader,
  ByteWriter,
  copyBytes,
  equalBytes,
  isUint,
  snapshotBytes,
  toHex,
  type Bytes
} from './bytes';
import type { DeviceRecord, VerifiedDeviceList } from './devices';
import { parseEnvelope } from './envelope';
import { E2eeError, type E2eeErrorCode } from './errors';
import {
  ENVELOPE_FIXED_PREFIX_BYTES,
  HASH_BYTES,
  MAX_HEADER_BYTES,
  decodeEnvelopePrefix,
  isEnvelopeId,
  type EnvelopeHeader,
  type ProjectEnvelopeHeader
} from './header';
import {
  VERSION_SIGNATURE_BYTES,
  parseVersionSignature,
  verifyVersionStatement,
  versionHash,
  versionStatementOf
} from './signing';

/**
 * The version log: one compact record per signed project envelope the
 * server ever accepted, kept after the envelope itself is overwritten (an
 * autosave replaces the last one). A record is the envelope prefix, its
 * version hash and the author's v1 signature, which covers exactly
 * `label | prefix | versionHash | signedAt`, so the chain and every
 * signature verify without any envelope body. Browsers check the log to
 * refuse rollback and forks across autosaves they never downloaded.
 */

/** First three bytes of an encoded record: "OZV". */
const RECORD_MAGIC: readonly number[] = Object.freeze([0x4f, 0x5a, 0x56]);
export const VERSION_LOG_RECORD_VERSION_1 = 1;
/** Most records one `verifyVersionLog` call takes; check longer logs in windows. */
export const MAX_VERSION_LOG_RECORDS = 4096;
/** Most record bytes (prefixes, mostly) one call takes. */
export const MAX_VERSION_LOG_BYTES = 64 * 1024 * 1024;
const MAX_PREFIX_BYTES = ENVELOPE_FIXED_PREFIX_BYTES + MAX_HEADER_BYTES;

export interface VersionLogRecord {
  /** The envelope prefix: magic, version, header length and header. */
  readonly prefix: Bytes;
  /** `versionHash` of the whole envelope. */
  readonly versionHash: Bytes;
  /** The author's v1 signature, `u8 1 | u64 signedAt | r || s`. */
  readonly signature: Bytes;
}

/** A Map check that does not narrow a typed map to `Map<any, any>`. */
function isMap(value: unknown): boolean {
  return value instanceof Map;
}

/** An array check that does not narrow a typed list to `any[]`. */
function isList(value: unknown): boolean {
  return Array.isArray(value);
}

function fail(code: E2eeErrorCode, message: string): never {
  throw new E2eeError(code, message);
}

/** Decodes a record's prefix, which must be a project envelope's. */
function projectHeaderOfPrefix(
  prefix: Uint8Array,
  code: E2eeErrorCode
): ProjectEnvelopeHeader {
  let header: EnvelopeHeader;
  try {
    const decoded = decodeEnvelopePrefix(prefix);
    if (decoded.prefix.byteLength !== prefix.byteLength) {
      fail('malformed', 'A record prefix has trailing bytes');
    }
    header = decoded.header;
  } catch (error) {
    if (code === 'malformed' || !(error instanceof E2eeError)) throw error;
    throw new E2eeError(
      code,
      `Not a project envelope prefix: ${error.message}`,
      {
        cause: error
      }
    );
  }
  if (header.class !== 'project') {
    fail(code, 'Only project envelopes have version log records');
  }
  return header;
}

/**
 * Copies of a record's fields, checked: a project envelope prefix, a
 * 32-byte hash and a well-formed v1 signature. Taken before any await.
 */
function captureRecord(
  record: VersionLogRecord,
  code: E2eeErrorCode
): {
  record: VersionLogRecord;
  header: ProjectEnvelopeHeader;
  signedAt: number;
} {
  if (typeof record !== 'object' || record === null) {
    fail(code, 'Not a version log record');
  }
  const prefix = snapshotBytes(record.prefix, 'prefix', MAX_PREFIX_BYTES, code);
  const hash = snapshotBytes(
    record.versionHash,
    'versionHash',
    HASH_BYTES,
    code
  );
  if (hash.byteLength !== HASH_BYTES)
    fail(code, 'versionHash must be 32 bytes');
  const signature = snapshotBytes(
    record.signature,
    'signature',
    VERSION_SIGNATURE_BYTES,
    code
  );
  const header = projectHeaderOfPrefix(prefix, code);
  const { signedAt } = parseVersionSignature(signature);
  return {
    record: { prefix, versionHash: hash, signature },
    header,
    signedAt
  };
}

/**
 * The log record for a signed project envelope. It checks the envelope's
 * structure and the signature's shape, not who signed it.
 */
export async function versionLogRecord(
  envelope: Uint8Array,
  signature: Uint8Array
): Promise<VersionLogRecord> {
  if (!(envelope instanceof Uint8Array)) {
    fail('invalid-argument', 'Envelope must be a Uint8Array');
  }
  const { prefix, header } = parseEnvelope(envelope);
  if (header.class !== 'project') {
    fail(
      'invalid-argument',
      'Only project envelopes are signed; content blobs are authenticated by reference'
    );
  }
  parseVersionSignature(signature);
  const signatureCopy = copyBytes(signature);
  // Hash a copy taken now (parseEnvelope bounded its size).
  const hash = await versionHash(copyBytes(envelope));
  return { prefix, versionHash: hash, signature: signatureCopy };
}

/**
 * `"OZV" | u8 1 | u32 prefix length | prefix | 32-byte version hash
 * | u8 signature length | signature`.
 */
export function encodeVersionLogRecord(record: VersionLogRecord): Bytes {
  const { record: checked } = captureRecord(record, 'invalid-argument');
  return new ByteWriter()
    .bytes(Uint8Array.from(RECORD_MAGIC))
    .u8(VERSION_LOG_RECORD_VERSION_1)
    .u32(checked.prefix.byteLength)
    .bytes(checked.prefix)
    .bytes(checked.versionHash)
    .u8(checked.signature.byteLength)
    .bytes(checked.signature)
    .finish();
}

export function decodeVersionLogRecord(bytes: Uint8Array): VersionLogRecord {
  if (!(bytes instanceof Uint8Array)) {
    fail('malformed', 'A version log record must be bytes');
  }
  for (let i = 0; i < RECORD_MAGIC.length; i += 1) {
    if (bytes[i] !== RECORD_MAGIC[i]) {
      fail('malformed', 'Not a version log record');
    }
  }
  const reader = new ByteReader(bytes, 'Version log record');
  reader.bytes(RECORD_MAGIC.length);
  const version = reader.u8();
  if (version !== VERSION_LOG_RECORD_VERSION_1) {
    fail(
      'unsupported-version',
      `Version log record version ${version} is not supported`
    );
  }
  const prefixLength = reader.u32();
  if (prefixLength > MAX_PREFIX_BYTES) {
    fail('malformed', 'A record prefix is too large');
  }
  const prefix = reader.bytes(prefixLength);
  const hash = reader.bytes(HASH_BYTES);
  const signature = reader.bytes(reader.u8());
  reader.end();
  return captureRecord(
    {
      prefix: prefix as Bytes,
      versionHash: hash as Bytes,
      signature: signature as Bytes
    },
    'malformed'
  ).record;
}

// --- Verification ---------------------------------------------------------

/** Why a log was refused; `code` is `chain-broken` or `authentication-failed`. */
export type VersionLogFailure =
  /** No records. */
  | 'empty'
  /** A record names another project than the first (or the expected one). */
  | 'project-mismatch'
  /** A record is another envelope kind than the first. */
  | 'kind-mismatch'
  /** A document version is not above the one before it. */
  | 'version-not-increasing'
  /** A record does not name the previous record's version hash: a gap or a splice. */
  | 'previous-hash-mismatch'
  /** A key epoch is below the one before it. */
  | 'epoch-decreased'
  /** The resolver knows no key for this record's author. */
  | 'signer-unknown'
  /** The resolved key did not sign this record. */
  | 'signature-invalid'
  /** The log does not contain the pinned version: a rollback or a fork. */
  | 'pinned-missing';

export class VersionLogError extends E2eeError {
  readonly reason: VersionLogFailure;
  /** The offending record's position, or null for the whole log. */
  readonly index: number | null;

  constructor(
    reason: VersionLogFailure,
    index: number | null,
    message: string
  ) {
    super(
      reason === 'signer-unknown' || reason === 'signature-invalid'
        ? 'authentication-failed'
        : 'chain-broken',
      message
    );
    this.reason = reason;
    this.index = index;
  }
}

/** What the signing-key resolver learns about one record. */
export interface VersionLogSigner {
  readonly index: number;
  readonly record: VersionLogRecord;
  readonly header: ProjectEnvelopeHeader;
  readonly signedAt: number;
}

export interface VerifyVersionLogOptions {
  /**
   * The newest version hash this browser has accepted for the project. The
   * log must contain it (`pinned-missing` otherwise). A fresh browser has
   * none, and accepts any validly signed log, however stale.
   */
  readonly pinnedVersionHash?: Uint8Array;
  /** The project the log must be for. */
  readonly projectId?: string;
  /**
   * The public key whose signature this record must carry, or null when its
   * author is unknown or not allowed (for example a device whose
   * certification `verifyAuthoredLogRecord` refuses). The v1 signature names
   * no signer, so the caller pairs the record with its author (from the
   * server's row, checked against verified device lists).
   */
  readonly resolveSigningKey: (
    signer: VersionLogSigner
  ) => Uint8Array | CryptoKey | null | Promise<Uint8Array | CryptoKey | null>;
}

export interface VerifiedVersionLogEntry {
  readonly header: ProjectEnvelopeHeader;
  readonly versionHash: Bytes;
  readonly signedAt: number;
}

export interface VerifiedVersionLog {
  readonly entries: readonly VerifiedVersionLogEntry[];
  /** The newest record: the pin to keep after accepting the log. */
  readonly head: VerifiedVersionLogEntry;
}

/**
 * Checks a version log, oldest first: one project and kind; strictly
 * increasing document versions; each record naming the previous record's
 * version hash; key epochs that never decrease; the pinned version present;
 * and every signature valid under the key the resolver returns. Each
 * refusal is a `VersionLogError` naming its `reason` and record.
 */
export async function verifyVersionLog(
  records: readonly VersionLogRecord[],
  options: VerifyVersionLogOptions
): Promise<VerifiedVersionLog> {
  if (!isList(records)) {
    fail('invalid-argument', 'records must be an array');
  }
  if (typeof options?.resolveSigningKey !== 'function') {
    fail('invalid-argument', 'resolveSigningKey must be a function');
  }
  if (options.projectId !== undefined && !isEnvelopeId(options.projectId)) {
    fail('invalid-argument', 'projectId must be a printable ASCII id');
  }
  if (records.length === 0) {
    throw new VersionLogError('empty', null, 'The version log is empty');
  }
  if (records.length > MAX_VERSION_LOG_RECORDS) {
    fail(
      'limit-exceeded',
      `Check at most ${MAX_VERSION_LOG_RECORDS} records at a time`
    );
  }
  let total = 0;
  for (const record of records) {
    total += (record?.prefix?.byteLength ?? 0) + HASH_BYTES;
  }
  if (total > MAX_VERSION_LOG_BYTES) {
    fail(
      'limit-exceeded',
      `Check at most ${MAX_VERSION_LOG_BYTES} bytes at a time`
    );
  }
  const pinned =
    options.pinnedVersionHash === undefined
      ? undefined
      : snapshotBytes(
          options.pinnedVersionHash,
          'pinnedVersionHash',
          HASH_BYTES
        );
  if (pinned && pinned.byteLength !== HASH_BYTES) {
    fail('invalid-argument', 'pinnedVersionHash must be 32 bytes');
  }
  const resolve = options.resolveSigningKey;
  const projectId = options.projectId ?? undefined;
  // Capture every record before the first await, so a caller editing the
  // list or a buffer meanwhile cannot change what is checked.
  const captured = records.map((record) => captureRecord(record, 'malformed'));
  const first = captured[0]!.header;
  const expectedProject = projectId ?? first.projectId;
  captured.forEach(({ header }, index) => {
    if (header.projectId !== expectedProject) {
      throw new VersionLogError(
        'project-mismatch',
        index,
        `Record ${index} is for another project`
      );
    }
    if (header.kind !== first.kind) {
      throw new VersionLogError(
        'kind-mismatch',
        index,
        `Record ${index} is a ${header.kind}, not a ${first.kind}`
      );
    }
    if (index === 0) return;
    const before = captured[index - 1]!;
    if (header.documentVersion <= before.header.documentVersion) {
      throw new VersionLogError(
        'version-not-increasing',
        index,
        `Version ${header.documentVersion} does not follow version ${before.header.documentVersion}`
      );
    }
    if (
      header.previousVersionHash === null ||
      !equalBytes(header.previousVersionHash, before.record.versionHash)
    ) {
      throw new VersionLogError(
        'previous-hash-mismatch',
        index,
        `Version ${header.documentVersion} does not name version ${before.header.documentVersion} as its parent`
      );
    }
    if (header.keyEpoch < before.header.keyEpoch) {
      throw new VersionLogError(
        'epoch-decreased',
        index,
        `Version ${header.documentVersion} uses key epoch ${header.keyEpoch} after ${before.header.keyEpoch}`
      );
    }
  });
  if (
    pinned &&
    !captured.some(({ record }) => equalBytes(record.versionHash, pinned))
  ) {
    throw new VersionLogError(
      'pinned-missing',
      null,
      'The version log does not contain the newest version this browser has seen'
    );
  }
  const entries: VerifiedVersionLogEntry[] = [];
  for (const [index, { record, header, signedAt }] of captured.entries()) {
    const key = await resolve({
      index,
      record: copyRecord(record),
      header,
      signedAt
    });
    if (key === null || key === undefined) {
      throw new VersionLogError(
        'signer-unknown',
        index,
        `No signing key is known for version ${header.documentVersion}`
      );
    }
    const { rs } = parseVersionSignature(record.signature);
    const valid = await verifyVersionStatement(
      key,
      versionStatementOf(record.prefix, record.versionHash, signedAt),
      rs
    );
    if (!valid) {
      throw new VersionLogError(
        'signature-invalid',
        index,
        `Version ${header.documentVersion} is not signed by its author's key`
      );
    }
    entries.push({
      header,
      versionHash: copyBytes(record.versionHash),
      signedAt
    });
  }
  return { entries, head: entries.at(-1)! };
}

function copyRecord(record: VersionLogRecord): VersionLogRecord {
  return {
    prefix: copyBytes(record.prefix),
    versionHash: copyBytes(record.versionHash),
    signature: copyBytes(record.signature)
  };
}

// --- Authorship -----------------------------------------------------------

/**
 * The newest head a revoking browser had accepted for a project when a
 * device was revoked (ADR-024, Key lifecycle). The device's signatures are
 * accepted only on that version or earlier ones.
 *
 * `keyEpoch`, when given, is the first key epoch the device must not know
 * (the identity-signed per-project cutoff): a version written under it or
 * a later one is refused as well. A cutoff without a head
 * (`documentVersion` and `versionHash` both absent) limits by key epoch
 * alone; one of the two forms is required.
 */
export interface VersionCutoff {
  readonly documentVersion?: number;
  readonly versionHash?: Uint8Array;
  readonly keyEpoch?: number;
}

/** The `cutoffs` map key for one device of one user. Ids hold no spaces. */
export function authorCutoffKey(userId: string, deviceId: string): string {
  if (!isEnvelopeId(userId) || !isEnvelopeId(deviceId)) {
    fail('invalid-argument', 'userId and deviceId must be printable ASCII ids');
  }
  return `${userId} ${deviceId}`;
}

export type AuthorshipFailure =
  /** No device certified in the given lists signed it. */
  | 'unknown-signer'
  /** Devices of two lists share the signing key, so the author is unclear. */
  | 'ambiguous-signer'
  /** The signing device is revoked and no cutoff is known for this project. */
  | 'revoked-without-cutoff'
  /** The signing device is revoked and the version is past its cutoff. */
  | 'outside-cutoff';

export class AuthorshipError extends E2eeError {
  readonly reason: AuthorshipFailure;

  constructor(reason: AuthorshipFailure, message: string) {
    super('authentication-failed', message);
    this.reason = reason;
  }
}

export interface AuthorshipOptions {
  /** Verified device lists (`verifyDeviceList`) of the possible authors. */
  readonly deviceLists: readonly VerifiedDeviceList[];
  /**
   * This project's cutoffs for revoked devices, keyed by
   * `authorCutoffKey(userId, deviceId)`. A revoked device without one is
   * refused.
   */
  readonly cutoffs?: ReadonlyMap<string, VersionCutoff>;
}

export interface VerifiedAuthor {
  readonly userId: string;
  readonly deviceId: string;
  readonly signingKeyHash: Bytes;
  /** True when the device is revoked and the version is within its cutoff. */
  readonly revoked: boolean;
  readonly signedAt: number;
  readonly header: ProjectEnvelopeHeader;
  readonly versionHash: Bytes;
}

interface Candidate {
  readonly userId: string;
  readonly deviceId: string;
  readonly signingKey: Bytes;
  readonly signingKeyHash: Bytes;
  readonly revoked: boolean;
}

/**
 * Every live and revoked device of the given lists, with copies of the keys
 * a verification uses. Taken before any await, so a caller editing a list
 * meanwhile cannot change which keys are tried.
 */
function candidatesOf(lists: readonly VerifiedDeviceList[]): Candidate[] {
  if (!isList(lists)) {
    fail('invalid-argument', 'deviceLists must be an array');
  }
  const users = new Set<string>();
  const out: Candidate[] = [];
  const add = (userId: string, device: DeviceRecord, revoked: boolean) => {
    if (
      !(device?.signingKey instanceof Uint8Array) ||
      !(device.signingKeyHash instanceof Uint8Array)
    ) {
      fail('invalid-argument', 'A device record lacks its signing key');
    }
    out.push({
      userId,
      deviceId: device.deviceId,
      signingKey: copyBytes(device.signingKey),
      signingKeyHash: copyBytes(device.signingKeyHash),
      revoked
    });
  };
  for (const list of lists) {
    if (users.has(list?.userId)) {
      fail('invalid-argument', `Two device lists for ${list.userId}`);
    }
    users.add(list.userId);
    for (const device of list.devices) add(list.userId, device, false);
    for (const revoked of list.revoked) {
      if (revoked.kind === 'device' && revoked.device) {
        add(list.userId, revoked.device, true);
      }
    }
  }
  return out;
}

/**
 * A checked copy of the caller's cutoff map: every key a string, every
 * cutoff a document version and a 32-byte hash, each hash copied. Taken
 * before any await, so a caller editing the map or a hash buffer while a
 * signature verifies cannot move a cutoff.
 */
function cutoffsOf(
  given: ReadonlyMap<string, VersionCutoff> | undefined
): ReadonlyMap<string, VersionCutoff> {
  const out = new Map<string, VersionCutoff>();
  if (given === undefined) return out;
  if (!isMap(given)) {
    fail('invalid-argument', 'cutoffs must be a Map');
  }
  for (const [key, cutoff] of given) {
    if (typeof key !== 'string') {
      fail('invalid-argument', 'cutoffs are keyed by authorCutoffKey');
    }
    if (typeof cutoff !== 'object' || cutoff === null) {
      fail('invalid-argument', 'A cutoff must be an object');
    }
    const headless =
      cutoff.documentVersion === undefined && cutoff.versionHash === undefined;
    if (
      !headless &&
      (!isUint(cutoff.documentVersion, Number.MAX_SAFE_INTEGER) ||
        !(cutoff.versionHash instanceof Uint8Array) ||
        cutoff.versionHash.byteLength !== HASH_BYTES)
    ) {
      fail(
        'invalid-argument',
        'A cutoff is a document version and a 32-byte hash'
      );
    }
    if (
      cutoff.keyEpoch !== undefined &&
      !isUint(cutoff.keyEpoch, Number.MAX_SAFE_INTEGER)
    ) {
      fail('invalid-argument', 'A cutoff key epoch is an unsigned integer');
    }
    if (headless && cutoff.keyEpoch === undefined) {
      fail('invalid-argument', 'A cutoff names a head, a key epoch or both');
    }
    out.set(key, {
      ...(headless
        ? {}
        : {
            documentVersion: cutoff.documentVersion,
            versionHash: copyBytes(cutoff.versionHash!)
          }),
      ...(cutoff.keyEpoch === undefined ? {} : { keyEpoch: cutoff.keyEpoch })
    });
  }
  return out;
}

interface CapturedAuthorship {
  readonly candidates: readonly Candidate[];
  readonly cutoffs: ReadonlyMap<string, VersionCutoff>;
}

function captureAuthorship(options: AuthorshipOptions): CapturedAuthorship {
  if (typeof options !== 'object' || options === null) {
    fail('invalid-argument', 'Authorship options are required');
  }
  return {
    candidates: candidatesOf(options.deviceLists),
    cutoffs: cutoffsOf(options.cutoffs)
  };
}

async function verifyCapturedAuthor(
  captured: ReturnType<typeof captureRecord>,
  { candidates, cutoffs }: CapturedAuthorship
): Promise<VerifiedAuthor> {
  const { header, signedAt } = captured;
  const { prefix, versionHash: hash, signature } = captured.record;
  const statement = versionStatementOf(prefix, hash, signedAt);
  const { rs } = parseVersionSignature(signature);
  // Verify each distinct key once; a key two candidates share is ambiguous.
  const byKey = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const id = toHex(candidate.signingKeyHash);
    byKey.set(id, [...(byKey.get(id) ?? []), candidate]);
  }
  let signer: Candidate[] | null = null;
  for (const group of byKey.values()) {
    if (await verifyVersionStatement(group[0]!.signingKey, statement, rs)) {
      signer = group;
      break;
    }
  }
  if (!signer) {
    throw new AuthorshipError(
      'unknown-signer',
      'No certified device of these users signed this version'
    );
  }
  const owners = new Set(signer.map((c) => `${c.userId} ${c.deviceId}`));
  if (owners.size > 1) {
    throw new AuthorshipError(
      'ambiguous-signer',
      'Several certified devices share the signing key'
    );
  }
  const author = signer[0]!;
  if (author.revoked) {
    const cutoff = cutoffs.get(authorCutoffKey(author.userId, author.deviceId));
    if (!cutoff) {
      throw new AuthorshipError(
        'revoked-without-cutoff',
        `Device ${author.deviceId} is revoked and has no cutoff for this project`
      );
    }
    const withinHead =
      cutoff.documentVersion === undefined ||
      header.documentVersion < cutoff.documentVersion ||
      (header.documentVersion === cutoff.documentVersion &&
        equalBytes(hash, cutoff.versionHash!));
    const withinEpoch =
      cutoff.keyEpoch === undefined || header.keyEpoch < cutoff.keyEpoch;
    const within = withinHead && withinEpoch;
    if (!within) {
      throw new AuthorshipError(
        'outside-cutoff',
        `Device ${author.deviceId} was revoked before version ${header.documentVersion}`
      );
    }
  }
  return {
    userId: author.userId,
    deviceId: author.deviceId,
    signingKeyHash: copyBytes(author.signingKeyHash),
    revoked: author.revoked,
    signedAt,
    header,
    versionHash: copyBytes(hash)
  };
}

/**
 * Checks who wrote a version log record: its signature must verify under a
 * device signing key certified in one of the given verified device lists.
 * When that device has since been revoked, the version must be at or
 * before the device's cutoff for this project: below the cutoff's document
 * version, or the cutoff version itself (same hash). A stolen device
 * chooses its own claimed version number, so a version below the cutoff is
 * trusted only once the caller also shows it is an ancestor of the cutoff
 * head, for example with `verifyVersionLog` over a log that contains both.
 * The record, the device keys and the cutoff map are copied and checked
 * before the first await. Refusals are `AuthorshipError`s naming their
 * `reason`.
 */
export async function verifyAuthoredLogRecord(
  record: VersionLogRecord,
  options: AuthorshipOptions
): Promise<VerifiedAuthor> {
  const captured = captureRecord(record, 'invalid-argument');
  return verifyCapturedAuthor(captured, captureAuthorship(options));
}

/**
 * `verifyAuthoredLogRecord` for a whole signed envelope.
 *
 * Project envelopes are signed by the author's certified device signing key,
 * not by an MLS leaf key (ADR-024, Version integrity and the 2026-10-24
 * amendment). This identifies that device; binding the version to MLS
 * authority is the caller's next step: check that the returned device holds a
 * leaf it certified, with an editing role, in the epoch the returned header
 * names (`keyEpoch`, `epochBindingHash`).
 */
export async function verifyAuthoredEnvelope(
  envelope: Uint8Array,
  signature: Uint8Array,
  options: AuthorshipOptions
): Promise<VerifiedAuthor> {
  // Hashing the envelope awaits: capture the options first.
  const authorship = captureAuthorship(options);
  const record = await versionLogRecord(envelope, signature);
  return verifyCapturedAuthor(
    captureRecord(record, 'invalid-argument'),
    authorship
  );
}
