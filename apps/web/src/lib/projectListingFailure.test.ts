import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { clearActivityLog, lastActivity } from './activityLog';
import {
  describeProjectListingFailure,
  reportProjectListingFailure
} from './projectListingFailure';

describe('project listing failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearActivityLog();
  });

  it('names the status and the API code the Worker sent', () => {
    expect(
      describeProjectListingFailure(
        new ApiError(
          503,
          'Cloud project storage is temporarily unavailable.',
          'PROJECT_STORAGE_UNAVAILABLE'
        )
      )
    ).toBe('HTTP 503 PROJECT_STORAGE_UNAVAILABLE');
    expect(describeProjectListingFailure(new ApiError(500, 'oops'))).toBe(
      'HTTP 500'
    );
  });

  it('names a failure that never reached the Worker', () => {
    expect(
      describeProjectListingFailure(new TypeError('Failed to fetch'))
    ).toBe('TypeError: Failed to fetch');
    expect(describeProjectListingFailure('nope')).toBe('Unknown error');
  });

  it('logs the reason to the console and the activity log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportProjectListingFailure(
      new ApiError(429, 'Too many requests.', 'RATE_LIMITED')
    );

    expect(warn).toHaveBeenCalledWith(
      'Account project list could not be read: HTTP 429 RATE_LIMITED'
    );
    expect(lastActivity('error')).toMatchObject({
      level: 'warning',
      message: 'Account project list could not be read.',
      detail: 'HTTP 429 RATE_LIMITED'
    });
  });
});
