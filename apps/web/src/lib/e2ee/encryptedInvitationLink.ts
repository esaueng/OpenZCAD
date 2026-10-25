/**
 * The `#encrypted-invite=<token>` link an invitation to an end-to-end
 * encrypted project emails (ADR-024 Phase 5, slices 5-3a and 5-3b). Like
 * the plaintext `#invite=` link, the fragment never reaches the server: it
 * is scrubbed from the address bar at once and the token kept tab-scoped,
 * so a sign-in in between does not lose it. Settings › Encryption ›
 * Invitations accepts it (`acceptEncryptedInvitation`) and clears it.
 *
 * Loaded by the entry chunk: no crypto here.
 */
import { projectLinkPath } from '../projectShareLink';

export const ENCRYPTED_INVITATION_SESSION_KEY =
  'openzcad:pending-encrypted-invitation:v1';
const PREFIX = '#encrypted-invite=';
const TOKEN = /^[A-Za-z0-9_-]{40,128}$/;

const listeners = new Set<() => void>();

/** The token of an `#encrypted-invite=` fragment, or null. */
export function encryptedInvitationTokenFromHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  const parameters = new URLSearchParams(hash.slice(1));
  const values = parameters.getAll('encrypted-invite');
  if (
    values.length !== 1 ||
    [...parameters.keys()].some((key) => key !== 'encrypted-invite')
  ) {
    return null;
  }
  const token = values[0] ?? '';
  return TOKEN.test(token) ? token : null;
}

/** Whether the fragment is an encrypted invitation link, valid or not. */
export function isEncryptedInvitationHash(hash: string): boolean {
  return hash.startsWith(PREFIX);
}

/**
 * Captures an encrypted invitation from the address bar: scrubs the
 * fragment and keeps a valid token for this tab. Null when there is none.
 */
export function captureEncryptedInvitationLink(
  location: Pick<
    Location,
    'hash' | 'pathname' | 'search'
  > = globalThis.location,
  history: Pick<History, 'replaceState' | 'state'> = globalThis.history,
  storage: Pick<Storage, 'setItem'> = globalThis.sessionStorage
): string | null {
  if (!isEncryptedInvitationHash(location.hash)) return null;
  const token = encryptedInvitationTokenFromHash(location.hash);
  history.replaceState(history.state, '', projectLinkPath(location));
  if (!token) return null;
  try {
    storage.setItem(ENCRYPTED_INVITATION_SESSION_KEY, token);
  } catch {
    // A blocked storage API keeps the token for this page only.
    memoryToken = token;
  }
  for (const listener of listeners) listener();
  return token;
}

let memoryToken: string | null = null;

/** The captured token this tab has not accepted yet. */
export function pendingEncryptedInvitation(
  storage: Pick<Storage, 'getItem'> = globalThis.sessionStorage
): string | null {
  try {
    const stored = storage.getItem(ENCRYPTED_INVITATION_SESSION_KEY);
    if (stored && TOKEN.test(stored)) return stored;
  } catch {
    // Fall back to this page's copy.
  }
  return memoryToken;
}

export function clearPendingEncryptedInvitation(
  storage: Pick<Storage, 'removeItem'> = globalThis.sessionStorage
): void {
  memoryToken = null;
  try {
    storage.removeItem(ENCRYPTED_INVITATION_SESSION_KEY);
  } catch {
    // Nothing to clear.
  }
  for (const listener of listeners) listener();
}

/** Called when a token is captured or cleared. */
export function subscribePendingEncryptedInvitation(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
