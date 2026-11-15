import {
  MAX_ACCOUNT_PROJECTS,
  MAX_ACCOUNT_STORAGE_BYTES
} from '@openzcad/shared';
import { sessionWriteCredential } from './sessionCredentials';

export interface E2eeWriteAuthorization {
  readonly sql: string;
  readonly binds: readonly unknown[];
  /**
   * The session or desktop token the write is admitted under, so a write
   * that ends the account's other sessions can keep this one. Never sent
   * to a browser.
   */
  readonly credential?: {
    readonly table: 'auth_sessions' | 'desktop_access_tokens';
    readonly tokenHash: string;
  };
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
    // A row without an email is Free; write its limits rather than leave
    // the 2 GiB column defaults for the quota triggers to read.
    db
      .prepare(
        `INSERT INTO users
          (id, email, created_at, artifact_limit_bytes, project_limit,
           project_storage_limit_bytes)
        SELECT ?, NULL, ?, ?, ?, ? WHERE ${fence} ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        userId,
        new Date().toISOString(),
        MAX_ACCOUNT_STORAGE_BYTES,
        MAX_ACCOUNT_PROJECTS,
        MAX_ACCOUNT_STORAGE_BYTES,
        userId
      ),
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
  // Expiry admits this request once. Re-evaluating the clock in each batch
  // statement can admit the identity/entry and silently skip its wraps when
  // the second changes. Erasure, session deletion and desktop revocation
  // still use live rows inside the transaction, so they revoke every write.
  const admittedAt = Math.floor(Date.now() / 1000);
  return {
    credential: { table, tokenHash },
    sql: `NOT EXISTS (SELECT 1 FROM account_erasure_requests WHERE user_id = ?)
      AND EXISTS (SELECT 1 FROM ${table}
        WHERE token_hash = ? AND user_id = ? AND expires_at >= ?
        ${table === 'desktop_access_tokens' ? "AND revoked_at IS NULL AND client_id = 'openzcad-macos'" : ''})`,
    binds: [userId, tokenHash, userId, admittedAt],
    dispose
  };
}

/**
 * The same predicate for a write the collaboration room makes for a socket
 * (ADR-024 slice 4-9): bound to the session the socket was admitted under,
 * by its token hash, so signing out, session expiry, desktop revocation and
 * erasure stop the room's writes as they stop the routes'.
 */
export function sessionHashWriteAuthorization(
  credential: {
    table: 'auth_sessions' | 'desktop_access_tokens';
    tokenHash: string;
  },
  userId: string
): E2eeWriteAuthorization {
  return writeAuthorization(
    credential.table,
    credential.tokenHash,
    userId,
    async () => {}
  );
}
