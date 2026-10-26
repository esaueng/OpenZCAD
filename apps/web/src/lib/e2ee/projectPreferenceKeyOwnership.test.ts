import { afterEach, expect, it, vi } from 'vitest';
import {
  encodeProjectPreferences,
  fromBase64Url,
  macProjectPreferences,
  openProjectPreferences,
  toBase64Url
} from '@openzcad/crypto';
import type {
  E2eeProjectPreferenceRecord,
  E2eeSaveProjectPreferenceRequest
} from '@openzcad/shared';
import {
  loadProjectPreference,
  saveProjectPreference,
  memoryPreferencePins,
  type ProjectPreferenceContext
} from './projectPreferences';
import {
  lockAccount,
  rememberUnlockedAccount,
  unlockedAccount
} from './unlockedKeys';

const USER = 'preference-owner',
  KEY = new Uint8Array(32).fill(9);
function replace() {
  rememberUnlockedAccount(USER, {
    generation: 1,
    commitment: 'test',
    accountKey: KEY.slice(),
    encryptionPrivateKey: {} as CryptoKey
  });
}
afterEach(() => {
  lockAccount(USER);
  vi.restoreAllMocks();
});

async function record(key = KEY): Promise<E2eeProjectPreferenceRecord> {
  const encoded = encodeProjectPreferences({
    userId: USER,
    sequence: 3,
    encryptNewProjects: false
  });
  return {
    sequence: 3,
    encryptNewProjects: false,
    record: toBase64Url(encoded),
    recordMac: toBase64Url(await macProjectPreferences(key, encoded)),
    updatedAt: 'now'
  };
}
function context(preference: E2eeProjectPreferenceRecord | null) {
  replace();
  const ctx: ProjectPreferenceContext = {
    userId: USER,
    accountKey: unlockedAccount(USER)!.accountKey,
    pins: memoryPreferencePins(),
    api: {
      config: async () => ({ enabled: true, projectsEnabled: true }),
      load: async () => ({ preference }),
      save: async () => {
        throw new Error('not used');
      }
    }
  };
  return ctx;
}

it.each(['authentic', 'zero-key-forgery'] as const)(
  'holds an owned key across preference loading: %s',
  async (kind) => {
    const stored = await record(
      kind === 'authentic' ? KEY : new Uint8Array(32)
    );
    const ctx = context(stored);
    ctx.api.load = async () => {
      replace();
      return { preference: stored };
    };
    const result = await loadProjectPreference(ctx);
    expect(result.kind).toBe(kind === 'authentic' ? 'verified' : 'refused');
    expect(await ctx.pins.read(USER)).toBe(kind === 'authentic' ? 3 : null);
    expect([...unlockedAccount(USER)!.accountKey]).toEqual([...KEY]);
  }
);

it.each(['pin-read', 'save-response'] as const)(
  'owns the signing and verification key across %s replacement',
  async (phase) => {
    const ctx = context(null);
    const read = ctx.pins.read.bind(ctx.pins);
    let replaced = false;
    ctx.pins.read = async (user) => {
      if (phase === 'pin-read' && !replaced) {
        replaced = true;
        replace();
      }
      return read(user);
    };
    ctx.api.save = async (request: E2eeSaveProjectPreferenceRequest) => {
      const opened = await openProjectPreferences(
        KEY,
        fromBase64Url(request.record),
        fromBase64Url(request.recordMac)
      );
      expect(opened.encryptNewProjects).toBe(true);
      if (phase === 'save-response') replace();
      return {
        preference: {
          ...request,
          sequence: opened.sequence,
          encryptNewProjects: true,
          updatedAt: 'now'
        }
      };
    };
    await expect(saveProjectPreference(ctx, true, 0)).resolves.toMatchObject({
      kind: 'verified',
      encryptNewProjects: true
    });
    expect(await ctx.pins.optedIn(USER)).toBe(true);
    expect([...unlockedAccount(USER)!.accountKey]).toEqual([...KEY]);
  }
);

it.each(['success', 'refusal', 'failure'] as const)(
  'zeroes its private operation copy after %s',
  async (outcome) => {
    const ctx = context(
      await record(outcome === 'refusal' ? new Uint8Array(32) : KEY)
    );
    let owned!: Uint8Array<ArrayBuffer>;
    const borrowed = ctx.accountKey;
    vi.spyOn(borrowed, 'slice').mockImplementation(() => {
      owned = new Uint8Array(borrowed);
      return owned;
    });
    if (outcome === 'failure')
      ctx.api.load = async () => {
        throw new Error('Offline');
      };
    if (outcome === 'failure')
      await expect(loadProjectPreference(ctx)).rejects.toThrow('Offline');
    else await loadProjectPreference(ctx);
    expect([...owned]).toEqual(new Array(32).fill(0));
    expect([...borrowed]).toEqual([...KEY]);
  }
);
