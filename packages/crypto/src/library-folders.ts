import type { Bytes } from './bytes';
import type { RandomSource } from './primitives';
import {
  openRecord,
  readSealedRecordHeader,
  sealRecord,
  sealRecordWith,
  SEALED_RECORD_VERSION_1,
  type SealedRecordHeader,
  type SealedRecordKind
} from './sealed-records';

/**
 * The account's library folders, sealed under the account key (ADR-024
 * amendment 2026-10-30). Folder names are the owner's words, so an account
 * whose projects are encrypted stores its folders this way only.
 *
 * The layout, key derivation and additional data are the shared sealed
 * account record's (`sealed-records.ts`), under this kind's own key info and
 * label; the fixed vector in the tests pins the bytes.
 */
export const LIBRARY_FOLDERS_KEY_INFO = 'OpenZCAD E2EE v1 library folders key';
export const LIBRARY_FOLDERS_VERSION_1 = SEALED_RECORD_VERSION_1;
/** Leaves the base64url record under the Worker's 256 KiB character cap. */
export const MAX_LIBRARY_FOLDERS_PLAINTEXT_BYTES = 190 * 1024;

const LIBRARY_FOLDERS_RECORD: SealedRecordKind = {
  keyInfo: LIBRARY_FOLDERS_KEY_INFO,
  aadLabel: 'OpenZCAD E2EE v1 library folders\0',
  maxPlaintextBytes: MAX_LIBRARY_FOLDERS_PLAINTEXT_BYTES,
  noun: 'folder record'
};

export type LibraryFoldersHeader = SealedRecordHeader;

/** The header, readable without the key. */
export function readLibraryFoldersHeader(
  sealed: Uint8Array
): LibraryFoldersHeader {
  return readSealedRecordHeader(LIBRARY_FOLDERS_RECORD, sealed);
}

/** `sealLibraryFolders` with an injected random source, for fixed vectors. */
export function sealLibraryFoldersWith(
  random: RandomSource,
  accountKey: Uint8Array,
  userId: string,
  sequence: number,
  plaintext: Uint8Array
): Promise<Bytes> {
  return sealRecordWith(
    LIBRARY_FOLDERS_RECORD,
    random,
    accountKey,
    userId,
    sequence,
    plaintext
  );
}

/** Seals the folder-set bytes for this account at `sequence`. */
export function sealLibraryFolders(
  accountKey: Uint8Array,
  userId: string,
  sequence: number,
  plaintext: Uint8Array
): Promise<Bytes> {
  return sealRecord(
    LIBRARY_FOLDERS_RECORD,
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
export function openLibraryFolders(
  accountKey: Uint8Array,
  userId: string,
  sealed: Uint8Array
): Promise<{ readonly sequence: number; readonly plaintext: Bytes }> {
  return openRecord(LIBRARY_FOLDERS_RECORD, accountKey, userId, sealed);
}
