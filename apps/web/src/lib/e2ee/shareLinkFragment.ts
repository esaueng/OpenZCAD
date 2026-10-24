/**
 * Encrypted share-link fragments (ADR-024 Phase 5, slices 5-10 and 5-11):
 * `#share=<token>.<key>.<owner>`, each part the unpadded base64url of 32
 * bytes: the capability token for `GET /api/e2ee/share/:token`, the share
 * key, and the owner's identity fingerprint (`publicKeyHash` of the
 * identity key). The fragment never reaches the server.
 *
 * The token is derived from the share key, so every member who can open
 * the key can show the link again, and the server, which keeps only the
 * token's hash, learns neither. The plaintext parser
 * (`projectShareLink.ts`) accepts a 43-character token only, so it never
 * mistakes an encrypted link for a plaintext one.
 */
import { fromBase64Url, toBase64Url } from '@openzcad/crypto';

const PART = /^[A-Za-z0-9_-]{43}$/;
const PREFIX = 'share=';
const TOKEN_LABEL = new TextEncoder().encode('openzcad v1 share link token');

export interface ShareFragmentParts {
  readonly token: string;
  readonly shareKey: Uint8Array;
  readonly ownerIdentityHash: Uint8Array;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  );
}

/** The capability token of a share key: base64url of a labelled SHA-256. */
export async function shareLinkToken(shareKey: Uint8Array): Promise<string> {
  if (!(shareKey instanceof Uint8Array) || shareKey.byteLength !== 32) {
    throw new TypeError('A share key is 32 bytes');
  }
  const input = new Uint8Array(TOKEN_LABEL.byteLength + 32);
  input.set(TOKEN_LABEL);
  input.set(shareKey, TOKEN_LABEL.byteLength);
  return toBase64Url(await sha256(input));
}

/** What the server stores of a token: lowercase hex SHA-256 of its bytes. */
export async function shareLinkTokenHash(token: string): Promise<string> {
  return Array.from(await sha256(fromBase64Url(token)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/** `share=<token>.<key>.<owner>`, without the leading `#`. */
export function formatShareFragment(parts: ShareFragmentParts): string {
  const key = toBase64Url(parts.shareKey);
  const owner = toBase64Url(parts.ownerIdentityHash);
  if (!PART.test(parts.token) || !PART.test(key) || !PART.test(owner)) {
    throw new TypeError('Each share-link part is 32 bytes');
  }
  return `${PREFIX}${parts.token}.${key}.${owner}`;
}

/** The parts of an encrypted `#share=` fragment, or null when it is not one. */
export function parseShareFragment(hash: string): ShareFragmentParts | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith(PREFIX)) return null;
  const parts = raw.slice(PREFIX.length).trim().split('.');
  if (parts.length !== 3 || !parts.every((part) => PART.test(part))) {
    return null;
  }
  try {
    const shareKey = fromBase64Url(parts[1]!);
    const ownerIdentityHash = fromBase64Url(parts[2]!);
    if (shareKey.byteLength !== 32 || ownerIdentityHash.byteLength !== 32) {
      return null;
    }
    return { token: parts[0]!, shareKey, ownerIdentityHash };
  } catch {
    return null;
  }
}

/** The link a person copies: the app origin and the fragment. */
export function shareLinkUrl(
  origin: string,
  parts: ShareFragmentParts
): string {
  return `${origin.replace(/\/+$/, '')}/#${formatShareFragment(parts)}`;
}
