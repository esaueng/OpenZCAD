import { asBytes, equalBytes, utf8, type Bytes } from './bytes';
import { E2eeError } from './errors';
import { hkdfBaseKey, subtle } from './primitives';

/**
 * Account records the server stores but must not be able to forge or roll
 * back (ADR-024 decision D2): the "encrypt new projects" opt-in today. Each
 * is canonical JSON, MAC'd with HMAC-SHA-256 under a key derived from the
 * account key by HKDF-SHA-256 (empty salt) with a per-record-kind info
 * label, so a MAC for one kind never verifies as another. Browsers pin the
 * highest sequence they accepted; the server only checks that a sequence
 * moves forward.
 */

/** HKDF info for the project-preferences MAC key. A storage-format constant. */
export const PROJECT_PREFERENCES_MAC_INFO =
  'OpenZCAD E2EE v1 project preferences mac';

export const PROJECT_PREFERENCES_VERSION_1 = 1;
export const ACCOUNT_RECORD_MAC_BYTES = 32;
/** Longest encoded preference record accepted; user ids are at most 128. */
export const MAX_PROJECT_PREFERENCES_BYTES = 512;

export interface ProjectPreferences {
  readonly userId: string;
  readonly encryptNewProjects: boolean;
  /** Strictly increases with every write; a reader refuses a lower one. */
  readonly sequence: number;
}

function validUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function validSequence(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 0xffffffff
  );
}

/** The canonical bytes: fixed key order, no whitespace. */
export function encodeProjectPreferences(record: ProjectPreferences): Bytes {
  if (
    !validUserId(record?.userId) ||
    typeof record.encryptNewProjects !== 'boolean' ||
    !validSequence(record.sequence)
  ) {
    throw new E2eeError(
      'invalid-argument',
      'A project preference record needs a user id, a boolean and a sequence from 1'
    );
  }
  return utf8(
    JSON.stringify({
      v: PROJECT_PREFERENCES_VERSION_1,
      kind: 'project-preferences',
      userId: record.userId,
      encryptNewProjects: record.encryptNewProjects,
      sequence: record.sequence
    })
  );
}

/**
 * Parses canonical bytes. Anything that does not re-encode to exactly the
 * same bytes is refused, so two encodings of one record cannot both carry a
 * valid MAC.
 */
export function decodeProjectPreferences(
  bytes: Uint8Array
): ProjectPreferences {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_PROJECT_PREFERENCES_BYTES
  ) {
    throw new E2eeError(
      'malformed',
      'A project preference record is malformed'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
  } catch {
    throw new E2eeError('malformed', 'A project preference record is not JSON');
  }
  const value = parsed as Record<string, unknown> | null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new E2eeError(
      'malformed',
      'A project preference record is malformed'
    );
  }
  if (value.v !== PROJECT_PREFERENCES_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      'A project preference record has a version this build does not know'
    );
  }
  if (value.kind !== 'project-preferences') {
    throw new E2eeError('context-mismatch', 'Not a project preference record');
  }
  let record: ProjectPreferences;
  try {
    record = {
      userId: value.userId as string,
      encryptNewProjects: value.encryptNewProjects as boolean,
      sequence: value.sequence as number
    };
    if (!equalBytes(encodeProjectPreferences(record), bytes)) throw new Error();
  } catch {
    throw new E2eeError(
      'malformed',
      'A project preference record is not in canonical form'
    );
  }
  return record;
}

async function projectPreferencesMacKey(
  accountKey: Uint8Array
): Promise<CryptoKey> {
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: utf8(PROJECT_PREFERENCES_MAC_INFO)
    },
    await hkdfBaseKey(accountKey, 'An account key'),
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify']
  );
}

/** HMAC-SHA-256 of the canonical record under the account key's MAC key. */
export async function macProjectPreferences(
  accountKey: Uint8Array,
  record: Uint8Array
): Promise<Bytes> {
  const bytes = asBytes(record);
  decodeProjectPreferences(bytes);
  const key = await projectPreferencesMacKey(accountKey);
  return new Uint8Array(await subtle().sign('HMAC', key, bytes));
}

/**
 * The record, once its MAC verifies under this account key and it decodes.
 * Throws `authentication-failed` for a wrong key or altered bytes.
 */
export async function openProjectPreferences(
  accountKey: Uint8Array,
  record: Uint8Array,
  mac: Uint8Array
): Promise<ProjectPreferences> {
  const bytes = asBytes(record);
  const decoded = decodeProjectPreferences(bytes);
  if (
    !(mac instanceof Uint8Array) ||
    mac.byteLength !== ACCOUNT_RECORD_MAC_BYTES
  ) {
    throw new E2eeError('malformed', 'A record MAC is 32 bytes');
  }
  const key = await projectPreferencesMacKey(accountKey);
  if (!(await subtle().verify('HMAC', key, asBytes(mac), bytes))) {
    throw new E2eeError(
      'authentication-failed',
      'The project preference record failed authentication: wrong key or altered bytes'
    );
  }
  return decoded;
}
