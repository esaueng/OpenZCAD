import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import {
  authenticateBrowserSession,
  createSessionCookie,
  takeRenewedSessionCookie
} from '../apps/web/worker/auth';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const DAY = 24 * 60 * 60;
const LIFETIME = 30 * DAY;
const CAP = 90 * DAY;
const USER = 'user_renewal';
const TOKEN = 'renewal-session-token';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** A migrated database holding one browser session with the given ages. */
function harness(session: { createdAt: number; expiresAt: number }) {
  const db = migratedDatabase();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    USER,
    'person@example.com',
    new Date().toISOString()
  );
  db.prepare(
    `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(tokenHash(TOKEN), USER, session.createdAt, session.expiresAt);
  const writes: string[] = [];
  const env = {
    ENVIRONMENT: 'beta' as const,
    AUTH_MODE: 'email-code' as const,
    AUTH_SESSION_DAYS: '30',
    DB: sqliteD1(db, {
      onStatement(sql) {
        if (/UPDATE auth_sessions/.test(sql)) writes.push(sql);
      }
    })
  };
  return { db, env, writes };
}

function storedExpiry(db: DatabaseSync, token = TOKEN): number | undefined {
  const row = db
    .prepare('SELECT expires_at FROM auth_sessions WHERE token_hash = ?')
    .get(tokenHash(token)) as { expires_at: number } | undefined;
  return row?.expires_at;
}

function sessionRequest(path = '/api/session', token = TOKEN): Request {
  return new Request(`https://zcad.app${path}`, {
    headers: { cookie: `__Host-openzcad_session=${token}` }
  });
}

function sessionCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .filter((line) => line.startsWith('__Host-openzcad_session='));
}

/** Every attribute but Max-Age, as the sign-in cookie sets them. */
function attributesWithoutMaxAge(line: string): string[] {
  return line
    .split(';')
    .map((part) => part.trim())
    .filter((part) => !part.startsWith('Max-Age='));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sliding browser sessions', () => {
  it('extends a session past half-life once and re-issues its cookie with the new Max-Age', async () => {
    const t = now();
    const { db, env, writes } = harness({
      createdAt: t - 20 * DAY,
      expiresAt: t + 10 * DAY
    });

    const first = await worker.fetch(sessionRequest(), env);
    expect(first.status).toBe(200);
    const renewed = storedExpiry(db)!;
    expect(renewed).toBeGreaterThanOrEqual(t + LIFETIME);
    expect(renewed).toBeLessThanOrEqual(now() + LIFETIME);
    const [cookie, ...others] = sessionCookies(first);
    expect(others).toEqual([]);
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie!)![1]);
    expect(Math.abs(maxAge - LIFETIME)).toBeLessThanOrEqual(1);
    // Name, value, Path, HttpOnly, Secure and SameSite match sign-in's.
    expect(attributesWithoutMaxAge(cookie!)).toEqual(
      attributesWithoutMaxAge(createSessionCookie(TOKEN, LIFETIME))
    );

    // The next request is under half-life again: no write, no cookie.
    const second = await worker.fetch(sessionRequest(), env);
    expect(second.status).toBe(200);
    expect(sessionCookies(second)).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(storedExpiry(db)).toBe(renewed);
  });

  it('writes concurrently arriving renewals once', async () => {
    const t = now();
    const { db, env } = harness({
      createdAt: t - 20 * DAY,
      expiresAt: t + 10 * DAY
    });
    let changed = 0;
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => worker.fetch(sessionRequest(), env))
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      changed += sessionCookies(response).length;
    }
    expect(changed).toBe(1);
    expect(storedExpiry(db)).toBeGreaterThanOrEqual(t + LIFETIME);
  });

  it('does not write a session under half-life', async () => {
    const t = now();
    const { db, env, writes } = harness({
      createdAt: t - 5 * DAY,
      expiresAt: t + 25 * DAY
    });
    const response = await worker.fetch(sessionRequest(), env);
    expect(response.status).toBe(200);
    expect(sessionCookies(response)).toEqual([]);
    expect(writes).toEqual([]);
    expect(storedExpiry(db)).toBe(t + 25 * DAY);
  });

  it('never renews beyond created_at plus the absolute cap', async () => {
    const t = now();
    const createdAt = t - 80 * DAY;
    const { db, env } = harness({ createdAt, expiresAt: t + 5 * DAY });
    const response = await worker.fetch(sessionRequest(), env);
    expect(response.status).toBe(200);
    expect(storedExpiry(db)).toBe(createdAt + CAP);
    const maxAge = Number(
      /Max-Age=(\d+)/.exec(sessionCookies(response)[0]!)![1]
    );
    expect(maxAge).toBeLessThanOrEqual(10 * DAY);
    expect(maxAge).toBeGreaterThanOrEqual(10 * DAY - 2);
  });

  it('lets a session at the cap expire as before, then rejects and deletes it', async () => {
    const t = now();
    const createdAt = t - CAP + DAY;
    const { db, env, writes } = harness({
      createdAt,
      expiresAt: createdAt + CAP
    });
    const atCap = await worker.fetch(sessionRequest(), env);
    expect(atCap.status).toBe(200);
    expect(sessionCookies(atCap)).toEqual([]);
    expect(writes).toEqual([]);

    db.prepare(
      'UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?'
    ).run(t - 1, tokenHash(TOKEN));
    const expired = await worker.fetch(sessionRequest(), env);
    expect(expired.status).toBe(401);
    expect(sessionCookies(expired)).toEqual([
      '__Host-openzcad_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    ]);
    expect(storedExpiry(db)).toBeUndefined();
  });

  it('rejects and deletes an expired session without renewing it', async () => {
    const t = now();
    const { db, env, writes } = harness({
      createdAt: t - 31 * DAY,
      expiresAt: t - DAY
    });
    await expect(
      authenticateBrowserSession(sessionRequest(), env)
    ).rejects.toMatchObject({ failure: 'invalid' });
    expect(writes).toEqual([]);
    expect(storedExpiry(db)).toBeUndefined();
  });

  it('still authenticates when the renewal write fails', async () => {
    const t = now();
    const { db, env } = harness({
      createdAt: t - 20 * DAY,
      expiresAt: t + 10 * DAY
    });
    const failing = {
      ...env,
      DB: sqliteD1(db, {
        onStatement(sql) {
          if (/UPDATE auth_sessions/.test(sql)) {
            throw new Error('D1_ERROR: renewal write refused');
          }
        }
      })
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await worker.fetch(sessionRequest(), failing);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId: USER });
    expect(sessionCookies(response)).toEqual([]);
    expect(storedExpiry(db)).toBe(t + 10 * DAY);
  });

  it('does not re-issue the renewed cookie over a sign-out that clears it', async () => {
    const t = now();
    const { db, env } = harness({
      createdAt: t - 20 * DAY,
      expiresAt: t + 10 * DAY
    });
    const request = sessionRequest();
    await authenticateBrowserSession(request, env);
    const cookie = takeRenewedSessionCookie(request);
    expect(cookie).toMatch(/^__Host-openzcad_session=renewal-session-token;/);
    // Taken once: a second read finds nothing.
    expect(takeRenewedSessionCookie(request)).toBeNull();
    expect(storedExpiry(db)).toBeGreaterThanOrEqual(t + LIFETIME);

    const signOut = await worker.fetch(
      new Request('https://zcad.app/api/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `__Host-openzcad_session=${TOKEN}`,
          origin: 'https://zcad.app'
        }
      }),
      env
    );
    expect(sessionCookies(signOut)).toEqual([
      '__Host-openzcad_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    ]);
    expect(storedExpiry(db)).toBeUndefined();
  });

  it('leaves e2ee-write lease rows untouched', async () => {
    const t = now();
    const { db, env, writes } = harness({
      createdAt: t - 20 * DAY,
      expiresAt: t + 10 * DAY
    });
    const lease = 'e2ee-write:00000000-0000-4000-8000-000000000000';
    db.prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(lease, USER, t - 200, t + 100);
    // Presenting the lease id as a cookie cannot reach it: the cookie is
    // hashed first, and no hash has the lease prefix.
    const response = await worker.fetch(
      sessionRequest('/api/session', lease),
      env
    );
    expect(response.status).toBe(401);
    const row = db
      .prepare('SELECT expires_at FROM auth_sessions WHERE token_hash = ?')
      .get(lease) as { expires_at: number };
    expect(row.expires_at).toBe(t + 100);
    expect(writes).toEqual([]);
  });
});
