import type { AuthSession } from '@openzcad/shared';
import { ApiError } from './api';

/**
 * What one read of `/api/session` established. Only the Worker's 401 means
 * signed out. A rate limit, a server error, a dropped connection or a
 * static host without the API says nothing about the session, and reading
 * one as signed out showed a signed-in account the device-only shelf and
 * "Sign in" after an ordinary reload.
 */
export type AccountSessionRead =
  | { state: 'signed-in'; session: AuthSession }
  | { state: 'signed-out' }
  | { state: 'unavailable'; error: unknown };

/** Waits before each retry of a transient failure: three reads in all. */
export const SESSION_RETRY_DELAYS_MS: readonly number[] = [400, 1200];

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** A failure another read moments later can plausibly get past. */
export function isTransientSessionFailure(error: unknown): boolean {
  if (isAbort(error)) return false;
  if (error instanceof ApiError)
    return (
      error.status === 408 || error.status === 429 || error.status >= 500
    );
  // fetch rejects with a TypeError when the connection itself failed.
  return error instanceof TypeError;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads the session, retrying transient failures, and tells signed out
 * apart from unreachable. `isCurrent` stops the retries once the caller no
 * longer wants the answer.
 */
export async function readAccountSession(
  read: () => Promise<AuthSession>,
  options: {
    isCurrent?: () => boolean;
    delays?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<AccountSessionRead> {
  const delays = options.delays ?? SESSION_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? wait;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { state: 'signed-in', session: await read() };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        return { state: 'signed-out' };
      const delay = delays[attempt];
      if (
        delay === undefined ||
        !isTransientSessionFailure(error) ||
        options.isCurrent?.() === false
      )
        return { state: 'unavailable', error };
      await sleep(delay);
      if (options.isCurrent?.() === false)
        return { state: 'unavailable', error };
    }
  }
}
