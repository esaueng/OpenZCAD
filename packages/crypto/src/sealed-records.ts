import { accountKeyCommitment } from './devices';
import {
  asBytes,
  concatBytes,
  copyBytes,
  equalBytes,
  utf8,
  type Bytes
} from './bytes';
import { E2eeError } from './errors';
import {
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  hkdfBaseKey,
  subtle,
  systemRandom,
  type RandomSource
} from './primitives';

/**
 * One account record sealed under the account key: the layout library
 * folders introduced (ADR-024 amendment 2026-10-30), shared by every record
 * an account keeps beside its projects (settings, amendment 2026-11-14).
 *
 * Layout, big-endian:
 *
 *   version (1) | account-key commitment (32) | sequence (4) | IV (12) |
 *   AES-256-GCM ciphertext and tag
 *
 * Each kind derives its own key, HKDF-SHA-256 of the account key with an
 * empty salt and the kind's `keyInfo`, and binds its own label, the user id
 * and the whole header as additional data. So no kind's key opens another
 * kind's record, a record cannot move to another account, and neither the
 * commitment nor the sequence can be changed. The commitment names the
 * account key that sealed the record: a reader holding another key knows it
 * cannot open it without trying. The sequence rises with every write;
 * readers pin the highest they opened and refuse a lower one, so the server
 * cannot roll the record back unnoticed.
 */
export interface SealedRecordKind {
  /** HKDF info; distinct from every other account-key derivation. */
  readonly keyInfo: string;
  /** Additional-data label, ending in NUL. */
  readonly aadLabel: string;
  /** Plaintext cap; leaves the base64url record under the Worker's cap. */
  readonly maxPlaintextBytes: number;
  /** "folder record", "settings record": used in error messages. */
  readonly noun: string;
}

export const SEALED_RECORD_VERSION_1 = 1;

const COMMITMENT_BYTES = 32;
const HEADER_BYTES = 1 + COMMITMENT_BYTES + 4;
const MAX_SEQUENCE = 0xffffffff;

export interface SealedRecordHeader {
  /** `accountKeyCommitment` of the account key that sealed the record. */
  readonly commitment: Bytes;
  readonly sequence: number;
}

function validUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function validSequence(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_SEQUENCE
  );
}

/** The header, readable without the key. */
export function readSealedRecordHeader(
  kind: SealedRecordKind,
  sealed: Uint8Array
): SealedRecordHeader {
  if (
    !(sealed instanceof Uint8Array) ||
    sealed.byteLength < HEADER_BYTES + GCM_IV_BYTES + GCM_TAG_BYTES
  ) {
    throw new E2eeError('malformed', `A sealed ${kind.noun} is truncated`);
  }
  if (sealed[0] !== SEALED_RECORD_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Sealed ${kind.noun} version ${sealed[0]} is not supported`
    );
  }
  const sequence = new DataView(
    sealed.buffer,
    sealed.byteOffset + 1 + COMMITMENT_BYTES,
    4
  ).getUint32(0);
  if (!validSequence(sequence)) {
    throw new E2eeError('malformed', `A sealed ${kind.noun} has sequence 0`);
  }
  return {
    commitment: copyBytes(sealed.subarray(1, 1 + COMMITMENT_BYTES)),
    sequence
  };
}

async function recordKey(
  kind: SealedRecordKind,
  accountKey: Uint8Array
): Promise<CryptoKey> {
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: utf8(kind.keyInfo)
    },
    await hkdfBaseKey(accountKey, 'An account key'),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function additionalData(
  kind: SealedRecordKind,
  userId: string,
  header: Uint8Array
): Bytes {
  return concatBytes(
    utf8(kind.aadLabel),
    utf8(userId),
    new Uint8Array([0]),
    header
  );
}

/** `sealRecord` with an injected random source, for fixed vectors. */
export async function sealRecordWith(
  kind: SealedRecordKind,
  random: RandomSource,
  accountKey: Uint8Array,
  userId: string,
  sequence: number,
  plaintext: Uint8Array
): Promise<Bytes> {
  if (!validUserId(userId) || !validSequence(sequence)) {
    throw new E2eeError(
      'invalid-argument',
      `A sealed ${kind.noun} needs a user id and a sequence from 1`
    );
  }
  if (
    !(plaintext instanceof Uint8Array) ||
    plaintext.byteLength > kind.maxPlaintextBytes
  ) {
    throw new E2eeError(
      'limit-exceeded',
      `The ${kind.noun} exceeds ${kind.maxPlaintextBytes} bytes`
    );
  }
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = SEALED_RECORD_VERSION_1;
  header.set(await accountKeyCommitment(accountKey), 1);
  new DataView(header.buffer).setUint32(1 + COMMITMENT_BYTES, sequence);
  // A fresh random IV per record: one derived key seals at most one record
  // per write, far below the 2^32 random-IV bound for AES-GCM.
  const iv = random(GCM_IV_BYTES);
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      {
        name: 'AES-GCM',
        iv: asBytes(iv),
        additionalData: additionalData(kind, userId, header)
      },
      await recordKey(kind, accountKey),
      asBytes(plaintext)
    )
  );
  return concatBytes(header, iv, ciphertext);
}

/** Seals `plaintext` as this kind of record for this account at `sequence`. */
export function sealRecord(
  kind: SealedRecordKind,
  accountKey: Uint8Array,
  userId: string,
  sequence: number,
  plaintext: Uint8Array
): Promise<Bytes> {
  return sealRecordWith(
    kind,
    systemRandom,
    accountKey,
    userId,
    sequence,
    plaintext
  );
}

/**
 * The record's bytes and sequence. Throws `context-mismatch` when another
 * account key sealed the record (see the header's commitment), and
 * `authentication-failed` for altered bytes, another account or another
 * kind of record.
 */
export async function openRecord(
  kind: SealedRecordKind,
  accountKey: Uint8Array,
  userId: string,
  sealed: Uint8Array
): Promise<{ readonly sequence: number; readonly plaintext: Bytes }> {
  if (!validUserId(userId)) {
    throw new E2eeError('invalid-argument', 'A user id is required');
  }
  const header = readSealedRecordHeader(kind, sealed);
  if (!equalBytes(header.commitment, await accountKeyCommitment(accountKey))) {
    throw new E2eeError(
      'context-mismatch',
      `Another account key sealed this ${kind.noun}`
    );
  }
  const bytes = asBytes(sealed);
  let plaintext: Bytes;
  try {
    plaintext = new Uint8Array(
      await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: bytes.subarray(HEADER_BYTES, HEADER_BYTES + GCM_IV_BYTES),
          additionalData: additionalData(
            kind,
            userId,
            bytes.subarray(0, HEADER_BYTES)
          )
        },
        await recordKey(kind, accountKey),
        bytes.subarray(HEADER_BYTES + GCM_IV_BYTES)
      )
    );
  } catch {
    throw new E2eeError(
      'authentication-failed',
      `The sealed ${kind.noun} failed authentication: wrong account or altered bytes`
    );
  }
  if (plaintext.byteLength > kind.maxPlaintextBytes) {
    throw new E2eeError('limit-exceeded', `The ${kind.noun} is too large`);
  }
  return { sequence: header.sequence, plaintext };
}

/**
 * Account settings that only the browser reads (ADR-024 amendment
 * 2026-11-14): everything but the collaboration switch and the assistant's
 * provider route, which the Worker needs to act on.
 */
export const ACCOUNT_SETTINGS_RECORD: SealedRecordKind = {
  keyInfo: 'OpenZCAD E2EE v1 account settings key',
  aadLabel: 'OpenZCAD E2EE v1 account settings\0',
  // Settings JSON is a few KiB; custom instructions are capped at 4,000
  // characters. Well under the Worker's 64 KiB record cap once encoded.
  maxPlaintextBytes: 32 * 1024,
  noun: 'settings record'
};
