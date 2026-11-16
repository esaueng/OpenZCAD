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
import { fragmentLink } from './fragmentLink';

export const DEVICE_APPROVAL_SESSION_KEY =
  'openzcad:pending-device-approval:v1';
const KEY = 'approve-device';

function normalize(code: string): string {
  const compact = code.replace(/[\s-]/g, '').toUpperCase();
  return compact.startsWith('OZD1:') ? compact.slice(5) : compact;
}

const link = fragmentLink(
  KEY,
  DEVICE_APPROVAL_SESSION_KEY,
  // 32 bytes in Crockford base32 (`toBase32`): 52 symbols.
  /^[0-9A-HJKMNP-TV-Z]{52}$/,
  normalize
);

/** The approval link for a scan code such as `OZD1:…`, on this origin. */
export function deviceApprovalLink(
  scanCode: string,
  origin: string = globalThis.location.origin
): string {
  return `${origin}/#${KEY}=${normalize(scanCode)}`;
}

/** The code of an `#approve-device=` fragment, or null. */
export const deviceApprovalCodeFromHash = link.fromHash;

/**
 * The code inside a full approval link (what an in-app camera reads off the
 * QR code), or null when `text` is not one. Only the fragment is read: the
 * link's origin does not matter, since the code is checked against the
 * keys of a request this account's server listed.
 */
export function deviceApprovalCodeFromLink(text: string): string | null {
  const url = text.trim();
  const at = url.indexOf('#');
  if (at < 0) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return link.fromHash(url.slice(at));
}

/** Whether the fragment is a device approval link, valid or not. */
export const isDeviceApprovalHash = link.isHash;
/**
 * Captures a device approval link from the address bar: scrubs the
 * fragment and keeps a valid code for this tab. Null when there is none.
 */
export const captureDeviceApprovalLink = link.capture;
/** The scanned code this tab has not used yet. */
export const pendingDeviceApproval = link.pending;
export const clearPendingDeviceApproval = link.clear;
/** Called when a code is captured or cleared. */
export const subscribePendingDeviceApproval = link.subscribe;
