import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { E2eeApiError } from './e2ee/e2eeApi';
import { ProjectGroupApiError } from './e2ee/projectGroups';
import {
  MAX_RETRY_AFTER_MS,
  isRateLimitError,
  rateLimitOf,
  retryAfterMs
} from './rateLimit';

describe('retryAfterMs', () => {
  it('reads delay seconds and HTTP dates', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    expect(retryAfterMs(new Headers({ 'retry-after': '30' }), now)).toBe(
      30_000
    );
    expect(
      retryAfterMs(
        new Headers({ 'retry-after': 'Mon, 16 Nov 2026 12:02:00 GMT' }),
        now
      )
    ).toBe(120_000);
    expect(
      retryAfterMs(
        new Headers({ 'retry-after': 'Mon, 16 Nov 2026 11:00:00 GMT' }),
        now
      )
    ).toBe(0);
  });

  it('ignores a missing or unreadable header and caps a huge one', () => {
    expect(retryAfterMs(new Headers())).toBeUndefined();
    expect(
      retryAfterMs(new Headers({ 'retry-after': 'soon' }))
    ).toBeUndefined();
    expect(retryAfterMs(undefined)).toBeUndefined();
    expect(retryAfterMs(new Headers({ 'retry-after': '999999' }))).toBe(
      MAX_RETRY_AFTER_MS
    );
  });
});

describe('rateLimitOf', () => {
  it('recognizes 429 refusals from the app and key routes', () => {
    expect(rateLimitOf(new ApiError(429, 'limit'))).toEqual({});
    expect(
      rateLimitOf(new ApiError(429, 'limit', undefined, undefined, 5000))
    ).toEqual({ retryAfterMs: 5000 });
    expect(rateLimitOf(new E2eeApiError(429, 'limit'))).toEqual({});
    expect(
      rateLimitOf(new ProjectGroupApiError(429, 'limit', undefined, {}, 7000))
    ).toEqual({ retryAfterMs: 7000 });
  });

  it('looks through causes and rejects everything else', () => {
    expect(
      isRateLimitError(
        new Error('wrapped', { cause: new E2eeApiError(429, 'limit') })
      )
    ).toBe(true);
    expect(isRateLimitError(new ApiError(401, 'signed out'))).toBe(false);
    expect(isRateLimitError(new E2eeApiError(503, 'down'))).toBe(false);
    expect(isRateLimitError(new TypeError('offline'))).toBe(false);
    expect(isRateLimitError({ status: 429 })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});
