import { afterEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { toUserId } from '@openzcad/shared';
import { exportAccountData } from '../apps/web/worker/accountExport';
import { d1Database, migratedDatabase } from './d1-sqlite';
import worker from '../apps/web/worker/index';

let db: DatabaseSync | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

it('exports only the authenticated account records and excludes credential material', async () => {
  db = migratedDatabase();
  for (const user of ['owner', 'other']) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(user, `${user}@example.com`, '2026-10-28');
    db.prepare(
      'INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)'
    ).run(user, JSON.stringify({ owner: user }), '2026-10-28');
    db.prepare(
      'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 1, 9)'
    ).run(`secret-${user}`, user);
    db.prepare(
      'INSERT INTO user_ai_credentials (user_id, ciphertext, iv, token_hint, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(user, `ciphertext-${user}`, `iv-${user}`, 'last4', '2026-10-28');
  }
  const result = await exportAccountData(
    {
      userId: toUserId('owner'),
      email: 'owner@example.com',
      displayName: 'Owner',
      mode: 'email-code'
    },
    { DB: d1Database(db) }
  );
  const text = JSON.stringify(result);
  expect(text).toContain('owner@example.com');
  expect(text).toContain('last4');
  expect(text).not.toContain('other@example.com');
  expect(text).not.toContain('secret-');
  expect(text).not.toContain('ciphertext-');
  expect(text).not.toContain('iv-');
  expect(
    (result.records as Record<string, unknown[]>).user_settings
  ).toHaveLength(1);
});

it('requires authentication, rejects cross-origin reads and prevents caching exports', async () => {
  const route = 'https://example.com/api/account/export';
  db = migratedDatabase();
  const unauthorized = await worker.fetch(new Request(route), {
    ENVIRONMENT: 'beta',
    AUTH_MODE: 'email-code',
    DB: d1Database(db)
  });
  expect(unauthorized.status).toBe(401);
  const env = {
    ENVIRONMENT: 'development' as const,
    AUTH_MODE: 'development' as const
  };
  const crossOrigin = await worker.fetch(
    new Request(route, { headers: { origin: 'https://unrelated.example' } }),
    env
  );
  expect(crossOrigin.status).toBe(403);
  const response = await worker.fetch(new Request(route), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toContain('Authorization');
  expect(await response.json()).toMatchObject({
    profile: { userId: 'user_beta_dev' }
  });
});
