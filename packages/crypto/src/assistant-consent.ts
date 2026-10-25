import { asBytes, equalBytes, utf8, type Bytes } from './bytes';
import { E2eeError } from './errors';
import { hkdfBaseKey, subtle } from './primitives';

/**
 * Per-project assistant consent (ADR-024 Phase 6, slice 6-1; plan default
 * M6: per user, per project). The record says whether this account lets the
 * assistant read one encrypted project, which consent copy it was shown,
 * and which provider route it named. It is canonical JSON MAC'd with
 * HMAC-SHA-256 under a key the account key derives by HKDF-SHA-256 (empty
 * salt) with its own info label — the pattern of the project-preferences
 * record (`account-records.ts`), with a label of its own so a MAC for one
 * kind never verifies as the other. The Worker stores it and keeps a live
 * row for its own gate, but cannot forge it: browsers trust only a record
 * whose MAC verifies and whose sequence is not below the one they pinned.
 */

/** HKDF info for the assistant-consent MAC key. A storage-format constant. */
export const ASSISTANT_CONSENT_MAC_INFO =
  'OpenZCAD E2EE v1 assistant consent mac';

export const ASSISTANT_CONSENT_VERSION_1 = 1;
export const ASSISTANT_CONSENT_MAC_BYTES = 32;
/** Longest encoded consent record accepted (ids ≤ 128, route ≤ 256). */
export const MAX_ASSISTANT_CONSENT_BYTES = 1024;
/** Longest provider route string a record may name. */
export const MAX_ASSISTANT_CONSENT_ROUTE_LENGTH = 256;

export interface AssistantConsent {
  readonly userId: string;
  readonly projectId: string;
  /** False records a revocation ("Stop"). */
  readonly allowed: boolean;
  /** Which consent copy the user was shown; a new copy asks again. */
  readonly copyVersion: number;
  /**
   * The provider route the copy named (who receives the data). Empty only
   * on a revocation. A different route asks again.
   */
  readonly route: string;
  /** Strictly increases with every write, per user and project. */
  readonly sequence: number;
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function validRoute(value: unknown, allowed: boolean): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ASSISTANT_CONSENT_ROUTE_LENGTH &&
    (value.length > 0 || !allowed) &&
    /^[\x20-\x7e]*$/.test(value)
  );
}

function validInteger(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= max
  );
}

/** The canonical bytes: fixed key order, no whitespace. */
export function encodeAssistantConsent(record: AssistantConsent): Bytes {
  if (
    !validId(record?.userId) ||
    !validId(record.projectId) ||
    typeof record.allowed !== 'boolean' ||
    !validInteger(record.copyVersion, 0xffff) ||
    !validRoute(record.route, record.allowed) ||
    !validInteger(record.sequence, 0xffffffff)
  ) {
    throw new E2eeError(
      'invalid-argument',
      'An assistant consent record needs a user and project id, a boolean, a copy version, a route when allowed and a sequence from 1'
    );
  }
  return utf8(
    JSON.stringify({
      v: ASSISTANT_CONSENT_VERSION_1,
      kind: 'assistant-consent',
      userId: record.userId,
      projectId: record.projectId,
      allowed: record.allowed,
      copyVersion: record.copyVersion,
      route: record.route,
      sequence: record.sequence
    })
  );
}

/**
 * Parses canonical bytes. Anything that does not re-encode to exactly the
 * same bytes is refused, so two encodings of one record cannot both carry
 * a valid MAC.
 */
export function decodeAssistantConsent(bytes: Uint8Array): AssistantConsent {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_ASSISTANT_CONSENT_BYTES
  ) {
    throw new E2eeError(
      'malformed',
      'An assistant consent record is malformed'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
  } catch {
    throw new E2eeError('malformed', 'An assistant consent record is not JSON');
  }
  const value = parsed as Record<string, unknown> | null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new E2eeError(
      'malformed',
      'An assistant consent record is malformed'
    );
  }
  if (value.v !== ASSISTANT_CONSENT_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      'An assistant consent record has a version this build does not know'
    );
  }
  if (value.kind !== 'assistant-consent') {
    throw new E2eeError('context-mismatch', 'Not an assistant consent record');
  }
  let record: AssistantConsent;
  try {
    record = {
      userId: value.userId as string,
      projectId: value.projectId as string,
      allowed: value.allowed as boolean,
      copyVersion: value.copyVersion as number,
      route: value.route as string,
      sequence: value.sequence as number
    };
    if (!equalBytes(encodeAssistantConsent(record), bytes)) throw new Error();
  } catch {
    throw new E2eeError(
      'malformed',
      'An assistant consent record is not in canonical form'
    );
  }
  return record;
}

async function assistantConsentMacKey(
  accountKey: Uint8Array
): Promise<CryptoKey> {
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: utf8(ASSISTANT_CONSENT_MAC_INFO)
    },
    await hkdfBaseKey(accountKey, 'An account key'),
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify']
  );
}

/** HMAC-SHA-256 of the canonical record under the account key's MAC key. */
export async function macAssistantConsent(
  accountKey: Uint8Array,
  record: Uint8Array
): Promise<Bytes> {
  const bytes = asBytes(record);
  decodeAssistantConsent(bytes);
  const key = await assistantConsentMacKey(accountKey);
  return new Uint8Array(await subtle().sign('HMAC', key, bytes));
}

/**
 * The record, once its MAC verifies under this account key and it decodes.
 * Throws `authentication-failed` for a wrong key or altered bytes.
 */
export async function openAssistantConsent(
  accountKey: Uint8Array,
  record: Uint8Array,
  mac: Uint8Array
): Promise<AssistantConsent> {
  const bytes = asBytes(record);
  const decoded = decodeAssistantConsent(bytes);
  if (
    !(mac instanceof Uint8Array) ||
    mac.byteLength !== ASSISTANT_CONSENT_MAC_BYTES
  ) {
    throw new E2eeError('malformed', 'A record MAC is 32 bytes');
  }
  const key = await assistantConsentMacKey(accountKey);
  if (!(await subtle().verify('HMAC', key, asBytes(mac), bytes))) {
    throw new E2eeError(
      'authentication-failed',
      'The assistant consent record failed authentication: wrong key or altered bytes'
    );
  }
  return decoded;
}
