import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import { startEmailLogin } from '../apps/web/worker/auth';
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
it('prunes at most 100 stale buckets without resetting current, login, or hourly invitation windows', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE auth_rate_limits(bucket TEXT PRIMARY KEY, window_start INTEGER, request_count INTEGER)'
  );
  const insert = db.prepare('INSERT INTO auth_rate_limits VALUES (?, ?, ?)');
  for (let i = 0; i < 101; i++) insert.run(`stale_${i}`, 0, 1);
  insert.run('login', 9900, 7);
  insert.run('project-invite-account:owner', 7200, 10);
  insert.run('public', 10740, 1);
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
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_740_000);
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
          "SELECT request_count FROM auth_rate_limits WHERE bucket = 'project-invite-account:owner'"
        )
        .get()
    ).toEqual({ request_count: 10 });
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

it('login cleanup preserves the same active hourly invitation counters', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE auth_rate_limits(bucket TEXT PRIMARY KEY, window_start INTEGER, request_count INTEGER);
    CREATE TABLE auth_sessions(token_hash TEXT, expires_at INTEGER);
    CREATE TABLE auth_email_challenges(id TEXT, email TEXT, code_hash TEXT, attempts INTEGER, created_at INTEGER, expires_at INTEGER, consumed_at INTEGER);
    INSERT INTO auth_rate_limits VALUES ('project-invite-account:owner', 7200, 10), ('expired', 0, 1);
  `);
  function prepare(sql: string, values: (string | number)[] = []) {
    return {
      bind: (...next: (string | number)[]) => prepare(sql, next),
      first: async () => db.prepare(sql).get(...values) ?? null,
      run: async () => ({
        success: true,
        meta: { changes: Number(db.prepare(sql).run(...values).changes) }
      })
    };
  }
  const database = {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) =>
      Promise.all(statements.map((statement) => statement.run()))
  };
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_740_000);
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json({
        success: true,
        action: 'email-code',
        hostname: 'example.com'
      })
    );
  try {
    await startEmailLogin(
      new Request('https://example.com/api/auth/email/start'),
      { email: 'person@example.com', turnstileToken: 'test-token' },
      {
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'email-code',
        DB: database as unknown as D1Database,
        EMAIL: { send: async () => ({ messageId: 'test-message' }) },
        AUTH_EMAIL_FROM: 'login@auth.example.com',
        AUTH_OTP_PEPPER: 'test-pepper',
        TURNSTILE_SITE_KEY: 'test-site',
        TURNSTILE_SECRET_KEY: 'test-secret'
      }
    );
    expect(
      db
        .prepare(
          "SELECT request_count FROM auth_rate_limits WHERE bucket = 'project-invite-account:owner'"
        )
        .get()
    ).toEqual({ request_count: 10 });
    expect(
      db
        .prepare("SELECT bucket FROM auth_rate_limits WHERE bucket = 'expired'")
        .get()
    ).toBeUndefined();
  } finally {
    fetchMock.mockRestore();
    now.mockRestore();
    db.close();
  }
});
