/**
 * The collaboration room for end-to-end encrypted projects (ADR-024 Phase 4,
 * slice 4-9; roadmap L11). A format-2 room relays signed document envelopes
 * it cannot read. It never parses or normalizes document content: it reads
 * only an envelope's plaintext header, through the account seam below, and
 * orders submissions by the header's previous-version hash and document
 * version, under the group's current key epoch.
 *
 * The account's version log (slice 4-5) stays the one chain. A submission
 * the room accepts is written there in the same queued operation, through
 * the encrypted version path, so a browser that pins a room head finds it in
 * the account's log, and an account write made outside the room (a named
 * save, or autosave while the room was unreachable) becomes the room's head
 * the next time the room looks.
 *
 * The room keeps the latest envelope and a bounded set of older ones (the
 * merge bases a stale submission may name), each with its log record, under
 * keys of their own, apart from the plaintext room's.
 */
import {
  MAX_DOCUMENT_VERSION_ADVANCE,
  type CollaborationErrorCode,
  type E2eeRoomHead,
  type E2eeStoredVersion
} from '@openzcad/shared';

/** The session a socket or request was admitted under, by its token hash. */
export interface E2eeRoomCredential {
  table: 'auth_sessions' | 'desktop_access_tokens';
  tokenHash: string;
}

/** What the room may know about an envelope: its plaintext header only. */
export interface E2eeEnvelopeSummary {
  projectId: string;
  kind: string;
  documentVersion: number;
  keyEpoch: number;
  /** Lowercase hex; null only on a project's first version. */
  previousVersionHash: string | null;
  /** The version hash the account would record, lowercase hex. */
  versionHash: string;
}

export interface E2eeRoomVersion {
  record: E2eeStoredVersion;
  envelope: Uint8Array | null;
}

export type E2eeRoomWriteResult =
  | { kind: 'accepted'; record: E2eeStoredVersion }
  /** The account's head moved: the room re-reads it and reports a conflict. */
  | { kind: 'conflict' }
  | { kind: 'epoch-stale'; keyEpoch: number }
  | {
      kind: 'refused';
      code: CollaborationErrorCode;
      message: string;
      /** With `blob-unknown`: the blobs the account no longer holds. */
      blobIds?: string[];
    };

/**
 * The account's encrypted version store, as the room uses it. The Worker
 * supplies it (`apps/web/worker/e2eeRoomAccount.ts`); a room without one
 * refuses every encrypted request.
 */
export interface E2eeRoomAccount {
  /** The envelope's header, or null when it is not an envelope. */
  inspect(envelope: Uint8Array): Promise<E2eeEnvelopeSummary | null>;
  /**
   * The account's head and the group's current key epoch; null unless the
   * project is a live format-2 project with a head.
   */
  head(
    projectId: string
  ): Promise<{ record: E2eeStoredVersion; keyEpoch: number } | null>;
  /** A retained version's envelope, or null when the account no longer has it. */
  envelope(projectId: string, versionHash: string): Promise<Uint8Array | null>;
  /**
   * Writes one version on top of `expectedVersion` through the encrypted
   * version path (with `revisionId`, the named-save path), as `userId`,
   * fenced on `credential`'s session.
   */
  write(input: {
    projectId: string;
    userId: string;
    credential: E2eeRoomCredential | null;
    envelope: Uint8Array;
    signature: string;
    wrappedVersionKey: string;
    signerDeviceId: string;
    expectedVersion: number;
    revisionId: string | null;
  }): Promise<E2eeRoomWriteResult>;
}

/**
 * The largest envelope the room keeps and relays. Two travel in a conflict
 * frame as base64, which must stay under what browsers accept from the room.
 * A larger head is still the room's head; browsers read its body from the
 * account.
 */
export const MAX_E2EE_ROOM_ENVELOPE_BYTES = 1_200_000;
/** Older versions kept as merge bases, as the plaintext room keeps 20. */
export const MAX_E2EE_ROOM_RETAINED = 20;

const META_KEY = 'room:e2ee:meta';
const VERSION_PREFIX = 'room:e2ee:v:';
const HASH = /^[0-9a-f]{64}$/;

interface LedgerMeta {
  schema: 1;
  latest: string | null;
  /** Oldest first. */
  retained: string[];
}

export interface E2eeRoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
}

const versionKey = (hash: string) => `${VERSION_PREFIX}${hash}`;

/** The room's encrypted versions in Durable Object storage. */
export class E2eeRoomLedger {
  #meta: LedgerMeta = { schema: 1, latest: null, retained: [] };
  #latest: E2eeRoomVersion | null = null;
  #loaded = false;

  constructor(private readonly storage: E2eeRoomStorage) {}

  async load(): Promise<void> {
    if (this.#loaded) return;
    const meta = await this.storage.get<LedgerMeta>(META_KEY);
    if (meta?.schema === 1) {
      this.#meta = {
        schema: 1,
        latest: meta.latest,
        retained: [...meta.retained]
      };
      this.#latest = meta.latest
        ? ((await this.storage.get<E2eeRoomVersion>(versionKey(meta.latest))) ??
          null)
        : null;
    }
    this.#loaded = true;
  }

  get latest(): E2eeRoomVersion | null {
    return this.#latest;
  }

  /** Hashes of the older versions the room still holds, oldest first. */
  get retained(): readonly string[] {
    return this.#meta.retained;
  }

  async version(hash: string): Promise<E2eeRoomVersion | null> {
    if (hash === this.#meta.latest) return this.#latest;
    if (!this.#meta.retained.includes(hash)) return null;
    return (await this.storage.get<E2eeRoomVersion>(versionKey(hash))) ?? null;
  }

  /** Makes `next` the head; the previous head becomes a merge base. */
  async advance(next: E2eeRoomVersion): Promise<void> {
    const hash = next.record.versionHash;
    if (!HASH.test(hash)) throw new Error('Invalid version hash.');
    if (hash === this.#meta.latest) return;
    const stored: E2eeRoomVersion = {
      record: next.record,
      envelope:
        next.envelope &&
        next.envelope.byteLength <= MAX_E2EE_ROOM_ENVELOPE_BYTES
          ? next.envelope
          : null
    };
    const retained = this.#meta.retained.filter(
      (candidate) => candidate !== hash
    );
    if (this.#meta.latest) retained.push(this.#meta.latest);
    const evicted = retained.splice(
      0,
      Math.max(0, retained.length - MAX_E2EE_ROOM_RETAINED)
    );
    const meta: LedgerMeta = { schema: 1, latest: hash, retained };
    // The index never names a key the same batch did not write.
    await this.storage.put({ [versionKey(hash)]: stored, [META_KEY]: meta });
    this.#meta = meta;
    this.#latest = stored;
    if (evicted.length) await this.storage.delete(evicted.map(versionKey));
  }
}

/** A stored version as it travels in a frame. */
export function roomHead(version: E2eeRoomVersion): E2eeRoomHead {
  return {
    record: version.record,
    envelope: version.envelope ? base64Url(version.envelope) : null
  };
}

export type E2eeRoomOrdering =
  /** The room's head already is this envelope. */
  | { kind: 'same' }
  /** Builds on the head: write it to the account. */
  | { kind: 'advance' }
  /** Builds on an older version (`baseHash`, when the room holds it). */
  | { kind: 'conflict'; baseHash: string | null }
  | { kind: 'epoch-stale' }
  | { kind: 'invalid'; message: string };

/**
 * Orders a submission against the room's head, from headers alone. A
 * submission that builds on an older version is a conflict however large
 * its version number; one that builds on the head must move the version
 * forward (within the usual advance) and use the group's current key epoch.
 */
export function orderE2eeSubmission(
  projectId: string,
  latest: E2eeStoredVersion,
  keyEpoch: number,
  retained: readonly string[],
  submission: E2eeEnvelopeSummary
): E2eeRoomOrdering {
  if (submission.projectId !== projectId || submission.kind !== 'document') {
    return {
      kind: 'invalid',
      message: 'The room relays this project’s document envelopes only.'
    };
  }
  if (submission.versionHash === latest.versionHash) return { kind: 'same' };
  const previous = submission.previousVersionHash;
  if (previous !== latest.versionHash) {
    return {
      kind: 'conflict',
      baseHash:
        previous !== null && retained.includes(previous) ? previous : null
    };
  }
  if (
    submission.documentVersion <= latest.documentVersion ||
    submission.documentVersion >
      latest.documentVersion + MAX_DOCUMENT_VERSION_ADVANCE
  ) {
    return {
      kind: 'invalid',
      message: 'The document version must move forward from the room’s head.'
    };
  }
  if (submission.keyEpoch < keyEpoch) return { kind: 'epoch-stale' };
  if (submission.keyEpoch > keyEpoch) {
    return {
      kind: 'invalid',
      message: 'The version names a key epoch the project does not have.'
    };
  }
  return { kind: 'advance' };
}

export interface E2eeRoomWriter {
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  credential?: E2eeRoomCredential;
}

export type E2eeRoomOutcome =
  | { kind: 'ack'; record: E2eeStoredVersion; advanced: boolean }
  | { kind: 'conflict'; latest: E2eeRoomHead; base?: E2eeRoomHead }
  | {
      kind: 'error';
      rejection: {
        code: CollaborationErrorCode;
        message: string;
        blobIds?: string[];
      };
    };

/**
 * One room's ordering of encrypted submissions over its ledger and the
 * account. Callers serialize every call on the room's queue.
 */
export class E2eeRoomSequencer {
  constructor(
    private readonly account: E2eeRoomAccount,
    private readonly ledger: E2eeRoomLedger,
    private readonly projectId: string
  ) {}

  get head(): E2eeRoomHead | null {
    return this.ledger.latest ? roomHead(this.ledger.latest) : null;
  }

  /**
   * Makes the account's head the room's. The account's log is the one
   * chain: a version written there outside the room (a named save, or
   * autosave while the room was unreachable) becomes the room's head, and
   * the room's previous head stays as a merge base.
   */
  async sync(): Promise<{ keyEpoch: number; moved: boolean } | null> {
    const current = await this.account.head(this.projectId);
    if (!current) return null;
    const hash = current.record.versionHash;
    if (this.ledger.latest?.record.versionHash === hash) {
      return { keyEpoch: current.keyEpoch, moved: false };
    }
    const envelope =
      current.record.envelopeBytes <= MAX_E2EE_ROOM_ENVELOPE_BYTES
        ? await this.account.envelope(this.projectId, hash)
        : null;
    await this.ledger.advance({ record: current.record, envelope });
    return { keyEpoch: current.keyEpoch, moved: true };
  }

  /**
   * Orders one submission and, when it builds on the head under the current
   * epoch, writes it to the account (with `revisionId`, as a named save)
   * before it becomes the room's head.
   */
  async submit(
    writer: E2eeRoomWriter,
    version: unknown,
    revisionId: string | null
  ): Promise<E2eeRoomOutcome> {
    const refuse = (code: CollaborationErrorCode, message: string) => ({
      kind: 'error' as const,
      rejection: { code, message }
    });
    // The owner and editors write (slice 5-6). The room read the role from
    // the Worker's mirror just before (`canAuthor`), and the account's own
    // write checks it again in the same statement batch.
    if (writer.role === 'viewer') {
      return refuse(
        'permission-denied',
        'Viewers cannot change the collaboration document.'
      );
    }
    const parsed = parseE2eeSubmission(version);
    if (!parsed.ok) return refuse(parsed.code, parsed.message);
    const summary = await this.account.inspect(parsed.submission.envelope);
    if (!summary) {
      return refuse(
        'document-invalid',
        'The submission is not an encrypted document envelope.'
      );
    }
    const current = await this.sync();
    const latest = this.ledger.latest;
    if (!current || !latest) {
      return refuse(
        'document-invalid',
        'This encrypted project has no account copy the room can relay.'
      );
    }
    const ordering = orderE2eeSubmission(
      this.projectId,
      latest.record,
      current.keyEpoch,
      this.ledger.retained,
      summary
    );
    switch (ordering.kind) {
      case 'same':
        return { kind: 'ack', record: latest.record, advanced: false };
      case 'invalid':
        return refuse('document-invalid', ordering.message);
      case 'epoch-stale':
        return refuse('epoch-stale', epochStaleMessage(current.keyEpoch));
      case 'conflict':
        return this.#conflict(ordering.baseHash);
    }
    const written = await this.account.write({
      projectId: this.projectId,
      userId: writer.userId,
      credential: writer.credential ?? null,
      ...parsed.submission,
      expectedVersion: latest.record.documentVersion,
      revisionId
    });
    switch (written.kind) {
      case 'accepted':
        await this.ledger.advance({
          record: written.record,
          envelope: parsed.submission.envelope
        });
        return { kind: 'ack', record: written.record, advanced: true };
      case 'conflict': {
        // The account moved outside the room; its head becomes the room's.
        await this.sync();
        const previous = summary.previousVersionHash;
        return this.#conflict(
          previous !== null && this.ledger.retained.includes(previous)
            ? previous
            : null
        );
      }
      case 'epoch-stale':
        return refuse('epoch-stale', epochStaleMessage(written.keyEpoch));
      default:
        return {
          kind: 'error',
          rejection: {
            code: written.code,
            message: written.message,
            ...(written.blobIds ? { blobIds: written.blobIds } : {})
          }
        };
    }
  }

  async #conflict(baseHash: string | null): Promise<E2eeRoomOutcome> {
    const latest = this.ledger.latest!;
    const base = baseHash ? await this.ledger.version(baseHash) : null;
    return {
      kind: 'conflict',
      latest: roomHead(latest),
      ...(base && base !== latest ? { base: roomHead(base) } : {})
    };
  }
}

const epochStaleMessage = (keyEpoch: number) =>
  `The project’s keys moved to epoch ${keyEpoch}. Catch up and send again.`;

/** Reads `x-openzcad-write-credential` (`<table>:<sha-256 hex>`). */
export function parseE2eeRoomCredential(
  value: string | null
): E2eeRoomCredential | null {
  if (!value) return null;
  const match = /^(auth_sessions|desktop_access_tokens):([0-9a-f]{64})$/.exec(
    value
  );
  return match
    ? {
        table: match[1] as E2eeRoomCredential['table'],
        tokenHash: match[2]!
      }
    : null;
}

export function validE2eeRoomCredential(
  value: unknown
): value is E2eeRoomCredential {
  return (
    typeof value === 'object' &&
    value !== null &&
    ((value as E2eeRoomCredential).table === 'auth_sessions' ||
      (value as E2eeRoomCredential).table === 'desktop_access_tokens') &&
    typeof (value as E2eeRoomCredential).tokenHash === 'string' &&
    HASH.test((value as E2eeRoomCredential).tokenHash)
  );
}

export interface ParsedE2eeSubmission {
  envelope: Uint8Array;
  signature: string;
  wrappedVersionKey: string;
  signerDeviceId: string;
}

const B64URL = /^[A-Za-z0-9_-]*$/;

/** Shape-checks a submission; the account checks the bytes themselves. */
export function parseE2eeSubmission(
  value: unknown
):
  | { ok: true; submission: ParsedE2eeSubmission }
  | { ok: false; code: CollaborationErrorCode; message: string } {
  const input = value as Partial<Record<string, unknown>> | null;
  const text = (field: string, max: number) => {
    const candidate = input?.[field];
    return typeof candidate === 'string' &&
      candidate.length > 0 &&
      candidate.length <= max &&
      B64URL.test(candidate)
      ? candidate
      : null;
  };
  const envelopeText = text('envelope', 4 * 1024 * 1024);
  const signature = text('signature', 256);
  const wrappedVersionKey = text('wrappedVersionKey', 256);
  const signerDeviceId = input?.signerDeviceId;
  if (
    typeof input !== 'object' ||
    !envelopeText ||
    !signature ||
    !wrappedVersionKey ||
    typeof signerDeviceId !== 'string' ||
    !signerDeviceId ||
    signerDeviceId.length > 200
  ) {
    return {
      ok: false,
      code: 'document-invalid',
      message: 'An encrypted room submission must carry a signed envelope.'
    };
  }
  if (
    Math.floor((envelopeText.length * 3) / 4) > MAX_E2EE_ROOM_ENVELOPE_BYTES
  ) {
    return {
      ok: false,
      code: 'document-too-large',
      message: `Encrypted room versions hold at most ${MAX_E2EE_ROOM_ENVELOPE_BYTES} bytes; this one is saved through the account instead.`
    };
  }
  let envelope: Uint8Array;
  try {
    envelope = fromBase64Url(envelopeText);
  } catch {
    return {
      ok: false,
      code: 'document-invalid',
      message: 'An encrypted room submission must carry a signed envelope.'
    };
  }
  return {
    ok: true,
    submission: { envelope, signature, wrappedVersionKey, signerDeviceId }
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
