/**
 * The `#approve-device=<code>` link a new device shows as its approval QR
 * code (ADR-024 amendment 2026-11-16). Pointing a phone's own camera at it
 * opens OpenZCAD there, and Settings › Encryption offers to approve the
 * device whose keys hash to `<code>`.
 *
 * The code is the full 256-bit `pk_new` hash in Crockford base32, exactly
 * what the in-app scanner reads, so the link authenticates the device the
 * same way a scan does: the approving browser checks it against the keys the
 * server delivered before anything is approved. It is not a secret, and a
 * link only pre-fills the scan; approving still needs the user's explicit
 * confirmation and a passkey or the recovery key. The fragment never
 * reaches the server: it is scrubbed from the address bar at once and kept
 * tab-scoped, so signing in or unlocking in between does not lose it.
 *
 * Loaded by the entry chunk: no crypto here.
 */
import { projectLinkPath } from '../projectShareLink';

export const DEVICE_APPROVAL_SESSION_KEY =
  'openzcad:pending-device-approval:v1';
const KEY = 'approve-device';
const PREFIX = `#${KEY}=`;
/** 32 bytes in Crockford base32 (`toBase32`): 52 symbols. */
const CODE = /^[0-9A-HJKMNP-TV-Z]{52}$/;

const listeners = new Set<() => void>();
let memoryCode: string | null = null;

/** The approval link for a scan code such as `OZD1:…`, on this origin. */
export function deviceApprovalLink(
  scanCode: string,
  origin: string = globalThis.location.origin
): string {
  return `${origin}/${PREFIX}${normalize(scanCode)}`;
}

function normalize(code: string): string {
  const compact = code.replace(/[\s-]/g, '').toUpperCase();
  return compact.startsWith('OZD1:') ? compact.slice(5) : compact;
}

/** The code of an `#approve-device=` fragment, or null. */
export function deviceApprovalCodeFromHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  const parameters = new URLSearchParams(hash.slice(1));
  const values = parameters.getAll(KEY);
  if (values.length !== 1 || [...parameters.keys()].some((k) => k !== KEY)) {
    return null;
  }
  const code = normalize(values[0] ?? '');
  return CODE.test(code) ? code : null;
}

/**
 * The code inside a full approval link (what an in-app camera reads off the
 * QR code), or null when `text` is not one. Only the fragment is read: the
 * link's origin does not matter, since the code is checked against the
 * keys of a request this account's server listed.
 */
export function deviceApprovalCodeFromLink(text: string): string | null {
  const link = text.trim();
  const at = link.indexOf('#');
  if (at < 0) return null;
  try {
    new URL(link);
  } catch {
    return null;
  }
  return deviceApprovalCodeFromHash(link.slice(at));
}

/** Whether the fragment is a device approval link, valid or not. */
export function isDeviceApprovalHash(hash: string): boolean {
  return hash.startsWith(PREFIX);
}

/**
 * Captures a device approval link from the address bar: scrubs the
 * fragment and keeps a valid code for this tab. Null when there is none.
 */
export function captureDeviceApprovalLink(
  location: Pick<
    Location,
    'hash' | 'pathname' | 'search'
  > = globalThis.location,
  history: Pick<History, 'replaceState' | 'state'> = globalThis.history,
  storage: Pick<Storage, 'setItem'> = globalThis.sessionStorage
): string | null {
  if (!isDeviceApprovalHash(location.hash)) return null;
  const code = deviceApprovalCodeFromHash(location.hash);
  history.replaceState(history.state, '', projectLinkPath(location));
  if (!code) return null;
  memoryCode = code;
  try {
    storage.setItem(DEVICE_APPROVAL_SESSION_KEY, code);
  } catch {
    // A blocked storage API keeps the code for this page only.
  }
  for (const listener of listeners) listener();
  return code;
}

/** The scanned code this tab has not used yet. */
export function pendingDeviceApproval(
  storage: Pick<Storage, 'getItem'> = globalThis.sessionStorage
): string | null {
  try {
    const stored = storage.getItem(DEVICE_APPROVAL_SESSION_KEY);
    if (stored && CODE.test(stored)) return stored;
  } catch {
    // Fall back to this page's copy.
  }
  return memoryCode;
}

export function clearPendingDeviceApproval(
  storage: Pick<Storage, 'removeItem'> = globalThis.sessionStorage
): void {
  memoryCode = null;
  try {
    storage.removeItem(DEVICE_APPROVAL_SESSION_KEY);
  } catch {
    // Nothing to clear.
  }
  for (const listener of listeners) listener();
}

/** Called when a code is captured or cleared. */
export function subscribePendingDeviceApproval(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
