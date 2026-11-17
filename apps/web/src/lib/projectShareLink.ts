/**
 * Share-link fragments: `https://app-origin/#share=<token>`.
 *
 * Unlike invitation fragments (`projectInvitationLink.ts`), the token is NOT
 * scrubbed from the URL. Until it expires, a share link is an address people bookmark
 * and reopen; the fragment never reaches the server or Referer headers, so
 * leaving it in place costs nothing and keeps reload working.
 */
export const PROJECT_SHARE_HASH_PREFIX = 'share=';

/**
 * F06: a share link may name the configuration it opens on, after the
 * capability: `#share=<token>&configuration=<row id>`. Only the row id
 * travels; its values come from the shared model. Tokens and encrypted
 * payloads are base64url and dots, so `&` never occurs inside one.
 */
export const SHARE_CONFIGURATION_PARAM = 'configuration';

/**
 * Longest parameter suffix read after the capability. A link carries one
 * short row id; anything longer is not one of ours and is not parsed, so a
 * crafted fragment cannot make every reader below do unbounded work.
 */
const MAX_SHARE_PARAMS_LENGTH = 512;

/** The text after `share=`, or null when the hash is not a share fragment. */
function shareRest(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  return raw.startsWith(PROJECT_SHARE_HASH_PREFIX)
    ? raw.slice(PROJECT_SHARE_HASH_PREFIX.length)
    : null;
}

/** The fragment's capability part and its optional parameters. */
function splitShareHash(hash: string): {
  capability: string;
  params: URLSearchParams;
} | null {
  const rest = shareRest(hash);
  if (rest === null) return null;
  const cut = rest.indexOf('&');
  if (cut < 0)
    return { capability: rest.trim(), params: new URLSearchParams() };
  const suffix = rest.slice(cut + 1);
  return {
    capability: rest.slice(0, cut).trim(),
    params: new URLSearchParams(
      suffix.length <= MAX_SHARE_PARAMS_LENGTH ? suffix : ''
    )
  };
}

/** Recognize the share destination even when its capability is incomplete. */
export function shareRequestFromHash(hash: string): string | null {
  // The capability alone: no parameters are parsed to find it.
  const rest = shareRest(hash);
  if (rest === null) return null;
  const cut = rest.indexOf('&');
  return (cut < 0 ? rest : rest.slice(0, cut)).trim();
}

/** F06: the configuration row a share link opens on, or null for none. */
export function shareConfigurationFromHash(hash: string): string | null {
  const value = splitShareHash(hash)?.params.get(SHARE_CONFIGURATION_PARAM);
  return value && value.length <= 128 ? value : null;
}

/** F06: the configuration row named by the current URL's share link. */
export function captureShareConfiguration(): string | null {
  try {
    return shareConfigurationFromHash(globalThis.location?.hash ?? '');
  } catch {
    return null;
  }
}

/**
 * F06: `url` (a share link) opening on configuration `rowId`, or on the
 * model as shared when null. Any row the link named before is replaced.
 */
export function withShareConfiguration(
  url: string,
  rowId: string | null
): string {
  const at = url.indexOf('#');
  const base = at < 0 ? url : url.slice(0, at);
  const parts = splitShareHash(at < 0 ? '' : url.slice(at));
  if (!parts) return url;
  const params = new URLSearchParams(parts.params);
  if (rowId) params.set(SHARE_CONFIGURATION_PARAM, rowId);
  else params.delete(SHARE_CONFIGURATION_PARAM);
  const query = params.toString();
  return `${base}#${PROJECT_SHARE_HASH_PREFIX}${parts.capability}${query ? `&${query}` : ''}`;
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
  const token = shareRequestFromHash(hash);
  return token !== null && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
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
  const payload = shareRequestFromHash(hash);
  return payload !== null && ENCRYPTED_SHARE_LINK.test(payload)
    ? payload
    : null;
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
