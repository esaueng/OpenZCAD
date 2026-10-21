import { sessionWriteCredential } from './sessionCredentials';

export interface E2eeWriteAuthorization {
  readonly sql: string;
  readonly binds: readonly unknown[];
  dispose(): Promise<void>;
}

/**
 * Bind every mutation to authority that erasure revokes. The predicate is
 * evaluated inside the same SQL transaction as the mutation, including all
 * statements in a batch. A later sign-in cannot revive the admitted token.
 */
const admittedDevelopmentWrites = new WeakMap<object, E2eeWriteAuthorization>();

export async function admitDevelopmentE2eeWrite(
  db: D1Database,
  session: { userId: string }
): Promise<void> {
  const userId = session.userId;
  // Development auth has no durable session. A short-lived internal lease
  // uses the existing session erasure lifecycle. Its non-hash id cannot be
  // presented as a browser cookie; never return it in an API response.
  const tokenHash = `e2ee-write:${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const fence =
    'NOT EXISTS (SELECT 1 FROM account_erasure_requests WHERE user_id = ?)';
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, email, created_at)
        SELECT ?, NULL, ? WHERE ${fence} ON CONFLICT(id) DO NOTHING`
      )
      .bind(userId, new Date().toISOString(), userId),
    db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
        SELECT ?, ?, ?, ? WHERE ${fence}
          AND EXISTS (SELECT 1 FROM users WHERE id = ?)`
      )
      .bind(tokenHash, userId, now, now + 300, userId, userId)
  ]);
  const dispose = async () => {
    await db
      .prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
  };
  admittedDevelopmentWrites.set(
    session,
    writeAuthorization('auth_sessions', tokenHash, userId, dispose)
  );
}

export async function releaseDevelopmentE2eeWrite(
  session: object
): Promise<void> {
  const authorization = admittedDevelopmentWrites.get(session);
  admittedDevelopmentWrites.delete(session);
  await authorization?.dispose();
}

export async function e2eeWriteAuthorization(
  request: Request,
  session: { userId: string },
  development: boolean
): Promise<E2eeWriteAuthorization | null> {
  if (development) return admittedDevelopmentWrites.get(session) ?? null;
  const credential = await sessionWriteCredential(request);
  return credential
    ? writeAuthorization(
        credential.table,
        credential.tokenHash,
        session.userId,
        async () => {}
      )
    : null;
}

function writeAuthorization(
  table: 'auth_sessions' | 'desktop_access_tokens',
  tokenHash: string,
  userId: string,
  dispose: () => Promise<void>
): E2eeWriteAuthorization {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM account_erasure_requests WHERE user_id = ?)
      AND EXISTS (SELECT 1 FROM ${table}
        WHERE token_hash = ? AND user_id = ? AND expires_at >= unixepoch()
        ${table === 'desktop_access_tokens' ? "AND revoked_at IS NULL AND client_id = 'openzcad-macos'" : ''})`,
    binds: [userId, tokenHash, userId],
    dispose
  };
}
