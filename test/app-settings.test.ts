import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, deepClone, toUserId } from '@openzcad/shared';
import {
  defaultAppSettings,
  normalizeAppSettings
} from '../apps/web/src/lib/appSettings';
import {
  decryptAssistantCredential,
  encryptAssistantCredential,
  parseUpdateAppSettingsRequest,
  validateAssistantBaseUrl
} from '../apps/web/worker/settings';

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
