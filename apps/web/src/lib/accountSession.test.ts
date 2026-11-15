import type { AuthSession } from '@openzcad/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  isTransientSessionFailure,
  readAccountSession
} from './accountSession';

const session = { userId: 'user_1', email: 'a@example.com' } as AuthSession;
const noWait = vi.fn(async () => undefined);

function reads(...outcomes: Array<AuthSession | Error>) {
  const read = vi.fn<() => Promise<AuthSession>>();
  for (const outcome of outcomes) {
    if (outcome instanceof Error) read.mockRejectedValueOnce(outcome);
    else read.mockResolvedValueOnce(outcome);
  }
  return read;
}

describe('readAccountSession', () => {
  it('reads a session as signed in', async () => {
    await expect(
      readAccountSession(reads(session), { sleep: noWait })
    ).resolves.toEqual({ state: 'signed-in', session });
  });

  it('reads only a 401 as signed out, without retrying', async () => {
    const read = reads(new ApiError(401, 'Sign in.'));
    await expect(readAccountSession(read, { sleep: noWait })).resolves.toEqual(
      { state: 'signed-out' }
    );
    expect(read).toHaveBeenCalledOnce();
  });

  // The reported bug: a rate-limited session read showed a signed-in
  // account the device-only shelf and "Sign in" after a reload.
  it('retries a rate limit and keeps the account signed in', async () => {
    const read = reads(new ApiError(429, 'API request limit reached.'), session);
    const sleep = vi.fn(async () => undefined);
    await expect(readAccountSession(read, { sleep })).resolves.toEqual({
      state: 'signed-in',
      session
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('retries a dropped connection', async () => {
    const read = reads(new TypeError('Failed to fetch'), session);
    await expect(
      readAccountSession(read, { sleep: noWait })
    ).resolves.toMatchObject({ state: 'signed-in' });
  });

  it('reports a server that keeps failing as unavailable, never signed out', async () => {
    const error = new ApiError(503, 'Unavailable');
    const read = reads(error, error, error, error);
    await expect(
      readAccountSession(read, { sleep: noWait, delays: [1, 1] })
    ).resolves.toEqual({ state: 'unavailable', error });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('does not retry a refusal that will not change, but still is not signed out', async () => {
    const error = new ApiError(404, 'Not found');
    const read = reads(error);
    await expect(readAccountSession(read, { sleep: noWait })).resolves.toEqual(
      { state: 'unavailable', error }
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it('stops retrying once the caller no longer wants the answer', async () => {
    let current = true;
    const read = reads(new ApiError(500, 'boom'), session);
    const sleep = vi.fn(async () => {
      current = false;
    });
    await expect(
      readAccountSession(read, { sleep, isCurrent: () => current })
    ).resolves.toMatchObject({ state: 'unavailable' });
    expect(read).toHaveBeenCalledOnce();
  });
});

describe('isTransientSessionFailure', () => {
  it('names the failures worth another read', () => {
    expect(isTransientSessionFailure(new ApiError(429, ''))).toBe(true);
    expect(isTransientSessionFailure(new ApiError(502, ''))).toBe(true);
    expect(isTransientSessionFailure(new TypeError('Failed to fetch'))).toBe(
      true
    );
    expect(isTransientSessionFailure(new ApiError(403, ''))).toBe(false);
    expect(
      isTransientSessionFailure(new DOMException('aborted', 'AbortError'))
    ).toBe(false);
  });
});
