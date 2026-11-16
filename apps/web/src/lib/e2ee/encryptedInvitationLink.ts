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
import { fragmentLink } from './fragmentLink';

export const ENCRYPTED_INVITATION_SESSION_KEY =
  'openzcad:pending-encrypted-invitation:v1';

const link = fragmentLink(
  'encrypted-invite',
  ENCRYPTED_INVITATION_SESSION_KEY,
  /^[A-Za-z0-9_-]{40,128}$/
);

/** The token of an `#encrypted-invite=` fragment, or null. */
export const encryptedInvitationTokenFromHash = link.fromHash;
/** Whether the fragment is an encrypted invitation link, valid or not. */
export const isEncryptedInvitationHash = link.isHash;
/**
 * Captures an encrypted invitation from the address bar: scrubs the
 * fragment and keeps a valid token for this tab. Null when there is none.
 */
export const captureEncryptedInvitationLink = link.capture;
/** The captured token this tab has not accepted yet. */
export const pendingEncryptedInvitation = link.pending;
export const clearPendingEncryptedInvitation = link.clear;
/** Called when a token is captured or cleared. */
export const subscribePendingEncryptedInvitation = link.subscribe;
