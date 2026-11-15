import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountServerSettings,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppSettingsResponse
} from '@openzcad/shared';
import {
  ACCOUNT_SETTINGS_RECORD,
  fromBase64Url,
  readSealedRecordHeader
} from '@openzcad/crypto';
import { accountSettingsAdopted, api } from './api';
import { subscribeAccountSettingsMerged } from './accountSettingsEvents';
import { openSettings, sealSettings } from './e2ee/sealedSettings';
import { saveLocalAppSettings } from './appSettings';
import { desktopFetch } from './desktopBridge';

/**
 * ADR-024 amendment 2026-11-14: an account whose library is encrypted sends
 * only what the Worker acts on readable, and the rest sealed under its
 * account key, which this page opens again.
 */
vi.mock('./desktopBridge', () => ({
  desktopFetch: vi.fn(),
  isDesktopApp: () => false
}));

const { state, preferences } = vi.hoisted(() => ({
  state: {
    /** A fresh account per test: per-visit caches never carry over. */
    userId: 'user_0',
    optedIn: false,
    libraryEncrypted: false,
    account: undefined as { accountKey: Uint8Array } | undefined
  },
  preferences: {
    loadProjectPreference: vi.fn(),
    createProjectPreferenceApi: vi.fn(() => ({}))
  }
}));
vi.mock('./e2ee/preferencePins', () => ({
  localStoragePreferencePins: () => ({
    read: async () => null,
    write: async () => undefined,
    optedIn: async () => state.optedIn
  })
}));
vi.mock('./e2ee/unlockedKeys', () => ({
  unlockedAccount: () => state.account
}));
vi.mock('./e2ee/projectPreferences', () => preferences);

// The account-key history: older keys this device can reach, by commitment.
const history = vi.hoisted(() => ({
  older: [] as { commitment: Uint8Array; key: Uint8Array }[]
}));
vi.mock('./e2ee/accountKeys', () => ({
  loadEncryption: async () => ({
    kind: 'ready',
    account: {
      unlocked: true,
      list: {
        entries: history.older.map(({ commitment }, sequence) => ({
          entry: { sequence, accountKeyCommitment: commitment }
        }))
      }
    }
  }),
  openAccountKeyChain: async (
    _ctx: unknown,
    _account: unknown,
    sequence: number
  ) => new Uint8Array(history.older[sequence]!.key)
}));
vi.mock('./e2ee/keychainDeviceKeys', () => ({ deviceKeyStore: () => ({}) }));

const ACCOUNT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const SECRET = 'Prefer 0.4 mm sliding clearances.';

function privateSettings(): AppSettings {
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.appearance.theme = 'light';
  settings.general.defaultUnits = 'inch';
  settings.assistant.customInstructions = SECRET;
  settings.assistant.model = 'owner-model';
  return settings;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });

const response = (
  settings: AppSettings,
  extra: Partial<AppSettingsResponse> = {}
): AppSettingsResponse => ({
  settings,
  revision: 1,
  synced: true,
  credential: { stored: false, storageAvailable: true },
  effectiveAssistant: {
    configured: false,
    source: 'deployment',
    provider: 'openrouter',
    model: 'm',
    reasoningEffort: 'high'
  },
  ...extra
});

/** The Worker: account, e2ee config, preference and the settings route. */
function worker(stored: () => AppSettingsResponse) {
  const patches: Record<string, unknown>[] = [];
  vi.mocked(desktopFetch).mockImplementation(async (input, init) => {
    if (input === '/api/session') return json({ userId: state.userId });
    if (input === '/api/e2ee/config') {
      return json({ enabled: true, projectsEnabled: true });
    }
    if (input === '/api/e2ee/project-preferences') {
      return json({
        preference: { encryptNewProjects: state.optedIn },
        libraryEncrypted: state.libraryEncrypted
      });
    }
    if (input === '/api/settings' && init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      patches.push(body);
      return json(
        response(body.settings as AppSettings, {
          revision: 2,
          ...(typeof body.sealedSettings === 'string'
            ? { sealedSettings: body.sealedSettings }
            : {})
        })
      );
    }
    if (input === '/api/settings') return json(stored());
    return json({}, 404);
  });
  return patches;
}

let accounts = 0;
beforeEach(() => {
  accounts += 1;
  state.userId = `user_${accounts}`;
  localStorage.clear();
  preferences.loadProjectPreference.mockImplementation(async () => ({
    kind: 'verified',
    encryptNewProjects: state.optedIn
  }));
});

afterEach(() => {
  history.older = [];
  vi.clearAllMocks();
  state.optedIn = false;
  state.libraryEncrypted = false;
  state.account = undefined;
});

describe('settings of an account whose library is encrypted', () => {
  it('sends only the server part readable and opens the sealed rest', async () => {
    state.libraryEncrypted = true;
    state.account = { accountKey: ACCOUNT_KEY };
    const full = privateSettings();
    const patches = worker(() => response(DEFAULT_APP_SETTINGS));

    const saved = await api.updateSettings({
      settings: full,
      expectedRevision: 1
    });
    expect(patches).toHaveLength(1);
    const [sent] = patches;
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(sent!.settings).toEqual(accountServerSettings(full));
    expect(typeof sent!.sealedSettings).toBe('string');
    expect(saved.settings).toEqual(full);

    // Another read opens the record this page sealed.
    worker(() =>
      response(accountServerSettings(full), {
        sealedSettings: sent!.sealedSettings as string
      })
    );
    const read = await api.getSettings();
    expect(read.settings.assistant.customInstructions).toBe(SECRET);
    expect(read.settings.appearance.theme).toBe('light');
  });

  it('keeps the account’s sharing switch and route over a sealed copy', async () => {
    state.libraryEncrypted = true;
    state.account = { accountKey: ACCOUNT_KEY };
    const full = privateSettings();
    const patches = worker(() => response(DEFAULT_APP_SETTINGS));
    await api.updateSettings({ settings: full, expectedRevision: 1 });
    const server = accountServerSettings(full);
    server.collaboration.enabled = false;
    server.assistant.model = 'changed-elsewhere';
    worker(() =>
      response(server, {
        sealedSettings: patches[0]!.sealedSettings as string
      })
    );
    const read = await api.getSettings();
    expect(read.settings.collaboration.enabled).toBe(false);
    expect(read.settings.assistant.model).toBe('changed-elsewhere');
    expect(read.settings.assistant.customInstructions).toBe(SECRET);
  });

  it('with locked keys sends the server part alone and keeps device values', async () => {
    state.optedIn = true;
    const full = privateSettings();
    saveLocalAppSettings(full, 1);
    const patches = worker(() =>
      response(accountServerSettings(DEFAULT_APP_SETTINGS), {
        sealedSettings: 'AQ'
      })
    );
    const read = await api.getSettings();
    // The record cannot be opened here: this device's own values stand.
    expect(read.settings.appearance.theme).toBe('light');
    expect(read.settings.assistant.customInstructions).toBe(SECRET);

    // The readable part saves; the save says the rest stayed here.
    await expect(
      api.updateSettings({ settings: full, expectedRevision: 1 })
    ).rejects.toMatchObject({ code: 'SETTINGS_SEAL_DEFERRED' });
    expect(patches).toHaveLength(1);
    expect(patches[0]).not.toHaveProperty('sealedSettings');
    expect(JSON.stringify(patches[0])).not.toContain(SECRET);
  });

  it('refuses a rolled-back record and keeps device values', async () => {
    state.libraryEncrypted = true;
    state.account = { accountKey: ACCOUNT_KEY };
    const older = privateSettings();
    older.appearance.theme = 'dark';
    const patches = worker(() => response(DEFAULT_APP_SETTINGS));
    await api.updateSettings({ settings: older, expectedRevision: 1 });
    await api.updateSettings({
      settings: privateSettings(),
      expectedRevision: 2
    });
    saveLocalAppSettings(privateSettings(), 2);
    // The server answers with the first, older record.
    worker(() =>
      response(accountServerSettings(older), {
        sealedSettings: patches[0]!.sealedSettings as string
      })
    );
    const read = await api.getSettings();
    expect(read.settings.appearance.theme).toBe('light');
  });

  it('seals readable settings left from before the account encrypted', async () => {
    state.libraryEncrypted = true;
    state.account = { accountKey: ACCOUNT_KEY };
    const patches = worker(() => response(privateSettings()));
    const read = await api.getSettings();
    expect(patches).toHaveLength(1);
    expect(JSON.stringify(patches[0])).not.toContain(SECRET);
    expect(typeof patches[0]!.sealedSettings).toBe('string');
    expect(read.settings.assistant.customInstructions).toBe(SECRET);
  });

  it('merges a save after unlocking onto the record it read locked', async () => {
    // Another device sealed the account's settings at sequence 5.
    const account = privateSettings();
    const { record } = await sealSettings(
      {
        accountKey: ACCOUNT_KEY,
        userId: state.userId,
        pins: { read: () => 4, write: () => undefined }
      },
      account
    );
    state.libraryEncrypted = true;
    // A fresh device, keys locked: it shows its own defaults.
    const patches = worker(() =>
      response(accountServerSettings(account), { sealedSettings: record })
    );
    const read = await api.getSettings();
    expect(read.settings.assistant.customInstructions).toBe('');
    const merges: AppSettings[] = [];
    const stop = subscribeAccountSettingsMerged((_, __, saved) =>
      merges.push(saved)
    );
    try {
      // Unlocked, the user changes one setting.
      state.account = { accountKey: ACCOUNT_KEY };
      const edited = structuredClone(read.settings);
      edited.general.defaultUnits = 'cm';
      const saved = await api.updateSettings({
        settings: edited,
        expectedRevision: 1
      });
      // The account keeps everything the device did not touch.
      expect(saved.settings.assistant.customInstructions).toBe(SECRET);
      expect(saved.settings.appearance.theme).toBe('light');
      expect(saved.settings.general.defaultUnits).toBe('cm');
      expect(merges).toHaveLength(1);
      expect(merges[0]!.assistant.customInstructions).toBe(SECRET);
      // Sealed above the record it replaced, though this device never
      // pinned it: other devices never see a lower or repeated sequence.
      const sealed = patches[0]!.sealedSettings as string;
      expect(
        readSealedRecordHeader(ACCOUNT_SETTINGS_RECORD, fromBase64Url(sealed))
          .sequence
      ).toBe(6);
      // Once merged, the next save is an ordinary one.
      await api.updateSettings({
        settings: saved.settings,
        expectedRevision: 2
      });
      expect(merges).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('merges an edit queued behind the first save after unlocking', async () => {
    const account = privateSettings();
    const { record } = await sealSettings(
      {
        accountKey: ACCOUNT_KEY,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      account
    );
    state.libraryEncrypted = true;
    const patches = worker(() =>
      response(accountServerSettings(account), { sealedSettings: record })
    );
    const read = await api.getSettings();
    state.account = { accountKey: ACCOUNT_KEY };
    const first = structuredClone(read.settings);
    first.general.defaultUnits = 'cm';
    // The second edit was queued from the page's unmerged settings.
    const second = structuredClone(first);
    second.appearance.density = 'compact';
    await api.updateSettings({ settings: first, expectedRevision: 1 });
    await api.updateSettings({ settings: second, expectedRevision: 2 });
    const stored = await openSettings(
      {
        accountKey: ACCOUNT_KEY,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      patches[1]!.sealedSettings as string
    );
    expect(stored?.assistant.customInstructions).toBe(SECRET);
    expect(stored?.appearance.theme).toBe('light');
    expect(stored?.general.defaultUnits).toBe('cm');
    expect(stored?.appearance.density).toBe('compact');
  });

  it('keeps the merge across a reload before the edit synced', async () => {
    const account = privateSettings();
    const { record } = await sealSettings(
      {
        accountKey: ACCOUNT_KEY,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      account
    );
    state.libraryEncrypted = true;
    worker(() =>
      response(accountServerSettings(account), { sealedSettings: record })
    );
    // Locked: the page shows this device's defaults; the user edits one.
    const read = await api.getSettings();
    const edited = structuredClone(read.settings);
    edited.general.defaultUnits = 'cm';
    saveLocalAppSettings(edited, null);
    // Reload, keys unlocked this time.
    vi.resetModules();
    const reloaded = await import('./api');
    state.account = { accountKey: ACCOUNT_KEY };
    const patches = worker(() =>
      response(accountServerSettings(account), { sealedSettings: record })
    );
    const again = await reloaded.api.getSettings();
    expect(again.settings.assistant.customInstructions).toBe(SECRET);
    expect(again.settings.general.defaultUnits).toBe('cm');
    // Startup keeps the unsynced device copy and saves it.
    await reloaded.api.updateSettings({
      settings: edited,
      expectedRevision: 1
    });
    const { openSettings: openAfterReload } =
      await import('./e2ee/sealedSettings');
    const stored = await openAfterReload(
      {
        accountKey: ACCOUNT_KEY,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      patches[0]!.sealedSettings as string
    );
    expect(stored?.assistant.customInstructions).toBe(SECRET);
    expect(stored?.appearance.theme).toBe('light');
    expect(stored?.general.defaultUnits).toBe('cm');
  });

  it('never merges another account’s device copy into this account', async () => {
    const accountA = privateSettings();
    const { record } = await sealSettings(
      {
        accountKey: ACCOUNT_KEY,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      accountA
    );
    state.libraryEncrypted = true;
    const userA = state.userId;
    // A reads while locked: its merge state remembers the defaults shown.
    worker(() =>
      response(accountServerSettings(accountA), { sealedSettings: record })
    );
    await api.getSettings();
    // B signs in on this device; its settings become the device copy.
    state.userId = `${userA}_b`;
    const settingsB = structuredClone(DEFAULT_APP_SETTINGS);
    settingsB.assistant.customInstructions = 'B’s own instructions.';
    saveLocalAppSettings(settingsB, 1);
    worker(() => response(settingsB));
    await api.getSettings();
    // A again, unlocked, after a reload.
    vi.resetModules();
    const reloaded = await import('./api');
    state.userId = userA;
    state.account = { accountKey: ACCOUNT_KEY };
    worker(() =>
      response(accountServerSettings(accountA), { sealedSettings: record })
    );
    const read = await reloaded.api.getSettings();
    expect(read.settings.assistant.customInstructions).toBe(SECRET);
  });

  it('keeps a record it cannot open rather than sealing defaults over it', async () => {
    // Sealed under an account key this device does not hold (a rotation).
    const otherKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const { record } = await sealSettings(
      {
        accountKey: otherKey,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      privateSettings()
    );
    state.libraryEncrypted = true;
    const patches = worker(() =>
      response(accountServerSettings(privateSettings()), {
        sealedSettings: record
      })
    );
    const read = await api.getSettings();
    state.account = { accountKey: ACCOUNT_KEY };
    const edited = structuredClone(read.settings);
    edited.general.defaultUnits = 'cm';
    // The mock account stays at revision 1: the readable part saves, and
    // the next save names the revision the account still reports.
    for (const expectedRevision of [1, 1])
      await expect(
        api.updateSettings({ settings: edited, expectedRevision })
      ).rejects.toMatchObject({ code: 'SETTINGS_SEAL_DEFERRED' });
    // The readable part saves; the record the account holds is left alone,
    // every time, until a device can merge onto it.
    expect(patches).toHaveLength(2);
    for (const sent of patches)
      expect(sent).not.toHaveProperty('sealedSettings');
  });

  it('keeps a record it cannot open even when it first read it unlocked', async () => {
    const otherKey = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
    const { record } = await sealSettings(
      {
        accountKey: otherKey,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      privateSettings()
    );
    state.libraryEncrypted = true;
    state.account = { accountKey: ACCOUNT_KEY };
    const patches = worker(() =>
      response(accountServerSettings(privateSettings()), {
        sealedSettings: record
      })
    );
    const read = await api.getSettings();
    await expect(
      api.updateSettings({ settings: read.settings, expectedRevision: 1 })
    ).rejects.toMatchObject({ code: 'SETTINGS_SEAL_DEFERRED' });
    expect(patches[0]).not.toHaveProperty('sealedSettings');
  });

  it('never seals an older merge target over a newer record it cannot open', async () => {
    const keys = (accountKey: Uint8Array) => ({
      accountKey,
      userId: state.userId,
      pins: { read: () => 0, write: () => undefined }
    });
    const first = await sealSettings(keys(ACCOUNT_KEY), privateSettings());
    state.libraryEncrypted = true;
    let current = first.record;
    const patches = worker(() =>
      response(accountServerSettings(privateSettings()), {
        sealedSettings: current
      })
    );
    await api.getSettings(); // locked: a merge base
    state.account = { accountKey: ACCOUNT_KEY };
    await api.getSettings(); // unlocked: the account's settings, opened
    // Another device rotates the account key and replaces the record.
    const rotated = Uint8Array.from({ length: 32 }, (_, index) => 100 + index);
    current = (
      await sealSettings(
        { ...keys(rotated), pins: { read: () => 7, write: () => undefined } },
        privateSettings()
      )
    ).record;
    // A conflict refresh reads the replacement, which it cannot open.
    const refreshed = await api.getSettings();
    await expect(
      api.updateSettings({
        settings: refreshed.settings,
        expectedRevision: refreshed.revision
      })
    ).rejects.toMatchObject({ code: 'SETTINGS_SEAL_DEFERRED' });
    expect(patches.at(-1)).not.toHaveProperty('sealedSettings');
  });

  it('opens a record sealed before a rotation and reseals it under the current key', async () => {
    const { accountKeyCommitment } = await import('@openzcad/crypto');
    const formerKey = Uint8Array.from({ length: 32 }, (_, index) => 50 + index);
    history.older = [
      { commitment: await accountKeyCommitment(formerKey), key: formerKey }
    ];
    const { record } = await sealSettings(
      {
        accountKey: formerKey,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      privateSettings()
    );
    state.libraryEncrypted = true;
    state.account = { accountKey: ACCOUNT_KEY };
    const patches = worker(() =>
      response(accountServerSettings(privateSettings()), {
        sealedSettings: record
      })
    );
    const read = await api.getSettings();
    expect(read.settings.assistant.customInstructions).toBe(SECRET);
    const edited = structuredClone(read.settings);
    edited.general.defaultUnits = 'cm';
    await api.updateSettings({ settings: edited, expectedRevision: 1 });
    const stored = await openSettings(
      {
        accountKey: ACCOUNT_KEY,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      patches[0]!.sealedSettings as string
    );
    expect(stored?.assistant.customInstructions).toBe(SECRET);
    expect(stored?.general.defaultUnits).toBe('cm');
  });

  it('reads the account again before saving at a revision it did not open', async () => {
    const keys = (accountKey: Uint8Array, pin = 0) => ({
      accountKey,
      userId: state.userId,
      pins: { read: () => pin, write: () => undefined }
    });
    state.libraryEncrypted = true;
    state.account = { accountKey: ACCOUNT_KEY };
    let current = (await sealSettings(keys(ACCOUNT_KEY), privateSettings()))
      .record;
    let revision = 1;
    const patches = worker(() =>
      response(accountServerSettings(privateSettings()), {
        revision,
        sealedSettings: current
      })
    );
    const read = await api.getSettings();
    // Another device replaces the record under a rotated key, and this page
    // learns the new revision from another response (a credential change).
    const rotated = Uint8Array.from({ length: 32 }, (_, index) => 30 + index);
    current = (await sealSettings(keys(rotated, 4), privateSettings())).record;
    revision = 2;
    await expect(
      api.updateSettings({ settings: read.settings, expectedRevision: 2 })
    ).rejects.toMatchObject({ code: 'SETTINGS_SEAL_DEFERRED' });
    expect(patches).toHaveLength(1);
    expect(patches[0]).not.toHaveProperty('sealedSettings');
  });

  it('ends the merge once the page adopts an account copy it opened', async () => {
    const keys = (pin = 0) => ({
      accountKey: ACCOUNT_KEY,
      userId: state.userId,
      pins: { read: () => pin, write: () => undefined }
    });
    state.libraryEncrypted = true;
    const account = privateSettings();
    account.general.defaultUnits = 'cm';
    let current = (await sealSettings(keys(), account)).record;
    let revision = 1;
    worker(() =>
      response(accountServerSettings(account), {
        revision,
        sealedSettings: current
      })
    );
    await api.getSettings(); // locked: this device shows its own
    state.account = { accountKey: ACCOUNT_KEY };
    const opened = await api.getSettings();
    expect(opened.settings.general.defaultUnits).toBe('cm');
    // The page adopts that copy.
    saveLocalAppSettings(opened.settings, opened.revision);
    accountSettingsAdopted(state.userId, opened);
    // Another device changes the units again.
    const later = structuredClone(account);
    later.general.defaultUnits = 'mm';
    current = (await sealSettings(keys(5), later)).record;
    revision = 2;
    const again = await api.getSettings();
    // The adopted 'cm' is the account's value, not an edit of this device's.
    expect(again.settings.general.defaultUnits).toBe('mm');
  });

  it('refuses to seal when the refresh before a save cannot confirm the revision', async () => {
    state.libraryEncrypted = true;
    state.account = { accountKey: ACCOUNT_KEY };
    const { record } = await sealSettings(
      {
        accountKey: ACCOUNT_KEY,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      privateSettings()
    );
    let sessionDown = false;
    const patches: Record<string, unknown>[] = [];
    vi.mocked(desktopFetch).mockImplementation(async (input, init) => {
      if (input === '/api/session')
        return sessionDown
          ? json({ error: 'down' }, 503)
          : json({ userId: state.userId });
      if (input === '/api/e2ee/config') {
        return json({ enabled: true, projectsEnabled: true });
      }
      if (input === '/api/e2ee/project-preferences') {
        return json({ preference: null, libraryEncrypted: true });
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        patches.push(
          JSON.parse(init.body as string) as Record<string, unknown>
        );
        return json(response(DEFAULT_APP_SETTINGS, { revision: 3 }));
      }
      if (input === '/api/settings')
        return json(
          response(accountServerSettings(privateSettings()), {
            revision: sessionDown ? 2 : 1,
            sealedSettings: record
          })
        );
      return json({}, 404);
    });
    const read = await api.getSettings(); // opened at revision 1
    // Revision 2 arrives from elsewhere; the refresh's session lookup fails.
    sessionDown = true;
    await expect(
      api.updateSettings({ settings: read.settings, expectedRevision: 2 })
    ).rejects.toBeTruthy();
    expect(patches.filter((patch) => 'sealedSettings' in patch)).toEqual([]);
  });

  it('wipes an older account key on every way out, a rollback included', async () => {
    const formerKey = Uint8Array.from({ length: 32 }, (_, index) => 9 + index);
    const { record } = await sealSettings(
      {
        accountKey: formerKey,
        userId: state.userId,
        pins: { read: () => 0, write: () => undefined }
      },
      privateSettings()
    );
    const handedOut = new Uint8Array(formerKey);
    const opened = await openSettings(
      {
        accountKey: ACCOUNT_KEY,
        userId: state.userId,
        // This device already opened a newer record.
        pins: { read: () => 9, write: () => undefined },
        olderKey: async () => handedOut
      },
      record
    );
    expect(opened).toBeNull();
    expect(handedOut.every((byte) => byte === 0)).toBe(true);
  });

  it('refuses to save rather than guess when the library rule cannot be read', async () => {
    vi.mocked(desktopFetch).mockImplementation(async (input) => {
      if (input === '/api/session') return json({ userId: state.userId });
      if (input === '/api/e2ee/config') {
        return json({ enabled: true, projectsEnabled: true });
      }
      return json({ error: 'down' }, 503);
    });
    await expect(
      api.updateSettings({ settings: privateSettings(), expectedRevision: 1 })
    ).rejects.toMatchObject({ code: 'E2EE_PREFERENCE_UNVERIFIED' });
    expect(
      vi
        .mocked(desktopFetch)
        .mock.calls.some(
          ([path, init]) => path === '/api/settings' && init?.method === 'PATCH'
        )
    ).toBe(false);
  });
});

describe('settings of a readable account', () => {
  it('saves and reads everything as before', async () => {
    const full = privateSettings();
    const patches = worker(() => response(full));
    await api.updateSettings({ settings: full, expectedRevision: 1 });
    expect(patches[0]).toEqual({ settings: full, expectedRevision: 1 });
    const read = await api.getSettings();
    expect(read.settings).toEqual(full);
    expect(patches).toHaveLength(1);
  });

  it('moves to sealing when the Worker says the account now encrypts', async () => {
    state.account = { accountKey: ACCOUNT_KEY };
    const full = privateSettings();
    let refused = false;
    const patches: Record<string, unknown>[] = [];
    vi.mocked(desktopFetch).mockImplementation(async (input, init) => {
      if (input === '/api/session') return json({ userId: state.userId });
      if (input === '/api/e2ee/config') {
        return json({ enabled: true, projectsEnabled: true });
      }
      if (input === '/api/e2ee/project-preferences') {
        return json({ preference: null, libraryEncrypted: false });
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        patches.push(body);
        if (!refused) {
          refused = true;
          return json(
            { error: 'sealed only', code: 'SETTINGS_ENCRYPTION_REQUIRED' },
            409
          );
        }
        return json(response(body.settings as AppSettings));
      }
      if (input === '/api/settings')
        return json(response(DEFAULT_APP_SETTINGS));
      return json({}, 404);
    });
    preferences.loadProjectPreference.mockImplementation(async () => ({
      kind: 'unset'
    }));
    await api.updateSettings({ settings: full, expectedRevision: 1 });
    expect(patches).toHaveLength(2);
    expect(JSON.stringify(patches[1])).not.toContain(SECRET);
    expect(typeof patches[1]!.sealedSettings).toBe('string');
  });
});
