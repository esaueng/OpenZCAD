import { describe, expect, it } from 'vitest';
import { toUserId, type AuthSession } from '@openzcad/shared';
import {
  approveDesktopAuthorization,
  authenticateRequest,
  exchangeDesktopAuthorization,
  refreshDesktopAuthorization,
  startDesktopAuthorization
} from '../apps/web/worker/auth';

interface AttemptRow {
  id: string;
  state_hash: string;
  code_challenge: string;
  client_id: string;
  user_id: string | null;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  exchanged_at: number | null;
}

interface TokenRow {
  token_hash: string;
  session_id: string;
  user_id: string;
  client_id: string;
  created_at: number;
  expires_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

function desktopAuthD1(user: AuthSession) {
  const attempts = new Map<string, AttemptRow>();
  const access = new Map<string, TokenRow>();
  const refresh = new Map<string, TokenRow>();
  const rates = new Map<string, number>();
  const users = new Map([[user.userId, user.email!]]);

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
        if (
          query.includes("name IN (\n              'desktop_auth_attempts'")
        ) {
          return { tables: 3, indexes: 6 } as T;
        }
        if (query.includes('FROM desktop_auth_attempts a')) {
          const row = attempts.get(String(values[0]));
          return (
            row
              ? { ...row, email: row.user_id ? users.get(row.user_id) : null }
              : null
          ) as T;
        }
        if (query.includes('FROM desktop_access_tokens t')) {
          const row = access.get(String(values[0]));
          return (
            row ? { ...row, email: users.get(row.user_id) ?? null } : null
          ) as T;
        }
        if (query.includes('FROM desktop_refresh_tokens t')) {
          const row = refresh.get(String(values[0]));
          return (
            row ? { ...row, email: users.get(row.user_id) ?? null } : null
          ) as T;
        }
        if (query.includes('SELECT session_id FROM desktop_access_tokens')) {
          const row = access.get(String(values[0]));
          return (row ? { session_id: row.session_id } : null) as T;
        }
        return null;
      },
      async run() {
        let changes = 0;
        if (query.includes('INSERT INTO auth_rate_limits')) {
          const bucket = String(values[0]);
          rates.set(bucket, (rates.get(bucket) ?? 0) + 1);
          changes = 1;
        } else if (query.includes('INSERT INTO desktop_auth_attempts')) {
          const [id, stateHash, challenge, clientId, createdAt, expiresAt] =
            values;
          attempts.set(String(id), {
            id: String(id),
            state_hash: String(stateHash),
            code_challenge: String(challenge),
            client_id: String(clientId),
            user_id: null,
            created_at: Number(createdAt),
            expires_at: Number(expiresAt),
            approved_at: null,
            exchanged_at: null
          });
          changes = 1;
        } else if (
          query.includes('UPDATE desktop_auth_attempts') &&
          query.includes('SET user_id')
        ) {
          const [userId, approvedAt, id, timestamp, expectedUserId] = values;
          const row = attempts.get(String(id));
          if (
            row &&
            row.expires_at >= Number(timestamp) &&
            row.exchanged_at === null &&
            (row.user_id === null || row.user_id === String(expectedUserId))
          ) {
            row.user_id = String(userId);
            row.approved_at = Number(approvedAt);
            changes = 1;
          }
        } else if (
          query.includes('UPDATE desktop_auth_attempts') &&
          query.includes('SET exchanged_at')
        ) {
          const [exchangedAt, id] = values;
          const row = attempts.get(String(id));
          if (row && row.exchanged_at === null && row.approved_at !== null) {
            row.exchanged_at = Number(exchangedAt);
            changes = 1;
          }
        } else if (query.includes('INSERT INTO desktop_access_tokens')) {
          const [hash, sessionId, userId, clientId, createdAt, expiresAt] =
            values;
          access.set(String(hash), {
            token_hash: String(hash),
            session_id: String(sessionId),
            user_id: String(userId),
            client_id: String(clientId),
            created_at: Number(createdAt),
            expires_at: Number(expiresAt),
            rotated_at: null,
            revoked_at: null
          });
          changes = 1;
        } else if (query.includes('INSERT INTO desktop_refresh_tokens')) {
          const [hash, sessionId, userId, clientId, createdAt, expiresAt] =
            values;
          refresh.set(String(hash), {
            token_hash: String(hash),
            session_id: String(sessionId),
            user_id: String(userId),
            client_id: String(clientId),
            created_at: Number(createdAt),
            expires_at: Number(expiresAt),
            rotated_at: null,
            revoked_at: null
          });
          changes = 1;
        } else if (
          query.includes('UPDATE desktop_refresh_tokens') &&
          query.includes('SET rotated_at')
        ) {
          const [rotatedAt, revokedAt, hash] = values;
          const row = refresh.get(String(hash));
          if (row && row.rotated_at === null && row.revoked_at === null) {
            row.rotated_at = Number(rotatedAt);
            row.revoked_at = Number(revokedAt);
            changes = 1;
          }
        } else if (
          query.includes('UPDATE desktop_access_tokens') &&
          query.includes('WHERE session_id')
        ) {
          const [revokedAt, sessionId] = values;
          for (const row of access.values()) {
            if (row.session_id === sessionId) {
              row.revoked_at ??= Number(revokedAt);
              changes += 1;
            }
          }
        } else if (
          query.includes('UPDATE desktop_refresh_tokens') &&
          query.includes('WHERE session_id')
        ) {
          const [revokedAt, sessionId] = values;
          for (const row of refresh.values()) {
            if (row.session_id === sessionId) {
              row.revoked_at ??= Number(revokedAt);
              changes += 1;
            }
          }
        }
        return { success: true, meta: { changes } };
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
  return { db };
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

describe('desktop authorization', () => {
  it('binds a browser approval to PKCE and rotates refresh credentials', async () => {
    const session: AuthSession = {
      userId: toUserId('user_desktop_test'),
      displayName: 'person',
      email: 'person@example.com',
      mode: 'email-code'
    };
    const fixture = desktopAuthD1(session);
    const env = {
      ENVIRONMENT: 'beta' as const,
      AUTH_MODE: 'email-code' as const,
      DESKTOP_AUTH_ENABLED: 'true',
      DB: fixture.db,
      EMAIL: { send: async () => ({ messageId: 'unused' }) },
      AUTH_EMAIL_FROM: 'login@auth.example.com',
      AUTH_OTP_PEPPER: 'test-pepper',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'turnstile-secret'
    };
    const state = 's'.repeat(43);
    const verifier = 'v'.repeat(43);
    const started = await startDesktopAuthorization(
      new Request('https://zcad.esau.app/api/auth/desktop/start'),
      {
        clientId: 'openzcad-macos',
        state,
        codeChallenge: await codeChallenge(verifier)
      },
      env
    );
    expect(started.browserUrl).toBe(
      `https://zcad.esau.app/?desktopAuth=${started.attemptId}`
    );
    await expect(
      exchangeDesktopAuthorization(
        {
          attemptId: started.attemptId,
          clientId: 'openzcad-macos',
          state,
          verifier
        },
        env
      )
    ).resolves.toEqual({ status: 'pending' });

    await approveDesktopAuthorization(
      { attemptId: started.attemptId },
      session,
      env
    );
    const issued = await exchangeDesktopAuthorization(
      {
        attemptId: started.attemptId,
        clientId: 'openzcad-macos',
        state,
        verifier
      },
      env
    );
    expect(issued).toMatchObject({ status: 'authorized', session });
    if (issued.status !== 'authorized') throw new Error('expected tokens');
    await expect(
      authenticateRequest(
        new Request('https://zcad.esau.app/api/session', {
          headers: { authorization: `Bearer ${issued.accessToken}` }
        }),
        env
      )
    ).resolves.toEqual(session);
    await expect(
      exchangeDesktopAuthorization(
        {
          attemptId: started.attemptId,
          clientId: 'openzcad-macos',
          state,
          verifier
        },
        env
      )
    ).rejects.toMatchObject({ code: 'DESKTOP_AUTH_CONSUMED' });

    const rotated = await refreshDesktopAuthorization(
      {
        clientId: 'openzcad-macos',
        refreshToken: issued.refreshToken
      },
      env
    );
    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    await expect(
      authenticateRequest(
        new Request('https://zcad.esau.app/api/session', {
          headers: { authorization: `Bearer ${rotated.accessToken}` }
        }),
        env
      )
    ).resolves.toEqual(session);

    await expect(
      refreshDesktopAuthorization(
        {
          clientId: 'openzcad-macos',
          refreshToken: issued.refreshToken
        },
        env
      )
    ).rejects.toThrow('expired');
    await expect(
      authenticateRequest(
        new Request('https://zcad.esau.app/api/session', {
          headers: { authorization: `Bearer ${rotated.accessToken}` }
        }),
        env
      )
    ).rejects.toThrow('expired');
  });

  it('fails closed when the desktop rollout flag is absent', async () => {
    await expect(
      startDesktopAuthorization(
        new Request('https://zcad.esau.app/api/auth/desktop/start'),
        {
          clientId: 'openzcad-macos',
          state: 's'.repeat(43),
          codeChallenge: 'c'.repeat(43)
        },
        {
          ENVIRONMENT: 'beta',
          AUTH_MODE: 'email-code'
        }
      )
    ).rejects.toMatchObject({
      status: 503,
      code: 'DESKTOP_AUTH_UNAVAILABLE'
    });
  });
});
