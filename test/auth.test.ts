import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toUserId } from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

import {
  assistantProviderIdentity,
  authenticateBrowserSession,
  authenticateRequest,
  clearSessionCookie,
  createSessionCookie,
  generateLoginCode,
  getAuthConfig,
  hashLoginCode,
  identifyAssistantRequest,
  loginEmail,
  normalizeEmail,
  startEmailLogin,
  verifyEmailLogin
} from '../apps/web/worker/auth';

function emptyD1(): D1Database {
  const statement = {
    bind() {
      return statement;
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
    async first() {
      return null;
    },
    async all() {
      return { results: [] };
    }
  };
  return {
    prepare() {
      return statement;
    },
    async batch() {
      return [];
    }
  };
}

async function verificationD1(
  code: string,
  options: { stallLegacyIncorrectUpdates?: boolean } = {}
) {
  const challengeId = 'challenge-verification-test';
  const email = 'person@example.com';
  const secret = 'test-pepper';
  let attempts = 0;
  let consumedAt: number | null = null;
  let incorrectUpdates = 0;
  const sessionHashes = new Set<string>();
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  let releaseLegacyIncorrectUpdates!: () => void;
  const legacyIncorrectUpdateGate = new Promise<void>((resolve) => {
    releaseLegacyIncorrectUpdates = resolve;
  });
  const codeHash = await hashLoginCode(challengeId, email, code, secret);

  function prepare(query: string): D1PreparedStatement {
    let values: unknown[] = [];
    const statement: D1PreparedStatement = {
      bind(...nextValues: unknown[]) {
        values = nextValues;
        return statement;
      },
      async first<T>() {
        if (query.includes('FROM auth_email_challenges')) {
          return {
            id: challengeId,
            email,
            code_hash: codeHash,
            attempts,
            expires_at: expiresAt,
            consumed_at: consumedAt
          } as T;
        }
        return null;
      },
      async run() {
        if (query.includes('INSERT INTO auth_sessions')) {
          if (
            consumedAt !== null ||
            attempts >= Number(values[6]) ||
            expiresAt < Number(values[7])
          ) {
            return { success: true, meta: { changes: 0 } };
          }
          sessionHashes.add(String(values[0]));
          return { success: true, meta: { changes: 1 } };
        }
        if (query.includes('SET attempts = attempts + 1')) {
          incorrectUpdates += 1;
          if (
            options.stallLegacyIncorrectUpdates &&
            !query.includes('AND attempts < ?')
          ) {
            await legacyIncorrectUpdateGate;
          }
          if (
            consumedAt !== null ||
            attempts >= Number(values[1]) ||
            expiresAt < Number(values[2])
          ) {
            return { success: true, meta: { changes: 0 } };
          }
          attempts += 1;
          return { success: true, meta: { changes: 1 } };
        }
        if (
          query.includes('UPDATE auth_email_challenges') &&
          query.includes('SET consumed_at')
        ) {
          if (
            consumedAt !== null ||
            (query.includes('FROM auth_sessions') &&
              !sessionHashes.has(String(values[2])))
          ) {
            return { success: true, meta: { changes: 0 } };
          }
          consumedAt = Number(values[0]);
        }
        return { success: true, meta: { changes: 1 } };
      },
      async all() {
        return { results: [] };
      }
    };
    return statement;
  }

  const db: D1Database = {
    prepare,
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
  return {
    db,
    challengeId,
    email,
    secret,
    attempts: () => attempts,
    consumedAt: () => consumedAt,
    incorrectUpdates: () => incorrectUpdates,
    releaseLegacyIncorrectUpdates
  };
}

function loginStartD1() {
  const rates = new Map<string, number>();
  let challenge:
    | {
        id: string;
        email: string;
        codeHash: string;
        expiresAt: number;
      }
    | undefined;

  function prepare(query: string): D1PreparedStatement {
    let values: unknown[] = [];
    const statement: D1PreparedStatement = {
      bind(...nextValues: unknown[]) {
        values = nextValues;
        return statement;
      },
      async first<T>() {
        if (query.includes('SELECT request_count')) {
          return {
            request_count: rates.get(String(values[0])) ?? 0
          } as T;
        }
        return null;
      },
      async run() {
        if (query.includes('INSERT INTO auth_rate_limits')) {
          const bucket = String(values[0]);
          rates.set(bucket, (rates.get(bucket) ?? 0) + 1);
        }
        if (query.includes('INSERT INTO auth_email_challenges')) {
          challenge = {
            id: String(values[0]),
            email: String(values[1]),
            codeHash: String(values[2]),
            expiresAt: Number(values[4])
          };
        }
        return { success: true, meta: { changes: 1 } };
      },
      async all() {
        return { results: [] };
      }
    };
    return statement;
  }

  const db: D1Database = {
    prepare,
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    }
  };
  return { db, challenge: () => challenge };
}

/**
 * Real sign-in code flow for one email on migrated SQLite, with Turnstile
 * and the email binding stubbed. `start(ip)` requests a code from that
 * address; `sent` holds every emailed code in order.
 */
function signInHarness(email = 'person@example.com') {
  const sent: string[] = [];
  const env = {
    ENVIRONMENT: 'beta' as const,
    AUTH_MODE: 'email-code' as const,
    DB: sqliteD1(migratedDatabase()),
    EMAIL: {
      send: async (message: EmailMessageBuilder) => {
        sent.push(message.subject.slice(0, 6));
        return { messageId: `message-${sent.length}` };
      }
    },
    AUTH_EMAIL_FROM: 'login@auth.example.com',
    AUTH_OTP_PEPPER: 'test-pepper',
    TURNSTILE_SITE_KEY: 'site-key',
    TURNSTILE_SECRET_KEY: 'turnstile-secret'
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        success: true,
        action: 'email-code',
        hostname: 'example.com'
      })
    )
  );
  const start = (ip: string) =>
    startEmailLogin(
      new Request('https://example.com/api/auth/email/start', {
        headers: { 'cf-connecting-ip': ip }
      }),
      { email, turnstileToken: 'turnstile-token' },
      env
    );
  const verify = (challengeId: string, code: string) =>
    verifyEmailLogin({ challengeId, code }, env);
  return { env, sent, start, verify };
}

function wrongCode(code: string): string {
  return code === '000000' ? '000001' : '000000';
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker authentication', () => {
  it('requires email-code configuration for browser session authorization', async () => {
    for (const env of [
      {
        ENVIRONMENT: 'development' as const,
        AUTH_MODE: 'development' as const
      },
      { ENVIRONMENT: 'beta' as const, AUTH_MODE: 'development' as const },
      { ENVIRONMENT: 'beta' as const, AUTH_MODE: 'email-code' as const },
      { ENVIRONMENT: 'beta' as const }
    ]) {
      await expect(
        authenticateBrowserSession(new Request('https://example.com'), env)
      ).rejects.toMatchObject({ failure: 'configuration' });
    }
  });

  it('allows explicit development authentication only in development', async () => {
    await expect(
      authenticateRequest(new Request('https://example.com'), {
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'development'
      })
    ).rejects.toThrow(/disabled/);

    await expect(
      authenticateRequest(new Request('https://example.com'), {
        ENVIRONMENT: 'development',
        AUTH_MODE: 'development'
      })
    ).resolves.toMatchObject({
      userId: 'user_beta_dev',
      mode: 'development'
    });
  });

  it('fails closed when the authentication mode is absent', async () => {
    await expect(
      authenticateRequest(new Request('https://example.com'), {
        ENVIRONMENT: 'beta'
      })
    ).rejects.toThrow(/not configured/);
  });

  it('requires a valid email-code session cookie', async () => {
    await expect(
      authenticateRequest(new Request('https://example.com'), {
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'email-code',
        DB: emptyD1()
      })
    ).rejects.toThrow('Authentication required.');

    await expect(
      authenticateRequest(
        new Request('https://example.com', {
          headers: {
            cookie: '__Host-openzcad_session=expired-session-token'
          }
        }),
        {
          ENVIRONMENT: 'beta',
          AUTH_MODE: 'email-code',
          DB: emptyD1()
        }
      )
    ).rejects.toThrow('session expired');
  });

  it('publishes email login only when every server binding is ready', () => {
    expect(
      getAuthConfig({
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'email-code',
        DB: emptyD1(),
        EMAIL: { send: async () => ({ messageId: 'message-test' }) },
        AUTH_EMAIL_FROM: 'login@auth.example.com',
        AUTH_OTP_PEPPER: 'test-pepper',
        TURNSTILE_SITE_KEY: 'site-key',
        TURNSTILE_SECRET_KEY: 'secret-key'
      })
    ).toEqual({
      mode: 'email-code',
      emailCodeEnabled: true,
      turnstileSiteKey: 'site-key'
    });

    expect(
      getAuthConfig({
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'email-code',
        DB: emptyD1()
      })
    ).toMatchObject({
      mode: 'email-code',
      emailCodeEnabled: false
    });
  });

  it('normalizes email and protects low-entropy codes with an HMAC', async () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com');
    expect(() => normalizeEmail('not-an-email')).toThrow('valid email');

    const first = await hashLoginCode(
      'challenge-1',
      'person@example.com',
      '123456',
      'test-secret'
    );
    const second = await hashLoginCode(
      'challenge-1',
      'person@example.com',
      '123456',
      'test-secret'
    );
    expect(first).toBe(second);
    expect(first).not.toContain('123456');
    expect(generateLoginCode()).toMatch(/^\d{6}$/);
  });

  it('issues host-only secure session cookies and clears them symmetrically', () => {
    expect(createSessionCookie('opaque-token', 3600)).toBe(
      '__Host-openzcad_session=opaque-token; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600'
    );
    expect(clearSessionCookie()).toBe(
      '__Host-openzcad_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    );
  });

  it('validates Turnstile and sends a single-use code through the email binding', async () => {
    const fixture = loginStartD1();
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({
      messageId: 'message-e2e'
    }));
    const turnstile = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        expect(body.get('secret')).toBe('turnstile-secret');
        expect(body.get('response')).toBe('turnstile-token');
        expect(body.get('remoteip')).toBe('203.0.113.42');
        return Response.json({
          success: true,
          action: 'email-code',
          hostname: 'example.com'
        });
      }
    );
    vi.stubGlobal('fetch', turnstile);

    const result = await startEmailLogin(
      new Request('https://example.com/api/auth/email/start', {
        headers: { 'cf-connecting-ip': '203.0.113.42' }
      }),
      {
        email: ' Person@Example.COM ',
        turnstileToken: 'turnstile-token'
      },
      {
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'email-code',
        DB: fixture.db,
        EMAIL: { send },
        AUTH_EMAIL_FROM: 'login@auth.example.com',
        AUTH_OTP_PEPPER: 'test-pepper',
        TURNSTILE_SITE_KEY: 'site-key',
        TURNSTILE_SECRET_KEY: 'turnstile-secret'
      }
    );

    expect(turnstile).toHaveBeenCalledOnce();
    expect(result.challengeId).toBe(fixture.challenge()?.id);
    expect(result.expiresInSeconds).toBe(600);
    expect(fixture.challenge()).toMatchObject({
      email: 'person@example.com'
    });
    expect(fixture.challenge()?.codeHash).not.toMatch(/^\d{6}$/);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: 'person@example.com',
      from: { email: 'login@auth.example.com', name: 'OpenZCAD' }
    });
    expect(send.mock.calls[0]?.[0].subject).toMatch(
      /^\d{6} is your OpenZCAD sign-in code$/
    );
  });

  it('reports an unavailable security check when siteverify is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream unavailable', { status: 502 }))
    );

    await expect(
      startEmailLogin(
        new Request('https://example.com/api/auth/email/start'),
        {
          email: 'person@example.com',
          turnstileToken: 'turnstile-token'
        },
        {
          ENVIRONMENT: 'beta',
          AUTH_MODE: 'email-code',
          DB: emptyD1(),
          EMAIL: { send: async () => ({ messageId: 'message-test' }) },
          AUTH_EMAIL_FROM: 'login@auth.example.com',
          AUTH_OTP_PEPPER: 'test-pepper',
          TURNSTILE_SITE_KEY: 'site-key',
          TURNSTILE_SECRET_KEY: 'turnstile-secret'
        }
      )
    ).rejects.toMatchObject({
      status: 503,
      code: 'AUTH_CHALLENGE_UNAVAILABLE',
      message: 'The security check is temporarily unavailable.'
    });
  });

  it('pins the Turnstile hostname outside explicit development', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: true,
          action: 'email-code',
          hostname: 'attacker.example'
        })
      )
    );

    await expect(
      startEmailLogin(
        new Request('https://example.com/api/auth/email/start'),
        {
          email: 'person@example.com',
          turnstileToken: 'turnstile-token'
        },
        {
          AUTH_MODE: 'email-code',
          DB: emptyD1(),
          EMAIL: { send: async () => ({ messageId: 'message-test' }) },
          AUTH_EMAIL_FROM: 'login@auth.example.com',
          AUTH_OTP_PEPPER: 'test-pepper',
          TURNSTILE_SITE_KEY: 'site-key',
          TURNSTILE_SECRET_KEY: 'turnstile-secret'
        }
      )
    ).rejects.toMatchObject({
      status: 400,
      code: 'AUTH_CHALLENGE_INVALID'
    });
  });

  it('consumes an email code once and creates an opaque authenticated session', async () => {
    const fixture = await verificationD1('123456');
    const env = {
      ENVIRONMENT: 'beta' as const,
      AUTH_MODE: 'email-code' as const,
      DB: fixture.db,
      EMAIL: { send: async () => ({ messageId: 'message-test' }) },
      AUTH_EMAIL_FROM: 'login@auth.example.com',
      AUTH_OTP_PEPPER: fixture.secret,
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key'
    };

    const result = await verifyEmailLogin(
      { challengeId: fixture.challengeId, code: '123456' },
      env
    );
    expect(result.session).toMatchObject({
      email: fixture.email,
      displayName: 'person',
      mode: 'email-code'
    });
    expect(result.cookie).toMatch(
      /^__Host-openzcad_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure;/
    );

    await expect(
      verifyEmailLogin(
        { challengeId: fixture.challengeId, code: '123456' },
        env
      )
    ).rejects.toThrow('invalid or expired');
  });

  it('consumes an email code whose verification straddles a second boundary', async () => {
    const fixture = await verificationD1('123456');
    const env = {
      ENVIRONMENT: 'beta' as const,
      AUTH_MODE: 'email-code' as const,
      DB: fixture.db,
      EMAIL: { send: async () => ({ messageId: 'message-test' }) },
      AUTH_EMAIL_FROM: 'login@auth.example.com',
      AUTH_OTP_PEPPER: fixture.secret,
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key'
    };
    // The request's timestamp is read at x.999 s and everything after it at
    // the next second, as when hashing runs across a boundary on a loaded
    // runner. The unexpired challenge must still be consumed.
    const second = Math.floor(Date.now() / 1000) * 1000;
    let reads = 0;
    const now = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => second + (reads++ === 0 ? 999 : 1001));
    try {
      const result = await verifyEmailLogin(
        { challengeId: fixture.challengeId, code: '123456' },
        env
      );
      expect(result.session).toMatchObject({ email: fixture.email });
    } finally {
      now.mockRestore();
    }
    expect(fixture.consumedAt()).not.toBeNull();
  });

  it('serializes OTP failures with successful consumption at the attempt limit', async () => {
    const fixture = await verificationD1('123456', {
      stallLegacyIncorrectUpdates: true
    });
    const env = {
      ENVIRONMENT: 'beta' as const,
      AUTH_MODE: 'email-code' as const,
      DB: fixture.db,
      EMAIL: { send: async () => ({ messageId: 'message-test' }) },
      AUTH_EMAIL_FROM: 'login@auth.example.com',
      AUTH_OTP_PEPPER: fixture.secret,
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key'
    };
    const wrongCodes = [
      '000000',
      '000001',
      '000002',
      '000003',
      '000004',
      '000005'
    ];
    const wrongAttempts = Promise.allSettled(
      wrongCodes.map((code) =>
        verifyEmailLogin({ challengeId: fixture.challengeId, code }, env)
      )
    );

    try {
      await vi.waitFor(() => {
        expect(fixture.incorrectUpdates()).toBe(wrongCodes.length);
      });
      await expect(
        verifyEmailLogin(
          { challengeId: fixture.challengeId, code: '123456' },
          env
        )
      ).rejects.toMatchObject({
        status: 429,
        code: 'AUTH_CODE_LOCKED'
      });
    } finally {
      fixture.releaseLegacyIncorrectUpdates();
    }

    const failures = await wrongAttempts;
    expect(failures.every((result) => result.status === 'rejected')).toBe(true);
    expect(fixture.attempts()).toBe(5);
    expect(fixture.consumedAt()).toBeNull();
  });
});

// SEC-3 (project review, 14 October 2026): one shared per-email request
// limit, and every new request voiding the pending code, let anyone who knew
// an address keep that account from signing in with ~3 Turnstile solves per
// 15 minutes.
describe('sign-in cannot be denied by someone who only knows the email', () => {
  async function reachFailureLimit(
    harness: ReturnType<typeof signInHarness>
  ): Promise<void> {
    for (let host = 1; host <= 4; host += 1) {
      const challenge = await harness.start(`203.0.113.${host}`);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          harness.verify(challenge.challengeId, wrongCode(harness.sent.at(-1)!))
        ).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
      }
    }
  }

  it("keeps the victim's pending code valid when someone else requests one", async () => {
    const { sent, start, verify } = signInHarness();
    const victim = await start('198.51.100.7');
    const victimCode = sent.at(-1)!;

    await start('203.0.113.1');

    await expect(verify(victim.challengeId, victimCode)).resolves.toMatchObject(
      { session: { email: 'person@example.com' } }
    );
  });

  it('sends the victim a code after three requests from other addresses', async () => {
    const { sent, start, verify } = signInHarness();
    await start('203.0.113.1');
    await start('203.0.113.2');
    await start('203.0.113.3');

    const victim = await start('198.51.100.7');

    expect(victim.expiresInSeconds).toBe(600);
    expect(sent).toHaveLength(4);
    await expect(verify(victim.challengeId, sent[3]!)).resolves.toMatchObject({
      session: { email: 'person@example.com' }
    });
  });

  it("answers a requester's throttled repeat with its pending code and sends nothing", async () => {
    const { sent, start, verify } = signInHarness();
    await start('198.51.100.7');
    await start('198.51.100.7');
    const third = await start('198.51.100.7');

    const repeat = await start('198.51.100.7');

    expect(sent).toHaveLength(3);
    expect(repeat.challengeId).toBe(third.challengeId);
    expect(repeat.expiresInSeconds).toBeGreaterThan(0);
    expect(repeat.expiresInSeconds).toBeLessThanOrEqual(600);
    await expect(verify(repeat.challengeId, sent[2]!)).resolves.toMatchObject({
      session: { email: 'person@example.com' }
    });
  });

  it('resumes an earlier usable code when the newest code has spent its one try', async () => {
    const harness = signInHarness();
    const { sent, start, verify } = harness;
    await reachFailureLimit(harness);
    await start('198.51.100.7');
    const usable = await start('198.51.100.7');
    const usableCode = sent.at(-1)!;
    const locked = await start('198.51.100.7');
    await expect(
      verify(locked.challengeId, wrongCode(sent.at(-1)!))
    ).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });

    const sentCount = sent.length;
    const repeat = await start('198.51.100.7');

    expect(sent).toHaveLength(sentCount);
    expect(repeat.challengeId).toBe(usable.challengeId);
    await expect(verify(repeat.challengeId, usableCode)).resolves.toMatchObject(
      {
        session: { email: 'person@example.com' }
      }
    );
  });

  it('returns no spent one-try challenge when a requester has no usable code left', async () => {
    const harness = signInHarness();
    const { sent, start, verify } = harness;
    await reachFailureLimit(harness);
    const spent = [];
    for (let request = 0; request < 3; request += 1) {
      const challenge = await start('198.51.100.7');
      spent.push(challenge.challengeId);
      await expect(
        verify(challenge.challengeId, wrongCode(sent.at(-1)!))
      ).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
    }

    const sentCount = sent.length;
    const repeat = await start('198.51.100.7');

    expect(sent).toHaveLength(sentCount);
    expect(spent).not.toContain(repeat.challengeId);
    await expect(
      verify(repeat.challengeId, sent.at(-1)!)
    ).rejects.toMatchObject({
      code: 'AUTH_CODE_INVALID'
    });
  });

  it('caps codes per email across requesters without a refusal', async () => {
    const { sent, start, verify } = signInHarness();
    for (let host = 1; host <= 10; host += 1) {
      await start(`203.0.113.${host}`);
    }
    expect(sent).toHaveLength(10);

    const capped = await start('198.51.100.7');

    expect(sent).toHaveLength(10);
    expect(capped.expiresInSeconds).toBe(600);
    await expect(verify(capped.challengeId, sent[9]!)).rejects.toMatchObject({
      code: 'AUTH_CODE_INVALID'
    });
  });

  it("cancels every one of the email's pending codes on a successful sign-in", async () => {
    const { sent, start, verify } = signInHarness();
    const first = await start('198.51.100.7');
    const second = await start('203.0.113.1');

    await verify(first.challengeId, sent[0]!);

    await expect(verify(second.challengeId, sent[1]!)).rejects.toMatchObject({
      code: 'AUTH_CODE_INVALID'
    });
  });

  it('permits only one session when sibling verifications overlap', async () => {
    const { env, sent, start, verify } = signInHarness();
    const first = await start('198.51.100.7');
    const second = await start('203.0.113.1');
    const batch = env.DB.batch.bind(env.DB);
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Stop the first sign-in just before its session transaction. On the
    // regressed implementation its individual code was already consumed.
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
      entered();
      await gate;
      return batch(statements);
    });
    const pending = verify(first.challengeId, sent[0]!);
    const firstOutcome = expect(pending).rejects.toMatchObject({
      code: 'AUTH_CODE_INVALID'
    });
    await waiting;
    try {
      await expect(
        verify(second.challengeId, sent[1]!)
      ).resolves.toHaveProperty('cookie');
    } finally {
      release();
    }
    await firstOutcome;
    const sessions = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM auth_sessions'
    ).first<{ count: number }>();
    expect(sessions?.count).toBe(1);
  });

  it('consumes a code once when the same correct verification arrives concurrently', async () => {
    const { env, sent, start, verify } = signInHarness();
    const challenge = await start('198.51.100.7');
    const outcomes = await Promise.allSettled([
      verify(challenge.challengeId, sent[0]!),
      verify(challenge.challengeId, sent[0]!)
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled')
    ).toHaveLength(1);
    const rejected = outcomes.filter(
      (outcome) => outcome.status === 'rejected'
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: 'AUTH_CODE_INVALID' }
    });
    const sessions = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM auth_sessions'
    ).first<{ count: number }>();
    expect(sessions?.count).toBe(1);
  });

  it('leaves every code usable if the session transaction rolls back', async () => {
    const { env, sent, start, verify } = signInHarness();
    const first = await start('198.51.100.7');
    const second = await start('203.0.113.1');
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, 'batch').mockImplementationOnce((statements) =>
      batch([...statements, env.DB.prepare('SELECT * FROM missing_auth_table')])
    );

    await expect(verify(first.challengeId, sent[0]!)).rejects.toThrow(
      'no such table'
    );
    const pending = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM auth_email_challenges WHERE consumed_at IS NULL'
    ).first<{ count: number }>();
    const sessions = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM auth_sessions'
    ).first<{ count: number }>();
    expect(pending?.count).toBe(2);
    expect(sessions?.count).toBe(0);
    await expect(verify(second.challengeId, sent[1]!)).resolves.toHaveProperty(
      'cookie'
    );
  });

  it('allows one try per code after a day of failed codes, without locking out', async () => {
    const { sent, start, verify } = signInHarness();
    let clock = Date.parse('2026-10-14T08:00:00Z');
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      // Twenty wrong codes: four codes, five failures each.
      for (let host = 1; host <= 4; host += 1) {
        const { challengeId } = await start(`203.0.113.${host}`);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await expect(
            verify(challengeId, wrongCode(sent.at(-1)!))
          ).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
        }
      }

      // An hour later every one of those codes has expired, and the
      // failures still count.
      clock += 60 * 60 * 1000;
      const oneTry = await start('198.51.100.7');
      const oneTryCode = sent.at(-1)!;
      await expect(
        verify(oneTry.challengeId, wrongCode(oneTryCode))
      ).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
      await expect(
        verify(oneTry.challengeId, oneTryCode)
      ).rejects.toMatchObject({ status: 429, code: 'AUTH_CODE_LOCKED' });

      // The owner still signs in with a code entered correctly first time.
      const owner = await start('198.51.100.8');
      await expect(
        verify(owner.challengeId, sent.at(-1)!)
      ).resolves.toMatchObject({ session: { email: 'person@example.com' } });

      // A day after those failures every code gets five tries again.
      clock += 24 * 60 * 60 * 1000;
      const nextDay = await start('198.51.100.7');
      const nextDayCode = sent.at(-1)!;
      await expect(
        verify(nextDay.challengeId, wrongCode(nextDayCode))
      ).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
      await expect(
        verify(nextDay.challengeId, nextDayCode)
      ).resolves.toMatchObject({ session: { email: 'person@example.com' } });
    } finally {
      now.mockRestore();
    }
  });
});

describe('sign-in code email', () => {
  it('keeps the code one copyable run of digits in every part', () => {
    const message = loginEmail('730418');

    expect(message.subject).toBe('730418 is your OpenZCAD sign-in code');
    expect(message.text.split('\n')).toContain('730418');
    // Spacing comes from letter-spacing, so a copy yields only the digits;
    // one click selects the whole code where user-select is honoured.
    expect(message.html).toMatch(/user-select:all[^>]*>730418<\/div>/);
    expect(message.text).toContain('expires in 10 minutes and works once');
  });

  it('declares both colour schemes and overrides for dark mode', () => {
    const { html } = loginEmail('730418');

    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toMatch(
      /@media \(prefers-color-scheme:dark\)\{[^}]*\.oz-page\{background:#16181b/
    );
    expect(html).not.toMatch(/<img|<svg/);
  });
});

describe('assistant request identity', () => {
  it('uses a stable opaque identity for public email-code requests', async () => {
    const env = {
      AUTH_MODE: 'email-code' as const,
      DB: emptyD1(),
      AI_IDENTITY_PEPPER: 'identity-test-pepper'
    };
    const request = new Request('https://example.com/api/assistant/proposals', {
      headers: { 'cf-connecting-ip': '203.0.113.42' }
    });

    const first = await identifyAssistantRequest(request, env);
    const second = await identifyAssistantRequest(request, env);

    expect(first).toBe(second);
    expect(first).toMatch(/^user_anon_[a-f0-9]{24}$/);
    expect(first).not.toContain('203.0.113.42');
    await expect(
      identifyAssistantRequest(request, {
        ...env,
        AI_IDENTITY_PEPPER: 'different-pepper'
      })
    ).resolves.not.toBe(first);
  });

  it('fails closed when the public assistant identity pepper is absent', async () => {
    await expect(
      identifyAssistantRequest(
        new Request('https://example.com/api/assistant/proposals', {
          headers: { 'cf-connecting-ip': '203.0.113.42' }
        }),
        {
          AUTH_MODE: 'email-code',
          DB: emptyD1()
        }
      )
    ).rejects.toMatchObject({
      status: 503,
      code: 'AI_IDENTITY_UNAVAILABLE'
    });
  });

  it('hands providers a peppered pseudonym, never the email-derived account id', async () => {
    const fixture = await verificationD1('123456');
    const env = {
      ENVIRONMENT: 'beta' as const,
      AUTH_MODE: 'email-code' as const,
      DB: fixture.db,
      EMAIL: { send: async () => ({ messageId: 'message-test' }) },
      AUTH_EMAIL_FROM: 'login@auth.example.com',
      AUTH_OTP_PEPPER: fixture.secret,
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
      AI_IDENTITY_PEPPER: 'identity-test-pepper'
    };
    const { session } = await verifyEmailLogin(
      { challengeId: fixture.challengeId, code: '123456' },
      env
    );
    const emailHash = createHash('sha256')
      .update(fixture.email)
      .digest('hex')
      .slice(0, 24);
    // The account id itself is unchanged: projects and quotas are keyed by it.
    expect(session.userId).toBe(`user_${emailHash}`);

    // It used to reach the provider as-is, so anyone with provider logs could
    // confirm an address by hashing it.
    const sent = await assistantProviderIdentity(session.userId, env);
    expect(sent).toMatch(/^user_ai_[a-f0-9]{24}$/);
    expect(sent).not.toContain(emailHash);
    await expect(assistantProviderIdentity(session.userId, env)).resolves.toBe(
      sent
    );
    await expect(
      assistantProviderIdentity(session.userId, {
        ...env,
        AI_IDENTITY_PEPPER: 'different-pepper'
      })
    ).resolves.not.toBe(sent);
  });

  it('fails closed without the pepper for signed-in email-code identities', async () => {
    await expect(
      assistantProviderIdentity(toUserId('user_signed_in'), {
        AUTH_MODE: 'email-code',
        DB: emptyD1()
      })
    ).rejects.toMatchObject({
      status: 503,
      code: 'AI_IDENTITY_UNAVAILABLE'
    });
    // Development identities are not derived from an email address.
    await expect(
      assistantProviderIdentity(toUserId('user_beta_dev'), {
        AUTH_MODE: 'development'
      })
    ).resolves.toBe('user_beta_dev');
  });

  it('does not downgrade an invalid session cookie to public identity', async () => {
    const request = new Request('https://example.com/api/assistant/proposals', {
      headers: {
        cookie: '__Host-openzcad_session=invalid',
        'cf-connecting-ip': '203.0.113.42'
      }
    });

    await expect(
      identifyAssistantRequest(request, {
        AUTH_MODE: 'email-code',
        DB: emptyD1(),
        AI_IDENTITY_PEPPER: 'identity-test-pepper'
      })
    ).rejects.toThrow('session expired');
  });
});
