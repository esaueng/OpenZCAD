import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  authenticateRequest,
  clearSessionCookie,
  createSessionCookie,
  generateLoginCode,
  getAuthConfig,
  hashLoginCode,
  identifyAssistantRequest,
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

async function verificationD1(code: string) {
  const challengeId = 'challenge-verification-test';
  const email = 'person@example.com';
  const secret = 'test-pepper';
  let consumedAt: number | null = null;
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
            attempts: 0,
            expires_at: Math.floor(Date.now() / 1000) + 600,
            consumed_at: consumedAt
          } as T;
        }
        return null;
      },
      async run() {
        if (
          query.includes('UPDATE auth_email_challenges') &&
          query.includes('SET consumed_at')
        ) {
          if (consumedAt !== null) {
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
      return Promise.all(statements.map((statement) => statement.run()));
    }
  };
  return { db, challengeId, email, secret };
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker authentication', () => {
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
});

describe('assistant request identity', () => {
  it('uses a stable opaque identity for public email-code requests', async () => {
    const env = {
      AUTH_MODE: 'email-code' as const,
      DB: emptyD1()
    };
    const request = new Request('https://example.com/api/assistant/proposals', {
      headers: { 'cf-connecting-ip': '203.0.113.42' }
    });

    const first = await identifyAssistantRequest(request, env);
    const second = await identifyAssistantRequest(request, env);

    expect(first).toBe(second);
    expect(first).toMatch(/^user_anon_[a-f0-9]{24}$/);
    expect(first).not.toContain('203.0.113.42');
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
        DB: emptyD1()
      })
    ).rejects.toThrow('session expired');
  });
});
