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
 * The account's library folders, sealed under the account key (ADR-024
 * amendment 2026-10-30). Folder names are the owner's words, so an account
 * whose projects are encrypted stores its folders this way only.
 *
 * Layout, big-endian:
 *
 *   version (1) | account-key commitment (32) | sequence (4) | IV (12) |
 *   AES-256-GCM ciphertext and tag
 *
 * The key is HKDF-SHA-256 of the account key (empty salt, info
 * `LIBRARY_FOLDERS_KEY_INFO`). The additional data binds the record to its
 * account and to the whole header, so neither the commitment nor the
 * sequence can be changed or moved to another account. The commitment names
 * the account key that sealed the record: a reader holding another key knows
 * it cannot open it without trying. The sequence rises with every write;
 * readers pin the highest they opened and refuse a lower one, so the server
 * cannot roll the folders back unnoticed.
 */
export const LIBRARY_FOLDERS_KEY_INFO = 'OpenZCAD E2EE v1 library folders key';
export const LIBRARY_FOLDERS_VERSION_1 = 1;
/** Leaves the base64url record under the Worker's 256 KiB character cap. */
export const MAX_LIBRARY_FOLDERS_PLAINTEXT_BYTES = 190 * 1024;

const AAD_LABEL = 'OpenZCAD E2EE v1 library folders\0';
const COMMITMENT_BYTES = 32;
const HEADER_BYTES = 1 + COMMITMENT_BYTES + 4;
const MAX_SEQUENCE = 0xffffffff;

export interface LibraryFoldersHeader {
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
export function readLibraryFoldersHeader(
  sealed: Uint8Array
): LibraryFoldersHeader {
  if (
    !(sealed instanceof Uint8Array) ||
    sealed.byteLength < HEADER_BYTES + GCM_IV_BYTES + GCM_TAG_BYTES
  ) {
    throw new E2eeError('malformed', 'A sealed folder record is truncated');
  }
  if (sealed[0] !== LIBRARY_FOLDERS_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Sealed folder record version ${sealed[0]} is not supported`
    );
  }
  const sequence = new DataView(
    sealed.buffer,
    sealed.byteOffset + 1 + COMMITMENT_BYTES,
    4
  ).getUint32(0);
  if (!validSequence(sequence)) {
    throw new E2eeError('malformed', 'A sealed folder record has sequence 0');
  }
  return {
    commitment: copyBytes(sealed.subarray(1, 1 + COMMITMENT_BYTES)),
    sequence
  };
}

async function foldersKey(accountKey: Uint8Array): Promise<CryptoKey> {
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: utf8(LIBRARY_FOLDERS_KEY_INFO)
    },
    await hkdfBaseKey(accountKey, 'An account key'),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function additionalData(userId: string, header: Uint8Array): Bytes {
  return concatBytes(
    utf8(AAD_LABEL),
    utf8(userId),
    new Uint8Array([0]),
    header
  );
}

/** `sealLibraryFolders` with an injected random source, for fixed vectors. */
export async function sealLibraryFoldersWith(
  random: RandomSource,
  accountKey: Uint8Array,
  userId: string,
  sequence: number,
  plaintext: Uint8Array
): Promise<Bytes> {
  if (!validUserId(userId) || !validSequence(sequence)) {
    throw new E2eeError(
      'invalid-argument',
      'A sealed folder record needs a user id and a sequence from 1'
    );
  }
  if (
    !(plaintext instanceof Uint8Array) ||
    plaintext.byteLength > MAX_LIBRARY_FOLDERS_PLAINTEXT_BYTES
  ) {
    throw new E2eeError(
      'limit-exceeded',
      `Library folders exceed ${MAX_LIBRARY_FOLDERS_PLAINTEXT_BYTES} bytes`
    );
  }
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = LIBRARY_FOLDERS_VERSION_1;
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
        additionalData: additionalData(userId, header)
      },
      await foldersKey(accountKey),
      asBytes(plaintext)
    )
  );
  return concatBytes(header, iv, ciphertext);
}

/** Seals the folder-set bytes for this account at `sequence`. */
export function sealLibraryFolders(
  accountKey: Uint8Array,
  userId: string,
  sequence: number,
  plaintext: Uint8Array
): Promise<Bytes> {
  return sealLibraryFoldersWith(
    systemRandom,
    accountKey,
    userId,
    sequence,
    plaintext
  );
}

/**
 * The folder-set bytes and their sequence. Throws `context-mismatch` when
 * another account key sealed the record (see the header's commitment), and
 * `authentication-failed` for altered bytes or another account.
 */
export async function openLibraryFolders(
  accountKey: Uint8Array,
  userId: string,
  sealed: Uint8Array
): Promise<{ readonly sequence: number; readonly plaintext: Bytes }> {
  if (!validUserId(userId)) {
    throw new E2eeError('invalid-argument', 'A user id is required');
  }
  const header = readLibraryFoldersHeader(sealed);
  if (!equalBytes(header.commitment, await accountKeyCommitment(accountKey))) {
    throw new E2eeError(
      'context-mismatch',
      'Another account key sealed these folders'
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
            userId,
            bytes.subarray(0, HEADER_BYTES)
          )
        },
        await foldersKey(accountKey),
        bytes.subarray(HEADER_BYTES + GCM_IV_BYTES)
      )
    );
  } catch {
    throw new E2eeError(
      'authentication-failed',
      'The sealed folder record failed authentication: wrong account or altered bytes'
    );
  }
  if (plaintext.byteLength > MAX_LIBRARY_FOLDERS_PLAINTEXT_BYTES) {
    throw new E2eeError('limit-exceeded', 'Library folders are too large');
  }
  return { sequence: header.sequence, plaintext };
}
