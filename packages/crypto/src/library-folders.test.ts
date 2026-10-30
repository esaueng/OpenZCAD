import { describe, expect, it } from 'vitest';
import { PROJECT_PREFERENCES_MAC_INFO } from './account-records';
import { fromHex, toHex } from './bytes';
import { accountKeyCommitment } from './devices';
import { isE2eeError } from './errors';
import {
  LIBRARY_FOLDERS_KEY_INFO,
  MAX_LIBRARY_FOLDERS_PLAINTEXT_BYTES,
  openLibraryFolders,
  readLibraryFoldersHeader,
  sealLibraryFolders,
  sealLibraryFoldersWith
} from './library-folders';
import { patternBytes, queuedRandom } from './test-support';

const ACCOUNT_KEY = patternBytes(32);
const OTHER_KEY = patternBytes(32, 0x80);
const SET = new TextEncoder().encode('{"version":2,"folders":{},"members":{}}');
/**
 * Fixed vector: account key 00..1f, user "user_alice", sequence 7, IV 40..4b.
 * Checked against an independent implementation (Python `cryptography`:
 * HKDF-SHA-256 and AES-GCM). A change here is a storage-format change.
 */
const SEALED_HEX =
  '01b121bfb3bada386980ca9e4ffe4303ba46d3996b23eac9cbd7ca22d659cd1084' +
  '00000007404142434445464748494a4bde55d1f09b65644f0bc379f52c7ee65196' +
  'c1ae1b04da2854273210dcf42d5d45e5a98ee014718ac08a025723e61aca7407d6' +
  '38a39e1a4a';

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return isE2eeError(error) ? error.code : error;
  }
  return 'opened';
};

describe('sealed library folders (ADR-024 amendment 2026-10-30)', () => {
  it('matches the fixed vector and opens it', async () => {
    expect(LIBRARY_FOLDERS_KEY_INFO).toBe(
      'OpenZCAD E2EE v1 library folders key'
    );
    expect(LIBRARY_FOLDERS_KEY_INFO).not.toBe(PROJECT_PREFERENCES_MAC_INFO);
    const sealed = await sealLibraryFoldersWith(
      queuedRandom(patternBytes(12, 0x40)),
      ACCOUNT_KEY,
      'user_alice',
      7,
      SET
    );
    expect(toHex(sealed)).toBe(SEALED_HEX);
    const opened = await openLibraryFolders(
      ACCOUNT_KEY,
      'user_alice',
      fromHex(SEALED_HEX)
    );
    expect(opened.sequence).toBe(7);
    expect(opened.plaintext).toEqual(SET);
  });

  it('names the sealing key and sequence in a readable header', async () => {
    const sealed = await sealLibraryFolders(ACCOUNT_KEY, 'user_alice', 9, SET);
    const header = readLibraryFoldersHeader(sealed);
    expect(header.sequence).toBe(9);
    expect(header.commitment).toEqual(await accountKeyCommitment(ACCOUNT_KEY));
  });

  it('uses a fresh IV for every record', async () => {
    const a = await sealLibraryFolders(ACCOUNT_KEY, 'user_alice', 1, SET);
    const b = await sealLibraryFolders(ACCOUNT_KEY, 'user_alice', 1, SET);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('refuses another account key, account, or any altered byte', async () => {
    const sealed = fromHex(SEALED_HEX);
    expect(
      await code(openLibraryFolders(OTHER_KEY, 'user_alice', sealed))
    ).toBe('context-mismatch');
    expect(
      await code(openLibraryFolders(ACCOUNT_KEY, 'user_bob', sealed))
    ).toBe('authentication-failed');
    // Every byte after the commitment is authenticated: the sequence, the
    // IV and the ciphertext. (A changed commitment reads as another key.)
    for (const index of [33, 36, 37, 48, 49, sealed.byteLength - 1]) {
      const altered = sealed.slice();
      altered[index] = altered[index]! ^ 0x01;
      const result = await code(
        openLibraryFolders(ACCOUNT_KEY, 'user_alice', altered)
      );
      expect(['authentication-failed', 'malformed']).toContain(result);
    }
  });

  it('refuses unknown versions, truncation and bad arguments', async () => {
    const sealed = fromHex(SEALED_HEX);
    const newer = sealed.slice();
    newer[0] = 2;
    expect(() => readLibraryFoldersHeader(newer)).toThrow(
      expect.objectContaining({ code: 'unsupported-version' })
    );
    expect(() => readLibraryFoldersHeader(sealed.subarray(0, 60))).toThrow(
      expect.objectContaining({ code: 'malformed' })
    );
    const zero = sealed.slice();
    zero.fill(0, 33, 37);
    expect(() => readLibraryFoldersHeader(zero)).toThrow(
      expect.objectContaining({ code: 'malformed' })
    );
    expect(
      await code(sealLibraryFolders(ACCOUNT_KEY, 'user_alice', 0, SET))
    ).toBe('invalid-argument');
    expect(await code(sealLibraryFolders(ACCOUNT_KEY, '', 1, SET))).toBe(
      'invalid-argument'
    );
    expect(
      await code(
        sealLibraryFolders(
          ACCOUNT_KEY,
          'user_alice',
          1,
          new Uint8Array(MAX_LIBRARY_FOLDERS_PLAINTEXT_BYTES + 1)
        )
      )
    ).toBe('limit-exceeded');
  });

  it('fits the largest record under the Worker cap once base64url-encoded', () => {
    const sealedBytes = 37 + 12 + MAX_LIBRARY_FOLDERS_PLAINTEXT_BYTES + 16;
    expect(Math.ceil((sealedBytes * 4) / 3)).toBeLessThanOrEqual(256 * 1024);
  });
});
