import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import {
  enforceApiRateLimit,
  publicRequestBucket
} from '../apps/web/worker/apiRateLimit';
it('counts concurrent callers atomically, isolates buckets, and resets at the next minute', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE auth_rate_limits(bucket TEXT PRIMARY KEY, window_start INTEGER, request_count INTEGER)'
  );
  const env = {
    ENVIRONMENT: 'beta',
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: (string | number)[]) {
            return {
              async first() {
                return db.prepare(sql).get(...values);
              },
              async run() {
                return db.prepare(sql).run(...values);
              }
            };
          }
        };
      }
    }
  } as unknown as CloudflareEnv;
  const now = vi.spyOn(Date, 'now').mockReturnValue(60_000);
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => enforceApiRateLimit(env, 'one', 3))
    );
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(3);
    expect(results.at(-1)).toMatchObject({
      status: 'rejected',
      reason: { status: 429 }
    });
    await expect(enforceApiRateLimit(env, 'two', 3)).resolves.toBeUndefined();
    now.mockReturnValue(120_000);
    await expect(enforceApiRateLimit(env, 'one', 3)).resolves.toBeUndefined();
  } finally {
    now.mockRestore();
    db.close();
  }
});
it('prunes at most 100 stale buckets per public request without resetting current or login windows', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE auth_rate_limits(bucket TEXT PRIMARY KEY, window_start INTEGER, request_count INTEGER)'
  );
  const insert = db.prepare('INSERT INTO auth_rate_limits VALUES (?, ?, ?)');
  for (let i = 0; i < 101; i++) insert.run(`stale_${i}`, 0, 1);
  insert.run('login', 1800, 7);
  insert.run('public', 3600, 1);
  const env = {
    ENVIRONMENT: 'beta',
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: (string | number)[]) {
            return {
              async first() {
                return db.prepare(sql).get(...values);
              },
              async run() {
                return db.prepare(sql).run(...values);
              }
            };
          }
        };
      }
    }
  } as unknown as CloudflareEnv;
  const now = vi.spyOn(Date, 'now').mockReturnValue(3_600_000);
  try {
    await expect(enforceApiRateLimit(env, 'public', 1)).rejects.toMatchObject({
      status: 429
    });
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM auth_rate_limits WHERE window_start = 0'
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT request_count FROM auth_rate_limits WHERE bucket = 'login'"
        )
        .get()
    ).toEqual({ request_count: 7 });
    expect(
      db
        .prepare(
          "SELECT request_count FROM auth_rate_limits WHERE bucket = 'public'"
        )
        .get()
    ).toEqual({ request_count: 2 });
    await enforceApiRateLimit(env, 'another', 1);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM auth_rate_limits WHERE window_start = 0'
        )
        .get()
    ).toEqual({ count: 0 });
  } finally {
    now.mockRestore();
    db.close();
  }
});
it('fails closed without its database and keeps anonymous buckets opaque', async () => {
  await expect(
    enforceApiRateLimit({ ENVIRONMENT: 'beta' }, 'one', 3)
  ).rejects.toMatchObject({ status: 503 });
  const request = new Request('https://zcad.app/api/health', {
    headers: { 'cf-connecting-ip': '192.0.2.1' }
  });
  const first = await publicRequestBucket(
    request,
    { AUTH_OTP_PEPPER: 'test-secret' },
    'health'
  );
  expect(first).toMatch(/^health:[a-f0-9]{64}$/);
  expect(first).not.toContain('192.0.2.1');
  expect(
    await publicRequestBucket(
      request,
      { AUTH_OTP_PEPPER: 'different' },
      'health'
    )
  ).not.toBe(first);
});
