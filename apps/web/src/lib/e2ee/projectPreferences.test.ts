import { describe, expect, it } from 'vitest';
import {
  encodeProjectPreferences,
  macProjectPreferences,
  toBase64Url
} from '@openzcad/crypto';
import {
  loadProjectPreference,
  type PreferencePinStore,
  type ProjectPreferenceApi
} from './projectPreferences';

const USER = 'user_1';

async function stored(accountKey: Uint8Array, sequence: number, encrypt: boolean) {
  const record = encodeProjectPreferences({
    userId: USER,
    encryptNewProjects: encrypt,
    sequence
  });
  return {
    record: toBase64Url(record),
    recordMac: toBase64Url(await macProjectPreferences(accountKey, record)),
    encryptNewProjects: encrypt,
    sequence,
    updatedAt: '2026-10-25T00:00:00.000Z'
  };
}

describe('a preference record older than another tab’s pin (#869 review)', () => {
  it('is a rollback even when the pin moved after it was read', async () => {
    const accountKey = crypto.getRandomValues(new Uint8Array(32));
    const preference = await stored(accountKey, 3, false);
    const api = {
      load: async () => ({ preference })
    } as unknown as ProjectPreferenceApi;
    // This tab reads pin 2; another tab pins sequence 5 (opted in) before
    // this one's write lands.
    let pinned = 2;
    const pins: PreferencePinStore = {
      read: async () => pinned,
      write: async (_, sequence) => {
        pinned = Math.max(pinned, 5, sequence);
      },
      optedIn: async () => true
    };
    const state = await loadProjectPreference({
      userId: USER,
      accountKey,
      api,
      pins
    });
    expect(state).toMatchObject({
      kind: 'refused',
      reason: 'rollback',
      floor: 5
    });
  });

  it('verifies a record that is still the newest after its pin', async () => {
    const accountKey = crypto.getRandomValues(new Uint8Array(32));
    const preference = await stored(accountKey, 3, true);
    let pinned: number | null = 2;
    const state = await loadProjectPreference({
      userId: USER,
      accountKey,
      api: {
        load: async () => ({ preference })
      } as unknown as ProjectPreferenceApi,
      pins: {
        read: async () => pinned,
        write: async (_, sequence) => {
          pinned = Math.max(pinned ?? 0, sequence);
        },
        optedIn: async () => true
      }
    });
    expect(state).toEqual({
      kind: 'verified',
      encryptNewProjects: true,
      sequence: 3
    });
  });
});
