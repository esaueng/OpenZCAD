import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountServerSettings,
  DEFAULT_APP_SETTINGS,
  holdsOnlyAccountServerSettings,
  SETTINGS_ENCRYPTION_REQUIRED_CODE,
  toUserId,
  withAccountServerSettings,
  type AppSettings,
  type AppSettingsResponse
} from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import { exportAccountData } from '../apps/web/worker/accountExport';
import { parseAssistantProposalRequest } from '../apps/web/worker/validation';
import { withRequestCustomInstructions } from '../apps/web/worker/settings';
import { d1Database, migratedDatabase } from './d1-sqlite';

/**
 * ADR-024 amendment 2026-11-14: an account whose library is encrypted keeps
 * only what the Worker acts on readable, and the rest sealed under its
 * account key.
 */
const USER = 'user_beta_dev';
const NOW = '2026-11-14T12:00:00.000Z';
const projectsOn = { E2EE_KEYS_ENABLED: 'true', E2EE_PROJECTS_ENABLED: 'true' };
const SEALED = 'c2VhbGVkLXNldHRpbmdz';

let db: DatabaseSync | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function seed(encryptedProject: boolean) {
  db = migratedDatabase();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    USER,
    `${USER}@example.com`,
    NOW
  );
  if (encryptedProject) {
    db.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at, storage_format)
       VALUES ('proj_sealed', ?, '', 'e2ee-v1:x', ?, 2)`
    ).run(USER, NOW);
  }
  return d1Database(db);
}

function env(d1: D1Database, extra: Record<string, string> = {}) {
  return {
    ENVIRONMENT: 'development' as const,
    AUTH_MODE: 'development' as const,
    DB: d1,
    ...extra
  } as never;
}

function privateSettings(): AppSettings {
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.appearance.theme = 'light';
  settings.general.defaultUnits = 'inch';
  settings.assistant.customInstructions = 'Prefer 0.4 mm sliding clearances.';
  settings.collaboration.enabled = false;
  settings.assistant.model = 'owner-model';
  return settings;
}

const patch = (body: unknown) =>
  new Request('https://example.com/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
const get = () => new Request('https://example.com/api/settings');

function storedRow() {
  return db!
    .prepare(
      'SELECT settings_json, sealed_settings FROM user_settings WHERE user_id = ?'
    )
    .get(USER) as { settings_json: string; sealed_settings: string | null };
}

describe('the server part of account settings', () => {
  it('keeps the sharing switch and the assistant route, and nothing else', () => {
    const full = privateSettings();
    const server = accountServerSettings(full);
    expect(server.collaboration.enabled).toBe(false);
    expect(server.assistant.model).toBe('owner-model');
    expect(server.assistant.customInstructions).toBe('');
    expect(server.appearance.theme).toBe(DEFAULT_APP_SETTINGS.appearance.theme);
    expect(server.general.defaultUnits).toBe(
      DEFAULT_APP_SETTINGS.general.defaultUnits
    );
    expect(holdsOnlyAccountServerSettings(server)).toBe(true);
    expect(holdsOnlyAccountServerSettings(full)).toBe(false);
    // The Worker's copy of what it acts on wins over a sealed copy's.
    const stale = structuredClone(full);
    stale.collaboration.enabled = true;
    stale.assistant.model = 'old-model';
    const merged = withAccountServerSettings(stale, server);
    expect(merged.collaboration.enabled).toBe(false);
    expect(merged.assistant.model).toBe('owner-model');
    expect(merged.assistant.customInstructions).toBe(
      full.assistant.customInstructions
    );
    expect(merged.appearance.theme).toBe('light');
  });
});

describe('PATCH /api/settings for an encrypted library', () => {
  it('stores only the server part readable and the rest sealed', async () => {
    const d1 = seed(true);
    const full = privateSettings();

    // A client that sends everything readable is refused, and nothing changes.
    const readable = await worker.fetch(
      patch({ expectedRevision: 0, settings: full }),
      env(d1, projectsOn)
    );
    expect(readable.status).toBe(409);
    expect(await readable.json()).toMatchObject({
      code: SETTINGS_ENCRYPTION_REQUIRED_CODE
    });
    expect(storedRow()).toBeUndefined();

    const sealed = await worker.fetch(
      patch({
        expectedRevision: 0,
        settings: accountServerSettings(full),
        sealedSettings: SEALED
      }),
      env(d1, projectsOn)
    );
    expect(sealed.status).toBe(200);
    const row = storedRow();
    expect(row.sealed_settings).toBe(SEALED);
    expect(row.settings_json).not.toContain('sliding clearances');
    expect(row.settings_json).not.toContain('inch');
    expect(JSON.parse(row.settings_json)).toMatchObject({
      collaboration: { enabled: false },
      assistant: { model: 'owner-model', customInstructions: '' }
    });

    const read = (await (
      await worker.fetch(get(), env(d1, projectsOn))
    ).json()) as AppSettingsResponse;
    expect(read.sealedSettings).toBe(SEALED);
    expect(read.revision).toBe(1);

    // A device with locked keys saves the server part and keeps the record.
    const server = accountServerSettings(full);
    server.collaboration.enabled = true;
    const locked = await worker.fetch(
      patch({ expectedRevision: 1, settings: server }),
      env(d1, projectsOn)
    );
    expect(locked.status).toBe(200);
    expect(storedRow().sealed_settings).toBe(SEALED);
    expect(JSON.parse(storedRow().settings_json)).toMatchObject({
      collaboration: { enabled: true }
    });
  });

  it('refuses a client that leaves fields to the stored copy', async () => {
    const d1 = seed(true);
    const body = {
      expectedRevision: 0,
      settings: accountServerSettings(
        DEFAULT_APP_SETTINGS
      ) as Partial<AppSettings>
    };
    // A client from before shortcut remapping sends no keymap: the stored
    // one would be carried readable.
    delete body.settings.keymap;
    const response = await worker.fetch(patch(body), env(d1, projectsOn));
    expect(response.status).toBe(409);
  });

  it('refuses a malformed sealed record', async () => {
    const d1 = seed(true);
    const response = await worker.fetch(
      patch({
        expectedRevision: 0,
        settings: accountServerSettings(DEFAULT_APP_SETTINGS),
        sealedSettings: 'not base64url!'
      }),
      env(d1, projectsOn)
    );
    expect(response.status).toBe(400);
  });
});

describe('PATCH /api/settings for a readable account', () => {
  it('stores everything as before and drops any sealed record', async () => {
    const d1 = seed(false);
    const full = privateSettings();
    db!
      .prepare(
        `INSERT INTO user_settings (user_id, settings_json, revision, updated_at, sealed_settings)
       VALUES (?, ?, 1, ?, ?)`
      )
      .run(USER, JSON.stringify(DEFAULT_APP_SETTINGS), NOW, SEALED);
    const response = await worker.fetch(
      patch({ expectedRevision: 1, settings: full }),
      env(d1, projectsOn)
    );
    expect(response.status).toBe(200);
    const row = storedRow();
    expect(row.sealed_settings).toBeNull();
    expect(row.settings_json).toContain('sliding clearances');
    const read = (await (
      await worker.fetch(get(), env(d1, projectsOn))
    ).json()) as AppSettingsResponse;
    expect(read).not.toHaveProperty('sealedSettings');
    expect(read.settings.appearance.theme).toBe('light');
  });

  it('leaves an encrypted library alone while the rollout flag is off', async () => {
    const d1 = seed(true);
    const response = await worker.fetch(
      patch({ expectedRevision: 0, settings: privateSettings() }),
      env(d1)
    );
    expect(response.status).toBe(200);
  });
});

describe('the account export', () => {
  it('carries the sealed record as stored', async () => {
    const d1 = seed(true);
    await worker.fetch(
      patch({
        expectedRevision: 0,
        settings: accountServerSettings(privateSettings()),
        sealedSettings: SEALED
      }),
      env(d1, projectsOn)
    );
    const exported = await exportAccountData(
      { userId: toUserId(USER), displayName: 'Owner', mode: 'development' },
      { DB: d1 }
    );
    const rows = (exported.records as Record<string, unknown[]>).user_settings;
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({ sealed_settings: SEALED });
  });
});

describe('custom instructions with each assistant request', () => {
  const body = (extra: Record<string, unknown>) => ({
    prompt: 'Make it thicker',
    digest: {
      schemaVersion: 1,
      projectId: 'proj_1',
      name: 'x',
      units: 'mm',
      version: 1,
      parameters: [],
      features: [],
      warnings: []
    },
    ...extra
  });

  it('runs with the browser copy, or the stored one from an older client', () => {
    const runtime = {
      provider: 'openrouter' as const,
      apiKey: 'personal-key',
      model: 'owner-model',
      reasoningEffort: 'off' as const,
      maxOutputTokens: 24_000,
      timeoutMs: 30_000,
      customInstructions: 'stored'
    };
    expect(
      withRequestCustomInstructions(runtime, { customInstructions: 'sent' })
        ?.customInstructions
    ).toBe('sent');
    expect(
      withRequestCustomInstructions(runtime, { customInstructions: '' })
        ?.customInstructions
    ).toBe('');
    expect(withRequestCustomInstructions(runtime, {})).toBe(runtime);
    // The deployment's key runs no user runtime at all.
    expect(
      withRequestCustomInstructions(null, { customInstructions: 'sent' })
    ).toBeUndefined();
  });

  it('accepts the browser copy and refuses an oversized one', () => {
    expect(
      parseAssistantProposalRequest(body({ customInstructions: 'Use M3.' }))
        .customInstructions
    ).toBe('Use M3.');
    expect(
      parseAssistantProposalRequest(body({ customInstructions: '' }))
        .customInstructions
    ).toBe('');
    expect(parseAssistantProposalRequest(body({}))).not.toHaveProperty(
      'customInstructions'
    );
    expect(() =>
      parseAssistantProposalRequest(
        body({ customInstructions: 'x'.repeat(4_001) })
      )
    ).toThrow(/customInstructions/);
    expect(() =>
      parseAssistantProposalRequest(body({ customInstructions: 7 }))
    ).toThrow(/customInstructions/);
  });
});
