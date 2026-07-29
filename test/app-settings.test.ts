import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, deepClone, toUserId } from '@openzcad/shared';
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
  parseUpdateAppSettingsRequest,
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
      assistant: { model: '' }
    });

    expect(normalized.general.reopenLastProject).toBe(false);
    expect(normalized.general.defaultUnits).toBe('mm');
    expect(normalized.viewport.showGrid).toBe(false);
    expect(normalized.viewport.displayMode).toBe('shaded-edges');
    expect(normalized.sketching.linearSnap).toBe(1);
    expect(normalized.assistant.enabled).toBe(false);
    expect(normalized.assistant.model).toBe('openai/gpt-5.6-terra');
  });

  it('returns independent default objects', () => {
    const first = defaultAppSettings();
    const second = defaultAppSettings();
    first.general.defaultUnits = 'inch';
    expect(second.general.defaultUnits).toBe('mm');
  });

  it('strictly validates account settings and compatible endpoints', () => {
    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.assistant.credentialSource = 'personal';
    settings.assistant.provider = 'responses-compatible';
    settings.assistant.baseUrl = 'https://models.example.test/v1/responses';

    expect(
      parseUpdateAppSettingsRequest({ expectedRevision: 0, settings }, 'beta')
        .settings.assistant.baseUrl
    ).toBe('https://models.example.test/v1/responses');

    expect(() =>
      validateAssistantBaseUrl('http://169.254.169.254/latest', 'beta')
    ).toThrow('must use HTTPS');
    expect(() =>
      validateAssistantBaseUrl('https://127.0.0.1/v1/responses', 'beta')
    ).toThrow('Private-network');
    expect(() =>
      validateAssistantBaseUrl('https://[::1]/v1/responses', 'beta')
    ).toThrow('Private-network');
    expect(
      validateAssistantBaseUrl(
        'http://localhost:11434/v1/responses',
        'development'
      )
    ).toBe('http://localhost:11434/v1/responses');
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
    edited.assistant.enabled = false;

    expect(saveLocalAppSettings(edited, null)).toBe(true);
    const dirty = loadLocalAppSettingsRecord();
    expect(dirty?.syncedRevision).toBeNull();
    expect(dirty?.settings.assistant.enabled).toBe(false);
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
    const token = 'sk-personal-never-return-this';
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
});
