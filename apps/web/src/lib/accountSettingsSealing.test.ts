import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountServerSettings,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppSettingsResponse
} from '@openzcad/shared';
import { api } from './api';
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
