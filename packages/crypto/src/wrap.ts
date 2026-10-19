import {
  ByteReader,
  ByteWriter,
  concatBytes,
  isUint,
  label,
  utf8,
  type Bytes
} from './bytes';
import { E2eeError } from './errors';
import { PROJECT_ENVELOPE_KINDS } from './header';
import {
  P256_PUBLIC_KEY_BYTES,
  exportPublicKey,
  toEncryptionPublicKey
} from './keys';
import {
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  KEY_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveAesGcmKey,
  hkdfBaseKey,
  importHkdfInput,
  subtle,
  systemRandom,
  type KeyMaterial,
  type RandomSource
} from './primitives';

/** Symmetric wrap: AES-256-GCM under an HKDF-SHA256 KEK, context in the AAD. */
export const WRAP_VERSION_1 = 1;
/** Public-key seal: ephemeral ECDH P-256, HKDF-SHA256, AES-256-GCM. */
export const SEAL_VERSION_1 = 1;

export const UNLOCK_METHODS = [
  'device',
  'passkey-prf',
  'recovery-key',
  'device-approval'
] as const;
export type UnlockMethod = (typeof UNLOCK_METHODS)[number];
/** Only these open the identity key; device keys and the account key never do. */
export const IDENTITY_UNLOCK_METHODS = ['passkey-prf', 'recovery-key'] as const;
export type IdentityUnlockMethod = (typeof IDENTITY_UNLOCK_METHODS)[number];

/** Private keys travel as PKCS #8 bytes; symmetric keys are 32 bytes. */
const PRIVATE_KEY_PURPOSES: readonly WrapPurpose[] = [
  'identity-key',
  'encryption-private-key'
];

/**
 * What a wrapped key is for and whose it is. Every field is bound into the
 * AAD, so a wrap moved to another user, project, epoch or envelope fails.
 */
export type WrapContext =
  | {
      /** The account key, under an unlock method (or sealed to a new device). */
      readonly purpose: 'account-key';
      readonly userId: string;
      readonly method: UnlockMethod;
      /** Device id, passkey credential id or recovery-key id. */
      readonly unlockId: string;
    }
  | {
      /**
       * The identity private key (PKCS #8), under the recovery key or a
       * passkey PRF secret only.
       */
      readonly purpose: 'identity-key';
      readonly userId: string;
      readonly method: IdentityUnlockMethod;
      readonly unlockId: string;
    }
  | {
      /** The encryption private key (PKCS #8) under the account key. */
      readonly purpose: 'encryption-private-key';
      readonly userId: string;
      /** Names the certified key, for example its key hash in hex. */
      readonly keyId: string;
    }
  | {
      /** A project key, sealed to a member or under their account key. */
      readonly purpose: 'project-key';
      readonly userId: string;
      readonly projectId: string;
      readonly keyEpoch: number;
    }
  | {
      /** A project envelope's version key under the project key. */
      readonly purpose: 'version-key';
      readonly projectId: string;
      readonly keyEpoch: number;
      readonly kind: (typeof PROJECT_ENVELOPE_KINDS)[number];
      /** Names the envelope, for example its document version. */
      readonly versionId: string;
    }
  | {
      /** A share-link key under the project key. */
      readonly purpose: 'share-key';
      readonly projectId: string;
      readonly keyEpoch: number;
      readonly shareId: string;
    };

export type WrapPurpose = WrapContext['purpose'];

type FieldRule = 'string' | 'uint' | readonly string[];

const CONTEXT_FIELDS: Record<WrapPurpose, Record<string, FieldRule>> = {
  'account-key': {
    userId: 'string',
    method: UNLOCK_METHODS,
    unlockId: 'string'
  },
  'identity-key': {
    userId: 'string',
    method: IDENTITY_UNLOCK_METHODS,
    unlockId: 'string'
  },
  'encryption-private-key': { userId: 'string', keyId: 'string' },
  'project-key': { userId: 'string', projectId: 'string', keyEpoch: 'uint' },
  'version-key': {
    projectId: 'string',
    keyEpoch: 'uint',
    kind: PROJECT_ENVELOPE_KINDS,
    versionId: 'string'
  },
  'share-key': { projectId: 'string', keyEpoch: 'uint', shareId: 'string' }
};

const MAX_CONTEXT_STRING = 256;

/**
 * Canonical bytes of a context: fields sorted by name, each as
 * `u8 name length, name, u8 type (1 string, 2 uint), value` where a string
 * is `u16 length, UTF-8` and a uint is a u64.
 */
export function encodeWrapContext(context: WrapContext): Bytes {
  const purpose = (context as { purpose?: unknown } | null)?.purpose;
  const fields =
    typeof purpose === 'string' && Object.hasOwn(CONTEXT_FIELDS, purpose)
      ? CONTEXT_FIELDS[purpose as WrapPurpose]
      : undefined;
  if (!fields) throw new E2eeError('invalid-argument', 'Unknown wrap purpose');
  const record = context as unknown as Record<string, unknown>;
  const names = Object.keys(record).sort();
  const expected = ['purpose', ...Object.keys(fields)].sort();
  if (names.join() !== expected.join()) {
    throw new E2eeError(
      'invalid-argument',
      `A ${context.purpose} context has exactly: ${expected.join(', ')}`
    );
  }
  const writer = new ByteWriter();
  for (const name of names) {
    const value = record[name];
    const rule = name === 'purpose' ? 'string' : fields[name]!;
    writer.u8(name.length).bytes(utf8(name));
    if (rule === 'uint') {
      if (!isUint(value, 0xffffffff)) {
        throw new E2eeError('invalid-argument', `${name} must be a u32`);
      }
      writer.u8(2).u64(value);
      continue;
    }
    const text = typeof value === 'string' ? utf8(value) : null;
    if (
      text === null ||
      text.byteLength === 0 ||
      text.byteLength > MAX_CONTEXT_STRING ||
      (Array.isArray(rule) && !rule.includes(value))
    ) {
      throw new E2eeError(
        'invalid-argument',
        `${name} is not a valid ${context.purpose} field`
      );
    }
    writer.u8(1).u16(text.byteLength).bytes(text);
  }
  return writer.finish();
}

function checkSecretLength(secret: Uint8Array, context: WrapContext): void {
  const privateKey = PRIVATE_KEY_PURPOSES.includes(context.purpose);
  const ok = privateKey
    ? secret.byteLength > 0 && secret.byteLength <= 4096
    : secret.byteLength === KEY_BYTES;
  if (!ok) {
    throw new E2eeError(
      'invalid-argument',
      privateKey
        ? 'Private key bytes must be 1..4096 bytes'
        : 'Wrapped keys must be 32 bytes'
    );
  }
}

async function wrapKek(
  kek: KeyMaterial,
  purpose: WrapPurpose
): Promise<CryptoKey> {
  return deriveAesGcmKey(
    await hkdfBaseKey(kek, 'Wrapping key'),
    new Uint8Array(),
    label(`v1 wrap ${purpose}`)
  );
}

/** @internal Tests inject the IV source; production uses `wrapKey`. */
export async function wrapKeyWith(
  kek: KeyMaterial,
  secret: Uint8Array,
  context: WrapContext,
  random: RandomSource
): Promise<Bytes> {
  const aadContext = encodeWrapContext(context);
  checkSecretLength(secret, context);
  const iv = random(GCM_IV_BYTES);
  const version = Uint8Array.of(WRAP_VERSION_1);
  const ciphertext = await aesGcmEncrypt(
    await wrapKek(kek, context.purpose),
    iv,
    concatBytes(version, aadContext),
    secret
  );
  return concatBytes(version, iv, ciphertext);
}

/**
 * Wraps a key under a long-lived parent secret: a version or share key
 * under the project key, a project key or user private key under the
 * account key, or the account key under an unlock secret. Output:
 * `u8 version, 12-byte IV, ciphertext+tag`.
 *
 * This is AES-256-GCM with a fresh random 96-bit IV stored beside the
 * ciphertext (ADR-024 allows it in place of AES-KW), because AES-KW cannot
 * bind the context. Each purpose derives its own KEK, and a parent key
 * wraps far fewer than 2^32 items before an epoch or rotation replaces it.
 */
export async function wrapKey(
  kek: KeyMaterial,
  secret: Uint8Array,
  context: WrapContext
): Promise<Bytes> {
  return wrapKeyWith(kek, secret, context, systemRandom);
}

function readVersion(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.byteLength === 0)
    throw new E2eeError('malformed', `${what} is empty`);
  if (bytes[0] !== expected) {
    throw new E2eeError(
      'unsupported-version',
      `${what} version ${bytes[0]} is not supported`
    );
  }
}

export async function unwrapKey(
  kek: KeyMaterial,
  wrapped: Uint8Array,
  context: WrapContext
): Promise<Bytes> {
  const aadContext = encodeWrapContext(context);
  readVersion(wrapped, WRAP_VERSION_1, 'Wrapped key');
  const reader = new ByteReader(wrapped, 'Wrapped key');
  const version = reader.bytes(1);
  const iv = reader.bytes(GCM_IV_BYTES);
  if (reader.remaining < GCM_TAG_BYTES + 1) {
    throw new E2eeError('malformed', 'Wrapped key is truncated');
  }
  const secret = await aesGcmDecrypt(
    await wrapKek(kek, context.purpose),
    iv,
    concatBytes(version, aadContext),
    reader.bytes(reader.remaining),
    'Wrapped key'
  );
  checkSecretLength(secret, context);
  return secret;
}

async function sealKek(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  ephemeralRaw: Uint8Array,
  recipientRaw: Uint8Array,
  purpose: WrapPurpose
): Promise<CryptoKey> {
  const shared = await subtle().deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
  return deriveAesGcmKey(
    await importHkdfInput(new Uint8Array(shared)),
    concatBytes(ephemeralRaw, recipientRaw),
    label(`v1 seal ${purpose}`)
  );
}

/** @internal Tests inject the ephemeral pair and IV; production uses `sealKey`. */
export async function sealKeyWith(
  recipientPublicKey: Uint8Array | CryptoKey,
  secret: Uint8Array,
  context: WrapContext,
  ephemeral: CryptoKeyPair,
  random: RandomSource
): Promise<Bytes> {
  const aadContext = encodeWrapContext(context);
  checkSecretLength(secret, context);
  const recipient = await toEncryptionPublicKey(recipientPublicKey);
  const ephemeralRaw = await exportPublicKey(ephemeral.publicKey);
  const version = Uint8Array.of(SEAL_VERSION_1);
  const iv = random(GCM_IV_BYTES);
  const ciphertext = await aesGcmEncrypt(
    await sealKek(
      ephemeral.privateKey,
      recipient.key,
      ephemeralRaw,
      recipient.raw,
      context.purpose
    ),
    iv,
    concatBytes(version, ephemeralRaw, aadContext),
    secret
  );
  return concatBytes(version, ephemeralRaw, iv, ciphertext);
}

/**
 * Seals a key to someone's ECDH public key: a project key to a member, or
 * the account key to a newly approved device. Output: `u8 version,
 * 65-byte ephemeral public key, 12-byte IV, ciphertext+tag`.
 */
export async function sealKey(
  recipientPublicKey: Uint8Array | CryptoKey,
  secret: Uint8Array,
  context: WrapContext
): Promise<Bytes> {
  const ephemeral = await subtle().generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  return sealKeyWith(
    recipientPublicKey,
    secret,
    context,
    ephemeral,
    systemRandom
  );
}

export interface SealRecipient {
  readonly privateKey: CryptoKey;
  /** Bound into the KDF, so a seal opens only for the key it named. */
  readonly publicKey: Uint8Array | CryptoKey;
}

export async function openSealedKey(
  recipient: SealRecipient,
  sealed: Uint8Array,
  context: WrapContext
): Promise<Bytes> {
  const aadContext = encodeWrapContext(context);
  readVersion(sealed, SEAL_VERSION_1, 'Sealed key');
  const reader = new ByteReader(sealed, 'Sealed key');
  const version = reader.bytes(1);
  const ephemeralRaw = reader.bytes(P256_PUBLIC_KEY_BYTES);
  const iv = reader.bytes(GCM_IV_BYTES);
  if (reader.remaining < GCM_TAG_BYTES + 1) {
    throw new E2eeError('malformed', 'Sealed key is truncated');
  }
  const ephemeral = await toEncryptionPublicKey(ephemeralRaw);
  const own = await toEncryptionPublicKey(recipient.publicKey);
  let kek: CryptoKey;
  try {
    kek = await sealKek(
      recipient.privateKey,
      ephemeral.key,
      ephemeralRaw,
      own.raw,
      context.purpose
    );
  } catch (cause) {
    throw new E2eeError(
      'invalid-argument',
      'Recipient private key cannot derive ECDH secrets',
      {
        cause
      }
    );
  }
  const secret = await aesGcmDecrypt(
    kek,
    iv,
    concatBytes(version, ephemeralRaw, aadContext),
    reader.bytes(reader.remaining),
    'Sealed key'
  );
  checkSecretLength(secret, context);
  return secret;
}
