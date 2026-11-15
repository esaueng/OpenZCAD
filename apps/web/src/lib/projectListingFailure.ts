import { ApiError } from './api';
import { recordActivity } from './activityLog';

/**
 * Why the account's project list could not be read, in a few words: the
 * HTTP status and the API's error code when the Worker answered, otherwise
 * the kind of failure (a network error, say). No URL, ids or response body.
 */
export function describeProjectListingFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code
      ? `HTTP ${error.status} ${error.code}`
      : `HTTP ${error.status}`;
  }
  if (error instanceof Error) {
    const message = error.message.slice(0, 120);
    return message ? `${error.name}: ${message}` : error.name;
  }
  return 'Unknown error';
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
