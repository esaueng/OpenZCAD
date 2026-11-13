import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectObjectStorageError } from '@openzcad/persistence';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import worker from '../apps/web/worker/index';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const SHARE_TOKEN = 'Q'.repeat(43);
const ADDRESS = '203.0.113.9';

/**
 * A hosted (non-development) email-code deployment on migrated SQLite,
 * recording every statement so a test can show which work a refused request
 * never reached.
 */
function hostedEnv() {
  const statements: string[] = [];
  const sqlite = migratedDatabase();
  const env = {
    ENVIRONMENT: 'beta' as const,
    AUTH_MODE: 'email-code' as const,
    DESKTOP_AUTH_ENABLED: 'true',
    PROJECT_SHARING_ENABLED: 'true',
    DB: sqliteD1(sqlite, {
      onStatement: (sql) => statements.push(sql)
    }),
    EMAIL: { send: async () => ({ messageId: 'unused' }) },
    AUTH_EMAIL_FROM: 'login@auth.example.com',
    AUTH_OTP_PEPPER: 'test-pepper',
    AI_IDENTITY_PEPPER: 'test-identity-pepper',
    TURNSTILE_SITE_KEY: 'site-key',
    TURNSTILE_SECRET_KEY: 'turnstile-secret'
  };
  return { env, sqlite, statements };
}

/** A request body that records whether the route ever read it. */
function trackedBody(text: string) {
  const state = { read: false };
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.read = true;
        // In 1 KiB chunks, so the streaming cap sees the size grow.
        for (let offset = 0; offset < bytes.length; offset += 1024) {
          controller.enqueue(bytes.slice(offset, offset + 1024));
        }
        controller.close();
      }
    },
    // No read-ahead: pull runs only once the route reads the body.
    { highWaterMark: 0 }
  );
  return { body, state };
}

function post(
  path: string,
  body: ReadableStream<Uint8Array> | string,
  headers: Record<string, string> = {}
): Request {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': ADDRESS, ...headers },
    body,
    duplex: 'half'
  } as RequestInit);
}

/**
 * Spends the rest of this minute's budget for the one address bucket the
 * first request created, as `limit` requests from that address would.
 */
function spendAddressBudget(
  sqlite: ReturnType<typeof migratedDatabase>,
  limit: number
): void {
  const buckets = sqlite
    .prepare('SELECT bucket FROM auth_rate_limits')
    .all() as { bucket: string }[];
  expect(buckets).toHaveLength(1);
  sqlite
    .prepare('UPDATE auth_rate_limits SET request_count = ? WHERE bucket = ?')
    .run(limit, buckets[0]!.bucket);
}

function fixMinute(): void {
  // Every request below falls in one fixed-window minute.
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-13T10:00:10Z'));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sign-in request bodies', () => {
  it.each([
    '/api/auth/email/start',
    '/api/auth/email/verify',
    '/api/auth/desktop/start',
    '/api/auth/desktop/exchange',
    '/api/auth/desktop/refresh'
  ])(
    'refuses a body over 4 KiB on %s before parsing it or checking Turnstile',
    async (path) => {
      const turnstile = vi.fn();
      vi.stubGlobal('fetch', turnstile);
      const { env, statements } = hostedEnv();
      const oversized = JSON.stringify({ email: 'a'.repeat(5 * 1024) });
      const response = await worker.fetch(
        post(path, trackedBody(oversized).body),
        env
      );
      expect(response.status).toBe(413);
      expect(turnstile).not.toHaveBeenCalled();
      expect(
        statements.filter((sql) => !sql.includes('auth_rate_limits'))
      ).toEqual([]);
    }
  );

  it('still accepts a sign-in request of ordinary size', async () => {
    const { env } = hostedEnv();
    const response = await worker.fetch(
      post(
        '/api/auth/email/verify',
        JSON.stringify({ challengeId: 'challenge-unknown', code: '123456' })
      ),
      env
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'AUTH_CODE_INVALID' });
  });
});

describe('per-address limits before a sign-in body is read', () => {
  it.each([
    ['/api/auth/email/verify', 30],
    ['/api/auth/desktop/exchange', 60],
    ['/api/auth/desktop/refresh', 30]
  ] as const)(
    'answers %s with 429 past %i requests a minute, without reading the body',
    async (path, limit) => {
      fixMinute();
      const { env, sqlite, statements } = hostedEnv();
      expect((await worker.fetch(post(path, '{}'), env)).status).not.toBe(429);
      spendAddressBudget(sqlite, limit);
      statements.length = 0;
      const { body, state } = trackedBody('{}');
      const limited = await worker.fetch(post(path, body), env);
      expect(limited.status).toBe(429);
      expect(state.read).toBe(false);
      expect(
        statements.filter((sql) => !sql.includes('auth_rate_limits'))
      ).toEqual([]);
      // Another address keeps its own budget.
      const other = await worker.fetch(
        post(path, '{}', { 'cf-connecting-ip': '203.0.113.10' }),
        env
      );
      expect(other.status).not.toBe(429);
    }
  );
});

describe('anonymous assistant proposals', () => {
  it('are refused before the body is read or D1 is touched', async () => {
    const { env, statements } = hostedEnv();
    const { body, state } = trackedBody(
      JSON.stringify({ prompt: 'x', padding: 'y'.repeat(64 * 1024) })
    );
    const response = await worker.fetch(
      post('/api/assistant/proposals', body),
      env
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect(state.read).toBe(false);
    expect(statements).toEqual([]);
  });
});

describe('plaintext share-link reads', () => {
  it.each([
    `/api/share/${SHARE_TOKEN}`,
    `/api/share/${SHARE_TOKEN}/assets/asset-1`,
    `/api/share/${SHARE_TOKEN}/sources/source-1`
  ])(
    'count per address and stop before the token lookup (%s)',
    async (path) => {
      fixMinute();
      const { env, sqlite, statements } = hostedEnv();
      const get = (address = ADDRESS) =>
        worker.fetch(
          new Request(`https://example.com${path}`, {
            headers: { 'cf-connecting-ip': address }
          }),
          env
        );
      // An unknown link answers the opaque 404 within the budget.
      expect((await get()).status).toBe(404);
      spendAddressBudget(sqlite, 300);
      statements.length = 0;
      expect((await get()).status).toBe(429);
      expect(
        statements.filter((sql) => !sql.includes('auth_rate_limits'))
      ).toEqual([]);
      expect((await get('203.0.113.10')).status).toBe(404);
    }
  );

  it('keep the token out of the storage-failure log line', async () => {
    const { env } = hostedEnv();
    vi.spyOn(
      D1R2PersistenceService.prototype,
      'loadSharedProjectByTokenHash'
    ).mockRejectedValue(new ProjectObjectStorageError('R2 read failed.'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await worker.fetch(
      new Request(`https://example.com/api/share/${SHARE_TOKEN}`, {
        headers: { 'cf-connecting-ip': ADDRESS }
      }),
      env
    );
    expect(response.status).toBe(503);
    expect(logged).toHaveBeenCalled();
    const output = JSON.stringify(
      logged.mock.calls.map((call) => call.map(String))
    );
    expect(output).not.toContain(SHARE_TOKEN);
    expect(output).toContain('/api/share/:redacted');
  });

  it('keep the token out of the unhandled-error log line', async () => {
    const { env } = hostedEnv();
    vi.spyOn(
      D1R2PersistenceService.prototype,
      'loadSharedProjectAsset'
    ).mockRejectedValue(new Error('unexpected'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await worker.fetch(
      new Request(
        `https://example.com/api/share/${SHARE_TOKEN}/assets/asset-1`,
        { headers: { 'cf-connecting-ip': ADDRESS } }
      ),
      env
    );
    expect(response.status).toBe(500);
    const output = JSON.stringify(logged.mock.calls);
    expect(output).not.toContain(SHARE_TOKEN);
    expect(output).toContain('/api/share/:redacted/assets/asset-1');
  });
});

describe('signed-in reads', () => {
  it('have their own generous per-account budget', async () => {
    fixMinute();
    const { env, sqlite } = hostedEnv();
    const token = 'session-token-for-read-limit';
    const tokenHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
      ),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    const userId = 'user_read_limit';
    sqlite
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .run(userId, 'reader@example.com', new Date().toISOString());
    sqlite
      .prepare(
        `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(tokenHash, userId, 0, 4_000_000_000);
    const read = () =>
      worker.fetch(
        new Request('https://example.com/api/session', {
          headers: { cookie: `__Host-openzcad_session=${token}` }
        }),
        env
      );
    expect((await read()).status).toBe(200);
    // Spend the rest of this minute's 1,200 reads in one step.
    sqlite
      .prepare(
        `UPDATE auth_rate_limits SET request_count = 1200 WHERE bucket = ?`
      )
      .run(`api-read:${userId}`);
    expect((await read()).status).toBe(429);
  });
});
