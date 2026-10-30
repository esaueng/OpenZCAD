import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLOUD_AUTOSAVE_DELAY_BOUNDS,
  DEFAULT_APP_SETTINGS,
  deepClone,
  PANEL_WIDTH_LIMITS,
  VIEWPORT_FIELD_OF_VIEW_BOUNDS,
  XRAY_OPACITY_BOUNDS,
  toUserId
} from '@openzcad/shared';
import {
  APP_SETTINGS_STORAGE_KEY,
  defaultAppSettings,
  loadLocalAppSettings,
  loadLocalAppSettingsRecord,
  normalizeAppSettings,
  saveLocalAppSettings,
  shouldAdoptAccountSettings
} from '../apps/web/src/lib/appSettings';
import {
  decryptAssistantCredential,
  encryptAssistantCredential,
  isProjectSharingPreferenceEnabled,
  parseUpdateAppSettingsRequest,
  salvageStoredSettings,
  validateAssistantBaseUrl
} from '../apps/web/worker/settings';

/**
 * The device-settings helpers read `window.localStorage`, which the node test
 * environment does not provide. A map-backed stand-in exercises the real
 * serialization path without pulling in a DOM.
 */
function installLocalStorage(): void {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear()
  };
  (globalThis as Record<string, unknown>).window = { localStorage: storage };
}

beforeEach(installLocalStorage);
afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

function encryptionSecret(): string {
  let binary = '';
  for (let index = 0; index < 32; index += 1) {
    binary += String.fromCharCode(index + 1);
  }
  return btoa(binary);
}

describe('application settings', () => {
  it('normalizes corrupted local values without changing document semantics', () => {
    const normalized = normalizeAppSettings({
      general: { defaultUnits: 'furlong', reopenLastProject: false },
      appearance: { density: 'huge' },
      viewport: { showGrid: false, displayMode: 'xray' },
      sketching: { linearSnap: 0 },
      collaboration: { enabled: false },
      assistant: { model: '' }
    });

    expect(normalized.general.reopenLastProject).toBe(false);
    expect(normalized.general.defaultUnits).toBe('mm');
    expect(normalized.viewport.showGrid).toBe(false);
    expect(normalized.viewport.displayMode).toBe('shaded-edges');
    expect(normalized.sketching.linearSnap).toBe(1);
    expect(normalized.collaboration.enabled).toBe(false);
    expect(normalized.assistant.enabled).toBe(false);
    expect(normalized.assistant.model).toBe('openai/gpt-6-luna');
  });

  it('accepts the light theme on both layers and falls back on junk', () => {
    expect(
      normalizeAppSettings({ appearance: { theme: 'light' } }).appearance.theme
    ).toBe('light');
    expect(
      normalizeAppSettings({ appearance: { theme: 'sepia' } }).appearance.theme
    ).toBe('system');

    // The account boundary validates the theme independently of the client
    // normalizer; before 'light' existed there, saving it was rejected — a
    // cloud-autosave outage the client alone could not have caught.
    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.appearance.theme = 'light';
    const parsed = parseUpdateAppSettingsRequest(
      { expectedRevision: 0, settings },
      'development'
    );
    expect(parsed.settings.appearance.theme).toBe('light');
  });

  it('keeps the library card size on both layers, small by default', () => {
    expect(DEFAULT_APP_SETTINGS.appearance.libraryCardSize).toBe('small');
    expect(
      normalizeAppSettings({ appearance: { libraryCardSize: 'large' } })
        .appearance.libraryCardSize
    ).toBe('large');
    expect(
      normalizeAppSettings({ appearance: { libraryCardSize: 'huge' } })
        .appearance.libraryCardSize
    ).toBe('small');

    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.appearance.libraryCardSize = 'medium';
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 0, settings },
        'development'
      ).settings.appearance.libraryCardSize
    ).toBe('medium');
    // A client from before the setting still saves; it reads as small.
    const older = deepClone(DEFAULT_APP_SETTINGS) as unknown as {
      appearance: Record<string, unknown>;
    };
    delete older.appearance.libraryCardSize;
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 0, settings: older },
        'development'
      ).settings.appearance.libraryCardSize
    ).toBe('small');
  });

  it('returns independent default objects', () => {
    const first = defaultAppSettings();
    const second = defaultAppSettings();
    first.general.defaultUnits = 'inch';
    expect(second.general.defaultUnits).toBe('mm');
  });

  it('keeps sketch display, geometry snapping, and grid snapping independent', () => {
    const normalized = normalizeAppSettings({
      sketching: {
        gridVisible: false,
        snapEnabled: true,
        geometrySnapEnabled: false,
        inferenceEnabled: false,
        snapTolerancePx: 18
      }
    });
    expect(normalized.sketching).toMatchObject({
      gridVisible: false,
      snapEnabled: true,
      geometrySnapEnabled: false,
      inferenceEnabled: false,
      snapTolerancePx: 18
    });
  });

  it('accepts account settings written before the richer sketch preferences', () => {
    const settings = deepClone(DEFAULT_APP_SETTINGS) as unknown as {
      sketching: Record<string, unknown>;
    };
    delete settings.sketching.gridVisible;
    delete settings.sketching.geometrySnapEnabled;
    delete settings.sketching.inferenceEnabled;
    delete settings.sketching.snapTolerancePx;
    const parsed = parseUpdateAppSettingsRequest(
      { expectedRevision: 0, settings },
      'development'
    );
    expect(parsed.settings.sketching).toMatchObject({
      gridVisible: true,
      geometrySnapEnabled: true,
      inferenceEnabled: true,
      snapTolerancePx: 10
    });
  });

  it('keeps relation glyph visibility, defaulting what is absent or unknown', () => {
    expect(defaultAppSettings().sketching.relationGlyphs).toBe('selected');
    expect(
      normalizeAppSettings({ sketching: { relationGlyphs: 'always' } })
        .sketching.relationGlyphs
    ).toBe('always');
    expect(
      normalizeAppSettings({ sketching: { relationGlyphs: 'sometimes' } })
        .sketching.relationGlyphs
    ).toBe('selected');

    const older = deepClone(DEFAULT_APP_SETTINGS) as unknown as {
      sketching: Record<string, unknown>;
    };
    delete older.sketching.relationGlyphs;
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 0, settings: older },
        'development'
      ).settings.sketching.relationGlyphs
    ).toBe('selected');
    const hidden = deepClone(DEFAULT_APP_SETTINGS);
    hidden.sketching.relationGlyphs = 'hidden';
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 0, settings: hidden },
        'development'
      ).settings.sketching.relationGlyphs
    ).toBe('hidden');
  });

  it('keeps the per-kind glyph filter, dropping unknown kinds and absent fields', () => {
    expect(defaultAppSettings().sketching.hiddenRelationGlyphs).toEqual([]);
    // Unknown kinds (a newer client's) and duplicates drop out; the kinds come
    // back in filter order.
    expect(
      normalizeAppSettings({
        sketching: {
          hiddenRelationGlyphs: ['lock', 'spiral', 'horizontal', 'lock', 3]
        }
      }).sketching.hiddenRelationGlyphs
    ).toEqual(['horizontal', 'lock']);
    expect(
      normalizeAppSettings({ sketching: { hiddenRelationGlyphs: 'lock' } })
        .sketching.hiddenRelationGlyphs
    ).toEqual([]);

    const older = deepClone(DEFAULT_APP_SETTINGS) as unknown as {
      sketching: Record<string, unknown>;
    };
    delete older.sketching.hiddenRelationGlyphs;
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 0, settings: older },
        'development'
      ).settings.sketching.hiddenRelationGlyphs
    ).toEqual([]);
    const filtered = deepClone(DEFAULT_APP_SETTINGS) as unknown as {
      sketching: Record<string, unknown>;
    };
    filtered.sketching.hiddenRelationGlyphs = ['coincident', 'future-kind'];
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 0, settings: filtered },
        'development'
      ).settings.sketching.hiddenRelationGlyphs
    ).toEqual(['coincident']);
  });

  it('preserves Anthropic through account validation and local persistence', () => {
    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.assistant.provider = 'anthropic';
    settings.assistant.credentialSource = 'personal';
    settings.assistant.model = 'claude-sonnet-5-5';
    const parsed = parseUpdateAppSettingsRequest(
      { expectedRevision: 0, settings },
      'beta'
    );
    expect(parsed.settings.assistant).toEqual(settings.assistant);
    expect(normalizeAppSettings(settings).assistant).toEqual(
      settings.assistant
    );
    saveLocalAppSettings(settings);
    expect(loadLocalAppSettings().assistant).toEqual(settings.assistant);
  });

  it('strictly validates account settings and compatible endpoints', () => {
    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.assistant.credentialSource = 'personal';
    settings.assistant.provider = 'responses-compatible';
    settings.assistant.baseUrl = 'https://models.example.test/v1/responses';

    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 0, settings },
        'beta',
        'models.example.test'
      ).settings.assistant.baseUrl
    ).toBe('https://models.example.test/v1/responses');
    expect(() =>
      parseUpdateAppSettingsRequest({ expectedRevision: 0, settings }, 'beta')
    ).toThrow('not approved');
    expect(() =>
      validateAssistantBaseUrl(
        'https://other.example.test/v1/responses',
        'beta',
        'models.example.test'
      )
    ).toThrow('not approved');

    expect(() =>
      validateAssistantBaseUrl('http://169.254.169.254/latest', 'beta')
    ).toThrow('must use HTTPS');
    expect(() =>
      validateAssistantBaseUrl('https://127.0.0.1/v1/responses', 'beta')
    ).toThrow('Private-network');
    expect(() =>
      validateAssistantBaseUrl('https://[::1]/v1/responses', 'beta')
    ).toThrow('Private-network');
    expect(() =>
      validateAssistantBaseUrl('https://[::]/v1/responses', 'beta')
    ).toThrow('Private-network');
    expect(() =>
      validateAssistantBaseUrl('https://[::ffff:7f00:1]/v1/responses', 'beta')
    ).toThrow('Private-network');
    expect(() =>
      validateAssistantBaseUrl('https://[64:ff9b::7f00:1]/v1/responses', 'beta')
    ).toThrow('Private-network');
    // The unified validator carries the request-time checks too: .lan and
    // .localhost suffixes, carrier-grade NAT, and multicast space.
    expect(() =>
      validateAssistantBaseUrl('https://models.lan/v1/responses', 'beta')
    ).toThrow('Private-network');
    expect(() =>
      validateAssistantBaseUrl('https://ai.localhost/v1/responses', 'beta')
    ).toThrow('Private-network');
    expect(() =>
      validateAssistantBaseUrl('https://100.64.0.1/v1/responses', 'beta')
    ).toThrow('Private-network');
    expect(() =>
      validateAssistantBaseUrl('https://224.0.0.1/v1/responses', 'beta')
    ).toThrow('Private-network');
    expect(
      validateAssistantBaseUrl(
        'http://localhost:11434/v1/responses',
        'development'
      )
    ).toBe('http://localhost:11434/v1/responses');
  });

  it('preserves the sharing opt-out when a stored row stops re-parsing', () => {
    // A saved Responses-compatible endpoint whose hostname later leaves
    // AI_ALLOWED_BASE_URL_HOSTS makes the whole strict re-parse throw. The
    // fallback must not flip the user's sharing opt-out back to the default.
    const stored = deepClone(DEFAULT_APP_SETTINGS);
    stored.collaboration.enabled = false;
    stored.assistant.credentialSource = 'personal';
    stored.assistant.provider = 'responses-compatible';
    stored.assistant.baseUrl = 'https://models.example.test/v1/responses';
    expect(() =>
      parseUpdateAppSettingsRequest(
        { expectedRevision: 1, settings: stored },
        'beta'
      )
    ).toThrow('not approved');

    const salvaged = salvageStoredSettings(JSON.stringify(stored));
    expect(salvaged.collaboration.enabled).toBe(false);
    // Everything else degrades to the defaults, including the assistant,
    // whose default is already fail-closed.
    expect(salvaged.assistant.enabled).toBe(false);
    expect(salvaged.assistant.baseUrl).toBe(
      DEFAULT_APP_SETTINGS.assistant.baseUrl
    );

    // A stored opt-in stays an opt-in; legacy rows without the key and
    // unreadable rows receive the same default as the settings API.
    const optIn = deepClone(DEFAULT_APP_SETTINGS) as unknown as Record<
      string,
      unknown
    >;
    expect(
      salvageStoredSettings(JSON.stringify(optIn)).collaboration.enabled
    ).toBe(true);
    delete optIn.collaboration;
    expect(
      salvageStoredSettings(JSON.stringify(optIn)).collaboration.enabled
    ).toBe(DEFAULT_APP_SETTINGS.collaboration.enabled);
    expect(salvageStoredSettings('not json').collaboration.enabled).toBe(
      DEFAULT_APP_SETTINGS.collaboration.enabled
    );
  });

  it('carries resized panel widths to the account, in range', () => {
    // Layout widths ride the settings sync so a resized sidebar follows the
    // account to the next browser, rather than being stranded on one device.
    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.layout = { sidebarWidth: 318, assistantWidth: 505 };

    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 0, settings },
        'development'
      ).settings.layout
    ).toEqual({ sidebarWidth: 318, assistantWidth: 505 });

    // A width from a client with different limits is brought into range, not
    // treated as a reason to reject everything else in the payload.
    const extreme = deepClone(DEFAULT_APP_SETTINGS);
    extreme.layout = { sidebarWidth: 4_000, assistantWidth: 12 };
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 0, settings: extreme },
        'development'
      ).settings.layout
    ).toEqual({
      sidebarWidth: PANEL_WIDTH_LIMITS.sidebar.max,
      assistantWidth: PANEL_WIDTH_LIMITS.assistant.min
    });
  });

  it('accepts an account payload from a client that predates the layout', () => {
    const { layout: _layout, ...legacy } = deepClone(DEFAULT_APP_SETTINGS);

    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 0, settings: legacy },
        'development'
      ).settings.layout
    ).toEqual({
      sidebarWidth: PANEL_WIDTH_LIMITS.sidebar.default,
      assistantWidth: PANEL_WIDTH_LIMITS.assistant.default
    });
  });

  it('normalizes stored panel widths without discarding the settings', () => {
    const normalized = normalizeAppSettings({
      layout: { sidebarWidth: '340', assistantWidth: 1_200 }
    });
    expect(normalized.layout.sidebarWidth).toBe(
      PANEL_WIDTH_LIMITS.sidebar.default
    );
    expect(normalized.layout.assistantWidth).toBe(
      PANEL_WIDTH_LIMITS.assistant.max
    );
    expect(
      normalizeAppSettings({ layout: { sidebarWidth: 301.6 } }).layout
    ).toEqual({
      sidebarWidth: 302,
      assistantWidth: PANEL_WIDTH_LIMITS.assistant.default
    });
  });

  it('round-trips a resized panel through device storage', () => {
    const resized = defaultAppSettings();
    resized.layout.sidebarWidth = 288;

    expect(saveLocalAppSettings(resized, null)).toBe(true);
    expect(loadLocalAppSettings().layout.sidebarWidth).toBe(288);
  });

  it('keeps an unsaved device change from being reverted by the account copy', () => {
    // A boot-time account fetch is only allowed to replace what is on the
    // device when the device has nothing unsaved; otherwise turning the
    // assistant off and reloading would turn it back on.
    expect(shouldAdoptAccountSettings(null)).toBe(true);
    expect(
      shouldAdoptAccountSettings({
        settings: defaultAppSettings(),
        syncedRevision: 4
      })
    ).toBe(true);
    expect(
      shouldAdoptAccountSettings({
        settings: defaultAppSettings(),
        syncedRevision: null
      })
    ).toBe(false);
  });

  it('round-trips the synced revision alongside device settings', () => {
    const edited = defaultAppSettings();
    edited.collaboration.enabled = false;

    expect(saveLocalAppSettings(edited, null)).toBe(true);
    const dirty = loadLocalAppSettingsRecord();
    expect(dirty?.syncedRevision).toBeNull();
    expect(dirty?.settings.collaboration.enabled).toBe(false);
    expect(shouldAdoptAccountSettings(dirty)).toBe(false);

    expect(saveLocalAppSettings(edited, 7)).toBe(true);
    const clean = loadLocalAppSettingsRecord();
    expect(clean?.syncedRevision).toBe(7);
    expect(shouldAdoptAccountSettings(clean)).toBe(true);
  });

  it('treats settings stored before revision tracking as already in sync', () => {
    // Anyone upgrading has a bare AppSettings blob on disk. Calling that dirty
    // would strand whatever their account holds behind a stale device copy.
    const legacy = defaultAppSettings();
    legacy.appearance.density = 'comfortable';
    window.localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify(legacy)
    );

    const stored = loadLocalAppSettingsRecord();
    expect(stored?.settings.appearance.density).toBe('comfortable');
    expect(shouldAdoptAccountSettings(stored)).toBe(true);
  });

  it('falls back to defaults when device storage is empty or corrupt', () => {
    window.localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
    expect(loadLocalAppSettingsRecord()).toBeNull();
    expect(loadLocalAppSettings().assistant.enabled).toBe(false);

    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, '{not json');
    expect(loadLocalAppSettingsRecord()).toBeNull();
    expect(loadLocalAppSettings()).toEqual(defaultAppSettings());
  });

  it('encrypts personal credentials with owner-bound authenticated data', async () => {
    const owner = toUserId('user_settings_owner');
    const intruder = toUserId('user_settings_intruder');
    const token = 'test-api-key-placeholder';
    const secret = encryptionSecret();
    const encrypted = await encryptAssistantCredential(token, owner, secret);

    expect(JSON.stringify(encrypted)).not.toContain(token);
    await expect(
      decryptAssistantCredential(
        {
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv
        },
        owner,
        secret
      )
    ).resolves.toBe(token);
    await expect(
      decryptAssistantCredential(
        {
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv
        },
        intruder,
        secret
      )
    ).rejects.toThrow('could not be decrypted');
  });

  it('reads settings written before cloud autosave as the defaults, not as off', () => {
    // Turning autosave off is a choice. Absence is not that choice, and reading
    // it as one would quietly stop syncing for every existing account.
    const normalized = normalizeAppSettings({
      general: { defaultUnits: 'mm' }
    });
    expect(normalized.files.cloudAutosave).toBe(true);
    expect(normalized.files.cloudAutosaveDelaySeconds).toBe(
      CLOUD_AUTOSAVE_DELAY_BOUNDS.default
    );
  });

  it('keeps project sharing on for settings written before its switch existed', () => {
    const normalized = normalizeAppSettings({
      general: { defaultUnits: 'mm' }
    });
    expect(normalized.collaboration.enabled).toBe(true);

    const { collaboration: _omitted, ...settings } =
      deepClone(DEFAULT_APP_SETTINGS);
    const parsed = parseUpdateAppSettingsRequest(
      { expectedRevision: 1, settings },
      'development'
    );
    expect(parsed.settings.collaboration.enabled).toBe(true);
  });

  it('carries the project sharing switch through the account round trip', () => {
    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.collaboration.enabled = false;
    const parsed = parseUpdateAppSettingsRequest(
      { expectedRevision: 1, settings },
      'development'
    );
    expect(parsed.settings.collaboration.enabled).toBe(false);
  });

  it('keeps the autosave delay inside the bounds every layer agrees on', () => {
    expect(
      normalizeAppSettings({ files: { cloudAutosaveDelaySeconds: 0 } }).files
        .cloudAutosaveDelaySeconds
    ).toBe(CLOUD_AUTOSAVE_DELAY_BOUNDS.min);
    expect(
      normalizeAppSettings({ files: { cloudAutosaveDelaySeconds: 9_000 } })
        .files.cloudAutosaveDelaySeconds
    ).toBe(CLOUD_AUTOSAVE_DELAY_BOUNDS.max);
    expect(
      normalizeAppSettings({ files: { cloudAutosaveDelaySeconds: 7.6 } }).files
        .cloudAutosaveDelaySeconds
    ).toBe(8);
  });

  it('carries the autosave preference through the account round trip', () => {
    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.files = {
      cloudAutosave: false,
      cloudAutosaveDelaySeconds: 30,
      unitlessImportUnits: 'inch',
      exportUnits: 'document'
    };
    const parsed = parseUpdateAppSettingsRequest(
      { expectedRevision: 1, settings },
      'development'
    );
    expect(parsed.settings.files).toEqual({
      cloudAutosave: false,
      cloudAutosaveDelaySeconds: 30,
      unitlessImportUnits: 'inch',
      exportUnits: 'document'
    });
  });

  it('defaults the file-unit preferences: ask for unitless files, write millimetres', () => {
    expect(DEFAULT_APP_SETTINGS.files.unitlessImportUnits).toBe('ask');
    expect(DEFAULT_APP_SETTINGS.files.exportUnits).toBe('mm');
    const stored = normalizeAppSettings({
      files: { unitlessImportUnits: 'cm', exportUnits: 'inch' }
    });
    expect(stored.files.unitlessImportUnits).toBe('cm');
    expect(stored.files.exportUnits).toBe('inch');
    // An unknown value (a later client's unit, a typo) falls back.
    const unknown = normalizeAppSettings({
      files: { unitlessImportUnits: 'furlong', exportUnits: 'ask' }
    });
    expect(unknown.files.unitlessImportUnits).toBe('ask');
    expect(unknown.files.exportUnits).toBe('mm');
  });

  it('keeps saving file-unit preferences a client never sent', () => {
    const settings = deepClone(DEFAULT_APP_SETTINGS) as unknown as {
      files: Record<string, unknown>;
    };
    delete settings.files.unitlessImportUnits;
    settings.files.exportUnits = 'yard';
    const parsed = parseUpdateAppSettingsRequest(
      { expectedRevision: 1, settings },
      'development'
    );
    expect(parsed.settings.files.unitlessImportUnits).toBe('ask');
    expect(parsed.settings.files.exportUnits).toBe('mm');
  });

  it('accepts a payload from a client that predates the preference', () => {
    const { files: _omitted, ...settings } = deepClone(DEFAULT_APP_SETTINGS);
    const parsed = parseUpdateAppSettingsRequest(
      { expectedRevision: 1, settings },
      'development'
    );
    expect(parsed.settings.files.cloudAutosave).toBe(true);
  });

  it('keeps the frame rate overlay off unless it was turned on', () => {
    expect(DEFAULT_APP_SETTINGS.experiments.frameRateOverlay).toBe(false);
    // Settings written before the switch existed read as off.
    expect(
      normalizeAppSettings({ experiments: { directManipulation: false } })
        .experiments
    ).toEqual({ directManipulation: false, frameRateOverlay: false });
    expect(
      normalizeAppSettings({ experiments: { frameRateOverlay: 'yes' } })
        .experiments.frameRateOverlay
    ).toBe(false);

    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.experiments.frameRateOverlay = true;
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 1, settings },
        'development'
      ).settings.experiments.frameRateOverlay
    ).toBe(true);
    const older = deepClone(DEFAULT_APP_SETTINGS) as unknown as {
      experiments: Record<string, unknown>;
    };
    delete older.experiments.frameRateOverlay;
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 1, settings: older },
        'development'
      ).settings.experiments.frameRateOverlay
    ).toBe(false);
  });

  it('round-trips shortcut remaps through device storage', () => {
    const remapped = defaultAppSettings();
    remapped.keymap = {
      overrides: { 'view-grid': ['H'], 'tool-fillet': ['Ctrl+Shift+F'] }
    };

    expect(saveLocalAppSettings(remapped, null)).toBe(true);
    expect(loadLocalAppSettings().keymap.overrides).toEqual({
      'view-grid': ['H'],
      'tool-fillet': ['Ctrl+Shift+F']
    });
  });

  it('cleans stored shortcut remaps instead of discarding them', () => {
    expect(
      normalizeAppSettings({
        keymap: {
          overrides: {
            // Canonicalized: lower-case letter, modifier order, shifted symbol.
            'view-fit': ['k', 'Shift+Ctrl+x', 'Shift+?'],
            // An empty list is how a default is cleared, so it stays.
            'view-grid': [],
            'Not An Id': ['G'],
            'view-display': 'W',
            'view-projection': ['Hyper+P', 'P', 'P']
          }
        }
      }).keymap.overrides
    ).toEqual({
      'view-fit': ['K', 'Ctrl+Shift+X', '?'],
      'view-grid': [],
      'view-projection': ['P']
    });
    expect(normalizeAppSettings({}).keymap).toEqual({ overrides: {} });
  });

  it('carries shortcut remaps through the account round trip', () => {
    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.keymap = { overrides: { 'view-grid': ['H'] } };
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 1, settings },
        'development'
      ).settings.keymap
    ).toEqual({ overrides: { 'view-grid': ['H'] } });

    // A client from before remapping still saves, with every default kept.
    const { keymap: _omitted, ...legacy } = deepClone(DEFAULT_APP_SETTINGS);
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 1, settings: legacy },
        'development'
      ).settings.keymap
    ).toEqual({ overrides: {} });
  });

  it('reads the field of view and X-ray opacity in range on every layer', () => {
    // Absent from settings written before either preference existed.
    expect(normalizeAppSettings({}).viewport).toMatchObject({
      fieldOfView: VIEWPORT_FIELD_OF_VIEW_BOUNDS.default,
      xrayOpacity: XRAY_OPACITY_BOUNDS.default
    });
    expect(
      normalizeAppSettings({ viewport: { fieldOfView: 400, xrayOpacity: 2 } })
        .viewport
    ).toMatchObject({
      fieldOfView: VIEWPORT_FIELD_OF_VIEW_BOUNDS.max,
      xrayOpacity: XRAY_OPACITY_BOUNDS.min
    });

    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.viewport = {
      ...settings.viewport,
      fieldOfView: 28.4,
      xrayOpacity: 60
    };
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 1, settings },
        'development'
      ).settings.viewport
    ).toMatchObject({ fieldOfView: 28, xrayOpacity: 60 });

    // A client from before them still saves, with the defaults kept.
    const legacy = deepClone(DEFAULT_APP_SETTINGS) as unknown as {
      viewport: Record<string, unknown>;
    };
    delete legacy.viewport.fieldOfView;
    delete legacy.viewport.xrayOpacity;
    expect(
      parseUpdateAppSettingsRequest(
        { expectedRevision: 1, settings: legacy },
        'development'
      ).settings.viewport
    ).toMatchObject({
      fieldOfView: VIEWPORT_FIELD_OF_VIEW_BOUNDS.default,
      xrayOpacity: XRAY_OPACITY_BOUNDS.default
    });
  });

  it('clamps an out-of-range delay at the account boundary too', () => {
    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.files = {
      ...settings.files,
      cloudAutosave: true,
      cloudAutosaveDelaySeconds: 100_000
    };
    const parsed = parseUpdateAppSettingsRequest(
      { expectedRevision: 1, settings },
      'development'
    );
    expect(parsed.settings.files.cloudAutosaveDelaySeconds).toBe(
      CLOUD_AUTOSAVE_DELAY_BOUNDS.max
    );
  });
});

describe('isProjectSharingPreferenceEnabled', () => {
  const envWithRow = (row: { settings_json: string } | null) =>
    ({
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => row })
        })
      }
    }) as unknown as Parameters<typeof isProjectSharingPreferenceEnabled>[1];

  it('honors a stored explicit false even when the full settings no longer validate', async () => {
    // The regression: readSettings falls back to DEFAULT_APP_SETTINGS —
    // collaboration enabled — whenever the stored row fails full validation
    // for ANY reason, silently re-enabling sharing the owner turned off.
    // A row that is valid JSON but not a valid settings document must still
    // honor its collaboration flag, exactly as the D1 json_extract path does.
    const row = {
      settings_json: JSON.stringify({
        collaboration: { enabled: false },
        notASettingsField: true
      })
    };
    await expect(
      isProjectSharingPreferenceEnabled(toUserId('user_off'), envWithRow(row))
    ).resolves.toBe(false);
  });

  it('applies the default for a missing row and for unreadable JSON', async () => {
    const fallback = DEFAULT_APP_SETTINGS.collaboration.enabled;
    await expect(
      isProjectSharingPreferenceEnabled(toUserId('user_new'), envWithRow(null))
    ).resolves.toBe(fallback);
    await expect(
      isProjectSharingPreferenceEnabled(
        toUserId('user_corrupt'),
        envWithRow({ settings_json: '{not json' })
      )
    ).resolves.toBe(fallback);
  });
});
