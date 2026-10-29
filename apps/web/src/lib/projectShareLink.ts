/**
 * Share-link fragments: `https://app-origin/#share=<token>`.
 *
 * Unlike invitation fragments (`projectInvitationLink.ts`), the token is NOT
 * scrubbed from the URL. Until it expires, a share link is an address people bookmark
 * and reopen; the fragment never reaches the server or Referer headers, so
 * leaving it in place costs nothing and keeps reload working.
 */
export const PROJECT_SHARE_HASH_PREFIX = 'share=';

/** Recognize the share destination even when its capability is incomplete. */
export function shareRequestFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  return raw.startsWith(PROJECT_SHARE_HASH_PREFIX)
    ? raw.slice(PROJECT_SHARE_HASH_PREFIX.length).trim()
    : null;
}

/** Includes empty/malformed links so they reach the dedicated share page. */
export function captureProjectShareRequest(): string | null {
  try {
    return shareRequestFromHash(globalThis.location?.hash ?? '');
  } catch {
    return null;
  }
}

/** A creation result is copyable only after every publication step finished. */
export function shareLinkCreationProblem(created: {
  readonly pending: readonly string[];
  readonly needsConfirmation: boolean;
  readonly problem: string | null;
}): string | null {
  if (!created.pending.length) return null;
  return created.needsConfirmation
    ? "The link needs your confirmation before it can open. Confirm sharing in the project's sharing dialog, then copy it from the link list."
    : `The link could not be published yet. Open the project's sharing dialog to retry.${created.problem ? ` ${created.problem}` : ''}`;
}

/** The same app route, without an invitation or share capability fragment. */
export function projectLinkPath(
  location: Pick<Location, 'pathname' | 'search'> = globalThis.location
): string {
  return `${location.pathname}${location.search}`;
}

/** The token inside a `#share=` fragment, or null when the hash is not one. */
export function shareTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith(PROJECT_SHARE_HASH_PREFIX)) {
    return null;
  }
  const token = raw.slice(PROJECT_SHARE_HASH_PREFIX.length).trim();
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/**
 * An end-to-end encrypted link's fragment payload, `<token>.<key>.<owner>`
 * (ADR-024 Phase 5, slice 5-11): three unpadded base64url parts of 32 bytes.
 * The plaintext reader above never accepts it, and this one never accepts a
 * plaintext token, so neither form is mistaken for the other.
 */
const ENCRYPTED_SHARE_LINK =
  /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

/**
 * What a `#share=` fragment opens: the plaintext token, or an encrypted
 * link's whole payload (see `isEncryptedShareLink`); null when the hash is
 * neither.
 */
export function shareLinkFromHash(hash: string): string | null {
  const token = shareTokenFromHash(hash);
  if (token !== null) return token;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith(PROJECT_SHARE_HASH_PREFIX)) return null;
  const payload = raw.slice(PROJECT_SHARE_HASH_PREFIX.length).trim();
  return ENCRYPTED_SHARE_LINK.test(payload) ? payload : null;
}

/** Whether a `shareLinkFromHash` value is an encrypted link's payload. */
export function isEncryptedShareLink(link: string): boolean {
  return ENCRYPTED_SHARE_LINK.test(link);
}

/** The plaintext token or encrypted payload in the current URL, if any. */
export function captureProjectShareLink(): string | null {
  try {
    return shareLinkFromHash(globalThis.location?.hash ?? '');
  } catch {
    return null;
  }
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
    if (captureProjectShareRequest() !== null) {
      globalThis.history.replaceState(null, '', projectLinkPath());
    }
  } catch {
    // The URL is cosmetic here; failing to tidy it must not break the copy.
  }
}
