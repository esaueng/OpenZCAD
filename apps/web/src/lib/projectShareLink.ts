/**
 * Share-link fragments: `https://app-origin/#share=<token>`.
 *
 * Unlike invitation fragments (`projectInvitationLink.ts`), the token is NOT
 * scrubbed from the URL. A share link is a durable address people bookmark
 * and reopen; the fragment never reaches the server or Referer headers, so
 * leaving it in place costs nothing and keeps reload working.
 */
export const PROJECT_SHARE_HASH_PREFIX = 'share=';

/** The token inside a `#share=` fragment, or null when the hash is not one. */
export function shareTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith(PROJECT_SHARE_HASH_PREFIX)) {
    return null;
  }
  const token = raw.slice(PROJECT_SHARE_HASH_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function captureProjectShareToken(): string | null {
  try {
    return shareTokenFromHash(globalThis.location?.hash ?? '');
  } catch {
    return null;
  }
}

/**
 * Drops the fragment once the session stops being a shared one — after Make a
 * copy, the URL naming the shared model would reopen the wrong thing.
 */
export function clearProjectShareFragment(): void {
  try {
    if (shareTokenFromHash(globalThis.location?.hash ?? '') !== null) {
      globalThis.history.replaceState(
        null,
        '',
        `${globalThis.location.pathname}${globalThis.location.search}`
      );
    }
  } catch {
    // The URL is cosmetic here; failing to tidy it must not break the copy.
  }
}
