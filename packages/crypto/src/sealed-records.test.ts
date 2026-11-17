import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from './bytes';
import { isE2eeError } from './errors';
import {
  LIBRARY_FOLDERS_KEY_INFO,
  sealLibraryFolders
} from './library-folders';
import {
  ACCOUNT_SETTINGS_RECORD,
  openRecord,
  readSealedRecordHeader,
  sealRecord,
  sealRecordWith
} from './sealed-records';
import { PROJECT_PREFERENCES_MAC_INFO } from './account-records';
import { patternBytes, queuedRandom } from './test-support';

const ACCOUNT_KEY = patternBytes(32);
const OTHER_KEY = patternBytes(32, 0x80);
const SETTINGS = new TextEncoder().encode('{"schemaVersion":1}');
/**
 * Fixed vector: account key 00..1f, user "user_alice", sequence 7, IV 40..4b.
 * Checked against an independent implementation (Python `cryptography`:
 * HKDF-SHA-256 and AES-GCM), which also reproduces the library-folder
 * vector. A change here is a storage-format change.
 */
const SEALED_SETTINGS_HEX =
  '01b121bfb3bada386980ca9e4ffe4303ba46d3996b23eac9cbd7ca22d659cd1084' +
  '00000007404142434445464748494a4bc509179862c4cd85370f55bdca63979c17' +
  '428748c86c01fc3310ed8e28a4201dd6e7b5';

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return isE2eeError(error) ? error.code : error;
  }
  return 'opened';
};

describe('sealed account settings (ADR-024 amendment 2026-11-14)', () => {
  it('matches the fixed vector and opens it', async () => {
    expect(ACCOUNT_SETTINGS_RECORD.keyInfo).toBe(
      'OpenZCAD E2EE v1 account settings key'
    );
    for (const other of [LIBRARY_FOLDERS_KEY_INFO, PROJECT_PREFERENCES_MAC_INFO])
      expect(ACCOUNT_SETTINGS_RECORD.keyInfo).not.toBe(other);
    const sealed = await sealRecordWith(
      ACCOUNT_SETTINGS_RECORD,
      queuedRandom(patternBytes(12, 0x40)),
      ACCOUNT_KEY,
      'user_alice',
      7,
      SETTINGS
    );
    expect(toHex(sealed)).toBe(SEALED_SETTINGS_HEX);
    const opened = await openRecord(
      ACCOUNT_SETTINGS_RECORD,
      ACCOUNT_KEY,
      'user_alice',
      fromHex(SEALED_SETTINGS_HEX)
    );
    expect(opened).toEqual({ sequence: 7, plaintext: SETTINGS });
    expect(
      readSealedRecordHeader(ACCOUNT_SETTINGS_RECORD, sealed).sequence
    ).toBe(7);
  });

  it('opens for its own account key, account and kind only', async () => {
    const sealed = await sealRecord(
      ACCOUNT_SETTINGS_RECORD,
      ACCOUNT_KEY,
      'user_alice',
      1,
      SETTINGS
    );
    expect(
      await code(
        openRecord(ACCOUNT_SETTINGS_RECORD, OTHER_KEY, 'user_alice', sealed)
      )
    ).toBe('context-mismatch');
    expect(
      await code(
        openRecord(ACCOUNT_SETTINGS_RECORD, ACCOUNT_KEY, 'user_bob', sealed)
      )
    ).toBe('authentication-failed');
    // A folder record never opens as settings, nor settings as folders.
    const folders = await sealLibraryFolders(
      ACCOUNT_KEY,
      'user_alice',
      1,
      SETTINGS
    );
    expect(
      await code(
        openRecord(ACCOUNT_SETTINGS_RECORD, ACCOUNT_KEY, 'user_alice', folders)
      )
    ).toBe('authentication-failed');
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(
      await code(
        openRecord(ACCOUNT_SETTINGS_RECORD, ACCOUNT_KEY, 'user_alice', tampered)
      )
    ).toBe('authentication-failed');
  });

  it('refuses oversized settings', async () => {
    expect(
      await code(
        sealRecord(
          ACCOUNT_SETTINGS_RECORD,
          ACCOUNT_KEY,
          'user_alice',
          1,
          new Uint8Array(ACCOUNT_SETTINGS_RECORD.maxPlaintextBytes + 1)
        )
      )
    ).toBe('limit-exceeded');
  });
});
