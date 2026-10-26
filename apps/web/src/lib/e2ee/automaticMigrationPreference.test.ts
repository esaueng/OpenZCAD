import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { rememberUnlockedAccount, lockAccount } from './unlockedKeys';
import { localStoragePreferencePins } from './preferencePins';
import { automaticProjectMigration } from './automaticMigration';

const KEY = new Uint8Array(32).fill(8);
const fakes = vi.hoisted(() => ({
  load: vi.fn(),
  run: vi.fn(),
  refresh: vi.fn(),
  fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  state: {
    running: false,
    error: null,
    projects: [{ projectId: 'plain', phase: 'waiting' }]
  }
}));
vi.mock('../desktopBridge', () => ({ desktopFetch: fakes.fetch }));
vi.mock('./accountKeys', () => ({ loadEncryption: fakes.load }));
vi.mock('./keychainDeviceKeys', () => ({ deviceKeyStore: () => ({}) }));
vi.mock('./projectMigrations', () => ({
  pageMigrationController: () => ({
    getState: () => fakes.state,
    refresh: fakes.refresh,
    run: fakes.run
  })
}));

let stored: E2eeProjectPreferenceRecord | null;
let writes: number;
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  stored = null;
  writes = 0;
  rememberUnlockedAccount('account', {
    generation: 1,
    commitment: 'test',
    accountKey: KEY.slice(),
    encryptionPrivateKey: {} as CryptoKey
  });
  fakes.load.mockResolvedValue({
    kind: 'ready',
    account: { unlocked: true, deviceStatus: 'certified' }
  });
  fakes.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/e2ee/config')
      return Response.json({
        enabled: true,
        projectsEnabled: true,
        migrationEnabled: true,
        defaultOn: true
      });
    if (path !== '/api/e2ee/project-preferences')
      throw new Error('unexpected request');
    if (init?.method === 'PUT') {
      const request = JSON.parse(
        init.body as string
      ) as E2eeSaveProjectPreferenceRequest;
      const opened = await openProjectPreferences(
        KEY,
        fromBase64Url(request.record),
        fromBase64Url(request.recordMac)
      );
      expect(opened.userId).toBe('account');
      expect(opened.encryptNewProjects).toBe(true);
      stored = {
        ...request,
        sequence: opened.sequence,
        encryptNewProjects: true,
        updatedAt: 'now'
      };
      writes++;
    }
    return Response.json({ preference: stored });
  });
  fakes.run.mockImplementation(async () => {
    expect(stored?.encryptNewProjects).toBe(true);
    expect(await localStoragePreferencePins().optedIn('account')).toBe(true);
  });
});
afterEach(() => lockAccount('account'));

async function record(sequence: number, enabled: boolean, key = KEY) {
  const bytes = encodeProjectPreferences({
    userId: 'account',
    encryptNewProjects: enabled,
    sequence
  });
  stored = {
    sequence,
    encryptNewProjects: enabled,
    record: toBase64Url(bytes),
    recordMac: toBase64Url(await macProjectPreferences(key, bytes)),
    updatedAt: 'now'
  };
}

describe('automatic migration preference prerequisite', () => {
  it.each(['unset', 'off'] as const)(
    'keeps its key across the full %s load-to-save prerequisite when the cache is replaced',
    async (kind) => {
      if (kind === 'off') await record(4, false);
      const fetch = fakes.fetch.getMockImplementation()!;
      fakes.fetch.mockImplementation(
        async (path: string, init?: RequestInit) => {
          const response = await fetch(path, init);
          if (
            path === '/api/e2ee/project-preferences' &&
            init?.method !== 'PUT'
          ) {
            rememberUnlockedAccount('account', {
              generation: 1,
              commitment: 'test',
              accountKey: KEY.slice(),
              encryptionPrivateKey: {} as CryptoKey
            });
          }
          return response;
        }
      );
      const attention = vi.fn();
      const migration = automaticProjectMigration('account', attention);
      await migration.check();
      expect(writes).toBe(1);
      expect(fakes.run).toHaveBeenCalledTimes(1);
      expect(stored?.encryptNewProjects).toBe(true);
      migration.dispose();
    }
  );

  it.each(['unset', 'off', 'on'] as const)(
    'verifies and pins encryption before migration from %s',
    async (kind) => {
      if (kind !== 'unset') await record(4, kind === 'on');
      const migration = automaticProjectMigration('account', vi.fn());
      await migration.check();
      expect(fakes.run).toHaveBeenCalledTimes(1);
      expect(writes).toBe(kind === 'on' ? 0 : 1);
      expect(stored?.sequence).toBe(
        kind === 'unset' ? 1 : kind === 'off' ? 5 : 4
      );
      migration.dispose();
    }
  );

  it('does not silently replace a forged preference or migrate past its warning', async () => {
    await record(7, false, new Uint8Array(32).fill(1));
    const attention = vi.fn();
    const migration = automaticProjectMigration('account', attention);
    await migration.check();
    expect(attention).toHaveBeenCalledWith(
      expect.stringMatching(/did not verify/)
    );
    expect(writes).toBe(0);
    expect(fakes.run).not.toHaveBeenCalled();
    migration.dispose();
  });

  it('requires setup/unlock and certification before reading the preference or migrating', async () => {
    for (const state of [
      { kind: 'not-set-up' },
      {
        kind: 'ready',
        account: { unlocked: false, deviceStatus: 'certified' }
      },
      {
        kind: 'ready',
        account: { unlocked: true, deviceStatus: 'uncertified' }
      }
    ]) {
      fakes.load.mockResolvedValue(state);
      const migration = automaticProjectMigration('account', vi.fn());
      await migration.check();
      migration.dispose();
    }
    expect(fakes.fetch).toHaveBeenCalledTimes(3);
    expect(fakes.run).not.toHaveBeenCalled();
    expect(writes).toBe(0);
  });
});
