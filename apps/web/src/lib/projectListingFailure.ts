import { ApiError } from './api';
import { recordActivity } from './activityLog';

/**
 * Why the account's project list could not be read, in a few words: the
 * HTTP status and the API's error code when the Worker answered, otherwise
 * the kind of failure. Never an error's message: a body that is not JSON
 * fails parsing with a message that quotes it. No URL, ids or body.
 */
export function describeProjectListingFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code
      ? `HTTP ${error.status} ${error.code}`
      : `HTTP ${error.status}`;
  }
  if (error instanceof Error) {
    if (error.name === 'TypeError') return 'network error';
    if (error.name === 'SyntaxError') return 'unreadable response';
    if (error.name === 'AbortError') return 'request aborted';
    return 'unexpected error';
  }
  return 'unexpected error';
}

/**
 * A listing that never reached the account still lists this device's
 * projects, and the start screen says "Account unavailable". Without this
 * the reason was dropped, so nothing showed why: it goes to the console and
 * to the session's activity log (Settings › Activity log).
 */
export function reportProjectListingFailure(error: unknown): void {
  const detail = describeProjectListingFailure(error);
  console.warn(`Account project list could not be read: ${detail}`);
  recordActivity({
    level: 'warning',
    source: 'error',
    message: 'Account project list could not be read.',
    detail
  });
}
