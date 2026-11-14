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
import { api } from './api';
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

    await api.updateSettings({ settings: full, expectedRevision: 1 });
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
