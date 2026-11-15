import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectObjectStorageError } from '@openzcad/persistence';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import worker from '../apps/web/worker/index';
import {
  REQUEST_LIMITS,
  SHARED_LOAD_CEILING_SOURCES,
  SHARED_LOAD_MAX_LOADS,
  SHARED_LOAD_SLACK,
  SHARED_LOAD_SOURCE_FACTOR,
  publicRequestBucket,
  purgeStaleRateLimitBuckets
} from '../apps/web/worker/apiRateLimit';
import { purgeExpiredAuthRows } from '../apps/web/worker/auth';
import { clientAddressKey } from '../apps/web/worker/clientAddress';
import { shareCapabilityPathname } from '../apps/web/worker/shareCapability';
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

/** A well-formed desktop sign-in start. */
function desktopStartBody(): string {
  return JSON.stringify({
    clientId: 'openzcad-macos',
    state: 's'.repeat(43),
    codeChallenge: 'c'.repeat(43)
  });
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
    ['/api/auth/desktop/start', 10],
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

/** A signed-in browser session for a fresh account on `sqlite`. */
async function signedIn(
  sqlite: ReturnType<typeof migratedDatabase>,
  userId = 'user_read_limit'
): Promise<{ userId: string; cookie: string }> {
  const token = `session-token-for-${userId}`;
  const tokenHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  sqlite
    .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
    .run(userId, `${userId}@example.com`, new Date().toISOString());
  sqlite
    .prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(tokenHash, userId, 0, 4_000_000_000);
  return { userId, cookie: `__Host-openzcad_session=${token}` };
}

/** A Workers rate-limit binding that answers `success` and records keys. */
function limiter(success: boolean) {
  return { limit: vi.fn(async (_: { key: string }) => ({ success })) };
}

describe('Workers rate-limit bindings', () => {
  it('refuse a sign-in verification before any D1 work when the binding says no', async () => {
    const { env, statements } = hostedEnv();
    const binding = limiter(false);
    const { body, state } = trackedBody('{}');
    const response = await worker.fetch(post('/api/auth/email/verify', body), {
      ...env,
      AUTH_REQUEST_LIMITER: binding
    });
    expect(response.status).toBe(429);
    expect(state.read).toBe(false);
    expect(statements).toEqual([]);
    expect(binding.limit.mock.calls[0]![0].key).toMatch(
      /^auth-verify:[0-9a-f]{64}$/
    );
  });

  it('refuse a desktop sign-in start before any D1 work when the binding says no', async () => {
    const { env, statements } = hostedEnv();
    const binding = limiter(false);
    const { body, state } = trackedBody(desktopStartBody());
    const response = await worker.fetch(post('/api/auth/desktop/start', body), {
      ...env,
      DESKTOP_START_LIMITER: binding
    });
    expect(response.status).toBe(429);
    expect(state.read).toBe(false);
    expect(statements).toEqual([]);
    expect(binding.limit.mock.calls[0]![0].key).toMatch(
      /^desktop-start:[0-9a-f]{64}$/
    );
  });

  it.each([
    `/api/share/${SHARE_TOKEN}`,
    `/api/share/${SHARE_TOKEN}/assets/asset-1`,
    `/api/share/${SHARE_TOKEN}/sources/source-1`
  ])(
    'refuse share-link reads past the ceiling before any D1 work (%s)',
    async (path) => {
      const { env, statements } = hostedEnv();
      const ceiling = limiter(false);
      const response = await worker.fetch(
        new Request(`https://example.com${path}`, {
          headers: { 'cf-connecting-ip': ADDRESS }
        }),
        { ...env, SHARE_READ_CEILING_LIMITER: ceiling }
      );
      expect(response.status).toBe(429);
      expect(statements).toEqual([]);
      expect(ceiling.limit).toHaveBeenCalledOnce();
    }
  );

  it('count in the binding alone while it admits, writing no D1 limiter row', async () => {
    const { env, statements } = hostedEnv();
    const response = await worker.fetch(
      post(
        '/api/auth/desktop/exchange',
        JSON.stringify({ attemptId: 'x', codeVerifier: 'y' })
      ),
      { ...env, DESKTOP_EXCHANGE_LIMITER: limiter(true) }
    );
    expect(response.status).not.toBe(429);
    expect(
      statements.filter((sql) => sql.includes('auth_rate_limits'))
    ).toEqual([]);
  });

  it('fall back to D1 when the binding is unavailable', async () => {
    fixMinute();
    const { env, sqlite } = hostedEnv();
    const broken = {
      limit: vi.fn(async () => {
        throw new Error('unavailable');
      })
    };
    const limitedEnv = { ...env, AUTH_REQUEST_LIMITER: broken };
    expect(
      (await worker.fetch(post('/api/auth/email/verify', '{}'), limitedEnv))
        .status
    ).not.toBe(429);
    spendAddressBudget(sqlite, 30);
    expect(
      (await worker.fetch(post('/api/auth/email/verify', '{}'), limitedEnv))
        .status
    ).toBe(429);
  });

  it('count signed-in reads per account before any route work', async () => {
    const { env, sqlite, statements } = hostedEnv();
    const { userId, cookie } = await signedIn(sqlite);
    const binding = limiter(false);
    statements.length = 0;
    const response = await worker.fetch(
      new Request('https://example.com/api/session', { headers: { cookie } }),
      { ...env, ACCOUNT_READ_LIMITER: binding }
    );
    expect(response.status).toBe(429);
    expect(binding.limit).toHaveBeenCalledWith({ key: `api-read:${userId}` });
    expect(
      statements.filter((sql) => sql.includes('auth_rate_limits'))
    ).toEqual([]);
  });

  it('match the limits each Wrangler configuration declares', () => {
    for (const path of ['wrangler.jsonc', 'wrangler.selfhost.example.jsonc']) {
      const parsed = ts.parseConfigFileTextToJson(
        path,
        readFileSync(path, 'utf8')
      );
      expect(parsed.error, path).toBeUndefined();
      const declared = new Map(
        (
          (parsed.config as { ratelimits?: RateLimitEntry[] }).ratelimits ?? []
        ).map((entry) => [entry.name, entry])
      );
      for (const [name, limit] of Object.entries(REQUEST_LIMITS)) {
        expect(declared.get(name)?.simple, `${path} ${name}`).toEqual({
          limit,
          period: 60
        });
      }
      const ids = [...declared.values()].map((entry) => entry.namespace_id);
      expect(new Set(ids).size, path).toBe(ids.length);
    }
  });
});

interface RateLimitEntry {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}

describe('D1 rate-limit accounting', () => {
  it('writes nothing for requests past the limit', async () => {
    fixMinute();
    const { env, sqlite, statements } = hostedEnv();
    await worker.fetch(post('/api/auth/email/verify', '{}'), env);
    spendAddressBudget(sqlite, 30);
    statements.length = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (await worker.fetch(post('/api/auth/email/verify', '{}'), env)).status
      ).toBe(429);
    }
    expect(
      sqlite.prepare('SELECT request_count FROM auth_rate_limits').all()
    ).toEqual([{ request_count: 30 }]);
    // One keyed statement per refused request, and no stale-row cleanup.
    expect(statements).toHaveLength(5);
    expect(statements.some((sql) => sql.includes('DELETE'))).toBe(false);
  });

  it('write nothing for desktop sign-in starts past the D1 allowance', async () => {
    fixMinute();
    const { env, sqlite, statements } = hostedEnv();
    // The Workers binding admits, so only the D1 allowance (20 per window)
    // speaks.
    const admitted = { ...env, DESKTOP_START_LIMITER: limiter(true) };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(
        (
          await worker.fetch(
            post('/api/auth/desktop/start', desktopStartBody()),
            admitted
          )
        ).status
      ).toBe(201);
    }
    statements.length = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refused = await worker.fetch(
        post('/api/auth/desktop/start', desktopStartBody()),
        admitted
      );
      expect(refused.status).toBe(429);
    }
    expect(
      sqlite.prepare('SELECT request_count FROM auth_rate_limits').all()
    ).toEqual([{ request_count: 20 }]);
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM desktop_auth_attempts')
        .get()
    ).toEqual({ count: 20 });
    // No cleanup and no attempt row once refused: the only write-shaped
    // statement is the counter upsert, which changed nothing above.
    const writes = statements.filter((sql) =>
      /^\s*(INSERT|UPDATE|DELETE)/.test(sql)
    );
    expect(writes).toHaveLength(5);
    expect(
      writes.every((sql) => sql.includes('INSERT INTO auth_rate_limits'))
    ).toBe(true);
  });

  it('leave expired sign-in rows to the scheduled purge', async () => {
    const { env, sqlite } = hostedEnv();
    const now = Math.floor(Date.parse('2026-11-13T10:00:10Z') / 1000);
    const insert = sqlite.prepare(
      `INSERT INTO desktop_auth_attempts
         (id, state_hash, code_challenge, client_id, created_at, expires_at)
       VALUES (?, 'state', 'challenge', 'openzcad-macos', ?, ?)`
    );
    for (let index = 0; index < 250; index += 1)
      insert.run(`expired-${index}`, now - 1_200, now - 600);
    insert.run('live', now - 60, now + 540);
    await purgeExpiredAuthRows(env, now);
    expect(
      sqlite
        .prepare('SELECT id FROM desktop_auth_attempts')
        .all()
        .map((row) => (row as { id: string }).id)
    ).toEqual(['live']);
  });

  it('leave stale windows to the scheduled purge', async () => {
    const { env, sqlite } = hostedEnv();
    const insert = sqlite.prepare(
      'INSERT INTO auth_rate_limits (bucket, window_start, request_count) VALUES (?, ?, ?)'
    );
    const now = Date.parse('2026-11-13T10:00:10Z');
    const minute = Math.floor(now / 60_000) * 60;
    for (let index = 0; index < 1_201; index += 1)
      insert.run(`stale-${index}`, minute - 3 * 60 * 60, 1);
    insert.run('login', minute - 15 * 60, 7);
    insert.run('project-invite-account:owner', minute - 90 * 60, 10);
    insert.run('current', minute, 1);
    await purgeStaleRateLimitBuckets(env, now);
    expect(
      sqlite
        .prepare('SELECT bucket FROM auth_rate_limits ORDER BY bucket')
        .all()
        .map((row) => (row as { bucket: string }).bucket)
    ).toEqual(['current', 'login', 'project-invite-account:owner']);
  });
});

describe('assistant status', () => {
  it('answers an anonymous caller with the deployment default and no D1 work', async () => {
    const { env, statements } = hostedEnv();
    const response = await worker.fetch(
      new Request('https://example.com/api/assistant/status', {
        headers: { 'cf-connecting-ip': ADDRESS }
      }),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: false,
      source: 'deployment',
      credential: { stored: false }
    });
    expect(statements).toEqual([]);
  });

  it("counts an account's status read against its read budget", async () => {
    fixMinute();
    const { env, sqlite } = hostedEnv();
    const { userId, cookie } = await signedIn(sqlite);
    const status = () =>
      worker.fetch(
        new Request('https://example.com/api/assistant/status', {
          headers: { cookie }
        }),
        env
      );
    expect((await status()).status).toBe(200);
    sqlite
      .prepare(
        `UPDATE auth_rate_limits SET request_count = 1200 WHERE bucket = ?`
      )
      .run(`api-read:${userId}`);
    expect((await status()).status).toBe(429);
  });
});

/** A shared document naming `count` distinct import sources. */
function sharedDocumentWithSources(count: number) {
  return {
    nodes: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `node_${index}`,
        {
          kind: 'feature',
          data: {
            featureKind: 'imported-step',
            stepSourceRef: { checksumSha256: String(index) },
            artifactId: `artifact_${index}`
          }
        }
      ])
    )
  };
}

describe('plaintext share-link loads', () => {
  function sharedLink(sources: number) {
    vi.spyOn(
      D1R2PersistenceService.prototype,
      'loadSharedProjectByTokenHash'
    ).mockResolvedValue({
      projectId: 'proj_shared',
      name: 'Shared',
      mode: 'view',
      document: sharedDocumentWithSources(sources) as never
    });
    vi.spyOn(
      D1R2PersistenceService.prototype,
      'loadSharedProjectImportSource'
    ).mockImplementation(async () => ({
      contentType: 'application/step',
      body: new Blob(['ISO-10303-21;']).stream()
    }));
  }
  const get = (
    env: ReturnType<typeof hostedEnv>['env'],
    path: string,
    address = ADDRESS
  ) =>
    worker.fetch(
      new Request(`https://example.com${path}`, {
        headers: {
          'cf-connecting-ip': address,
          'x-openzcad-share-token': SHARE_TOKEN
        }
      }),
      env
    );

  it('load a model with more sources than the address budget in one go', async () => {
    fixMinute();
    sharedLink(320);
    const { env } = hostedEnv();
    expect((await get(env, '/api/share')).status).toBe(200);
    for (let index = 0; index < 320; index += 1) {
      const response = await get(env, `/api/share/sources/artifact_${index}`);
      expect(response.status, `source ${index}`).toBe(200);
    }
  });

  it('admit the supported concurrent large-model loads under the share-read ceiling', () => {
    const perViewer =
      1 +
      SHARED_LOAD_CEILING_SOURCES * SHARED_LOAD_SOURCE_FACTOR +
      SHARED_LOAD_SLACK;
    expect(SHARED_LOAD_MAX_LOADS * perViewer).toBeLessThanOrEqual(
      REQUEST_LIMITS.SHARE_READ_CEILING_LIMITER
    );
  });

  it('load a large model through an active, counting ceiling binding', async () => {
    fixMinute();
    sharedLink(320);
    const { env } = hostedEnv();
    let used = 0;
    const ceiling = {
      limit: vi.fn(async () => ({
        success: ++used <= REQUEST_LIMITS.SHARE_READ_CEILING_LIMITER
      }))
    };
    const limitedEnv = { ...env, SHARE_READ_CEILING_LIMITER: ceiling };
    expect((await get(limitedEnv, '/api/share')).status).toBe(200);
    for (let index = 0; index < 320; index += 1) {
      const response = await get(
        limitedEnv,
        `/api/share/sources/artifact_${index}`
      );
      expect(response.status, `source ${index}`).toBe(200);
    }
    expect(ceiling.limit).toHaveBeenCalledTimes(321);
  });

  it('count reads past the load budget, or of a link never loaded, per address', async () => {
    fixMinute();
    sharedLink(2);
    const { env, sqlite } = hostedEnv();
    expect((await get(env, '/api/share')).status).toBe(200);
    // Two sources: a budget of 2 * 2 + 32 reads this minute.
    for (let index = 0; index < 36; index += 1) {
      expect((await get(env, '/api/share/sources/artifact_0')).status).toBe(
        200
      );
    }
    const address = (
      sqlite
        .prepare(
          "SELECT bucket, request_count FROM auth_rate_limits WHERE bucket LIKE 'share:%' AND bucket NOT LIKE '%:load:%'"
        )
        .all() as { bucket: string; request_count: number }[]
    )[0]!;
    // Only the document read reached the address budget so far.
    expect(address.request_count).toBe(1);
    expect((await get(env, '/api/share/sources/artifact_0')).status).toBe(200);
    sqlite
      .prepare(
        'UPDATE auth_rate_limits SET request_count = 300 WHERE bucket = ?'
      )
      .run(address.bucket);
    expect((await get(env, '/api/share/sources/artifact_0')).status).toBe(429);
    // Another address that never loaded the link has only its own budget.
    expect(
      (await get(env, '/api/share/sources/artifact_0', '203.0.113.10')).status
    ).toBe(200);
  });

  it('grow the grant with each load from one address, up to a cap', async () => {
    fixMinute();
    sharedLink(10);
    const { env, sqlite } = hostedEnv();
    const grant = () =>
      (
        sqlite
          .prepare(
            "SELECT request_count FROM auth_rate_limits WHERE bucket LIKE '%:grant'"
          )
          .get() as { request_count: number }
      ).request_count;
    await get(env, '/api/share');
    expect(grant()).toBe(52);
    await get(env, '/api/share');
    expect(grant()).toBe(104);
    for (let load = 0; load < 10; load += 1) await get(env, '/api/share');
    expect(grant()).toBe(52 * 8);
  });
});

describe('share-link reads with the token in a header', () => {
  it('serve the shared project exactly as the path form, with no token in the URL', async () => {
    const loaded = vi
      .spyOn(D1R2PersistenceService.prototype, 'loadSharedProjectByTokenHash')
      .mockResolvedValue(null);
    const { env } = hostedEnv();
    const headerForm = await worker.fetch(
      new Request('https://example.com/api/share', {
        headers: {
          'cf-connecting-ip': ADDRESS,
          'x-openzcad-share-token': SHARE_TOKEN
        }
      }),
      env
    );
    const pathForm = await worker.fetch(
      new Request(`https://example.com/api/share/${SHARE_TOKEN}`, {
        headers: { 'cf-connecting-ip': ADDRESS }
      }),
      env
    );
    expect(headerForm.status).toBe(404);
    expect(pathForm.status).toBe(404);
    expect(loaded).toHaveBeenCalledTimes(2);
    expect(loaded.mock.calls[0]![0]).toBe(loaded.mock.calls[1]![0]);
  });

  it.each(['/api/share', '/api/share/sources/source-1', '/api/e2ee/share'])(
    'answer %s without a usable token with the opaque 404',
    async (path) => {
      const loaded = vi.spyOn(
        D1R2PersistenceService.prototype,
        'loadSharedProjectByTokenHash'
      );
      const { env } = hostedEnv();
      for (const token of [undefined, 'a/../b', '']) {
        const response = await worker.fetch(
          new Request(`https://example.com${path}`, {
            headers: {
              'cf-connecting-ip': ADDRESS,
              ...(token === undefined
                ? {}
                : { 'x-openzcad-share-token': token })
            }
          }),
          env
        );
        expect(response.status).toBe(404);
      }
      expect(loaded).not.toHaveBeenCalled();
    }
  );

  it('maps only the token-free share routes', () => {
    const request = (method = 'GET') =>
      new Request('https://example.com/', {
        method,
        headers: { 'x-openzcad-share-token': 'tok_1' }
      });
    for (const [from, to] of [
      ['/api/share', '/api/share/tok_1'],
      ['/api/share/assets/a1', '/api/share/tok_1/assets/a1'],
      ['/api/share/sources/s1', '/api/share/tok_1/sources/s1'],
      ['/api/e2ee/share', '/api/e2ee/share/tok_1'],
      ['/api/e2ee/share/blobs/b1', '/api/e2ee/share/tok_1/blobs/b1'],
      ['/api/share/other/s1', '/api/share/other/s1'],
      ['/api/e2ee/share-delegation', '/api/e2ee/share-delegation'],
      ['/api/e2ee/share/blobs', '/api/e2ee/share/blobs'],
      ['/api/projects', '/api/projects']
    ] as const) {
      expect(shareCapabilityPathname(request(), from), from).toBe(to);
    }
    expect(shareCapabilityPathname(request('POST'), '/api/share')).toBe(
      '/api/share'
    );
  });
});

describe('client address keys', () => {
  it('key IPv6 by its /64 and IPv4 as is', () => {
    for (const [address, key] of [
      ['2001:db8:1:2:aaaa::1', '2001:db8:1:2::/64'],
      ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
      ['2001:0DB8:0001:0002::', '2001:db8:1:2::/64'],
      ['2001:db8:1:3::1', '2001:db8:1:3::/64'],
      ['fe80::1%eth0', 'fe80:0:0:0::/64'],
      ['::ffff:192.0.2.1', '192.0.2.1'],
      ['192.0.2.1', '192.0.2.1'],
      ['not::an::address', 'not::an::address'],
      ['', 'unknown']
    ] as const) {
      expect(clientAddressKey(address), address).toBe(key);
    }
    expect(clientAddressKey(null)).toBe('unknown');
  });

  it('give two addresses in one /64 one bucket, and another /64 its own', async () => {
    const env = { AUTH_OTP_PEPPER: 'test-pepper' };
    const bucket = (address: string) =>
      publicRequestBucket(
        new Request('https://example.com/', {
          headers: { 'cf-connecting-ip': address }
        }),
        env,
        'share'
      );
    const first = await bucket('2001:db8:1:2::1');
    expect(await bucket('2001:db8:1:2:dead:beef:0:1')).toBe(first);
    expect(await bucket('2001:db8:1:3::1')).not.toBe(first);
  });
});
