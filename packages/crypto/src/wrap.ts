import {
  ByteReader,
  ByteWriter,
  asBytes,
  concatBytes,
  copyBytes,
  isUint,
  label,
  snapshotBytes,
  utf8,
  type Bytes
} from './bytes';
import { E2eeError } from './errors';
import { PROJECT_ENVELOPE_KINDS } from './header';
import {
  P256_PUBLIC_KEY_BYTES,
  exportPublicKey,
  isP256Key,
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

/**
 * Private-key wrap: AES-256-GCM with a random IV under an HKDF-SHA256 KEK,
 * context in the AAD. PKCS #8 keys are not a multiple of 8 bytes, so AES-KW
 * cannot take them.
 */
export const WRAP_VERSION_GCM = 1;
/**
 * Symmetric-key wrap: AES-256-KW (RFC 3394), no nonce, under a KEK derived
 * with HKDF-SHA256 from the parent key and the canonical context, so a wrap
 * opens only for the context it was made for.
 */
export const WRAP_VERSION_KW = 2;
/** Public-key seal: ephemeral ECDH P-256, HKDF-SHA256, AES-256-GCM. */
export const SEAL_VERSION_1 = 1;

export const UNLOCK_METHODS = Object.freeze([
  'device',
  'passkey-prf',
  'recovery-key',
  'device-approval'
] as const);
export type UnlockMethod = (typeof UNLOCK_METHODS)[number];
/** Only these open the identity key; device keys and the account key never do. */
export const IDENTITY_UNLOCK_METHODS = Object.freeze([
  'passkey-prf',
  'recovery-key'
] as const);
export type IdentityUnlockMethod = (typeof IDENTITY_UNLOCK_METHODS)[number];

/**
 * Private keys travel as PKCS #8 bytes under AES-GCM; every other purpose
 * wraps a 32-byte symmetric key with AES-KW.
 */
const PRIVATE_KEY_PURPOSES: readonly WrapPurpose[] = [
  'identity-key',
  'encryption-private-key',
  'unlock-target-key'
];

const isPrivateKeyPurpose = (purpose: WrapPurpose): boolean =>
  PRIVATE_KEY_PURPOSES.includes(purpose);

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
       * The identity private key (PKCS #8), sealed to the certified public
       * key of the recovery key or of a passkey only; never to a device.
       */
      readonly purpose: 'identity-key';
      readonly userId: string;
      readonly method: IdentityUnlockMethod;
      readonly unlockId: string;
    }
  | {
      /**
       * The private half (PKCS #8) of an unlock method's ECDH target, under
       * that method's secret: the recovery key or a passkey PRF output. The
       * identity key hash binds the target to the identity it was made for,
       * so a server cannot pair a genuine target with an identity of its own.
       */
      readonly purpose: 'unlock-target-key';
      readonly userId: string;
      readonly method: IdentityUnlockMethod;
      readonly unlockId: string;
      /** Lowercase hex `publicKeyHash` of the identity public key. */
      readonly identityKeyHash: string;
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
      /**
       * The project's dedupe secret, re-wrapped under each epoch's project
       * key so dedupe hashes survive key rotation.
       */
      readonly purpose: 'dedupe-secret';
      readonly projectId: string;
      readonly keyEpoch: number;
    }
  | {
      /** A share-link key under the project key. It never encrypts content. */
      readonly purpose: 'share-key';
      readonly projectId: string;
      readonly keyEpoch: number;
      readonly shareId: string;
    }
  | {
      /**
       * A share snapshot's version key under the share key, for link
       * visitors; members open the same key through its `version-key` wrap.
       */
      readonly purpose: 'share-version-key';
      readonly projectId: string;
      readonly shareId: string;
      readonly versionId: string;
    };

export type WrapPurpose = WrapContext['purpose'];

/**
 * The only contexts a key may be sealed to a public key under. Every unlock
 * method is a public-key target (ADR-024, Unlock and devices): the account
 * key is sealed to each certified device unlock key, recovery-key target and
 * passkey target, and to a device being approved; the identity key only to
 * the recovery-key and passkey targets (the context schema refuses any other
 * method); a project key to a member. The encryption private key, version,
 * share and dedupe keys and unlock-target keys are never sealed.
 */
export type SealContext =
  | Extract<WrapContext, { purpose: 'account-key' }>
  | Extract<WrapContext, { purpose: 'identity-key' }>
  | Extract<WrapContext, { purpose: 'project-key' }>;

const SEAL_PURPOSES: readonly WrapPurpose[] = [
  'account-key',
  'identity-key',
  'project-key'
];

function checkSealContext(context: WrapContext): void {
  if (!SEAL_PURPOSES.includes(context?.purpose)) {
    throw new E2eeError(
      'invalid-argument',
      'Only an account key, an identity key or a project key may be sealed'
    );
  }
}

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
  'unlock-target-key': {
    userId: 'string',
    method: IDENTITY_UNLOCK_METHODS,
    unlockId: 'string',
    identityKeyHash: 'string'
  },
  'project-key': { userId: 'string', projectId: 'string', keyEpoch: 'uint' },
  'version-key': {
    projectId: 'string',
    keyEpoch: 'uint',
    kind: PROJECT_ENVELOPE_KINDS,
    versionId: 'string'
  },
  'share-key': { projectId: 'string', keyEpoch: 'uint', shareId: 'string' },
  'dedupe-secret': { projectId: 'string', keyEpoch: 'uint' },
  'share-version-key': {
    projectId: 'string',
    shareId: 'string',
    versionId: 'string'
  }
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
  if (
    names.length !== expected.length ||
    names.some((name, i) => name !== expected[i])
  ) {
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

const MAX_PRIVATE_KEY_BYTES = 4096;

/** Smallest and largest secret a purpose wraps: a PKCS#8 key or 32 bytes. */
function secretBounds(context: WrapContext): [min: number, max: number] {
  return PRIVATE_KEY_PURPOSES.includes(context.purpose)
    ? [1, MAX_PRIVATE_KEY_BYTES]
    : [KEY_BYTES, KEY_BYTES];
}

function checkSecretLength(secret: Uint8Array, context: WrapContext): void {
  const [min, max] = secretBounds(context);
  if (secret.byteLength < min || secret.byteLength > max) {
    throw new E2eeError(
      'invalid-argument',
      min === max
        ? 'Wrapped keys must be 32 bytes'
        : `Private key bytes must be 1..${MAX_PRIVATE_KEY_BYTES} bytes`
    );
  }
}

/**
 * Refuses a GCM record whose ciphertext cannot hold a secret of this
 * purpose before WebCrypto decrypts it, so an oversized record from the
 * server costs nothing to reject.
 */
function checkCiphertextLength(
  length: number,
  context: WrapContext,
  what: string
): void {
  const [min, max] = secretBounds(context);
  if (length < GCM_TAG_BYTES + min) {
    throw new E2eeError('malformed', `${what} is truncated`);
  }
  if (length > GCM_TAG_BYTES + max) {
    throw new E2eeError(
      'malformed',
      `${what} is longer than any ${context.purpose} secret`
    );
  }
}

async function gcmKek(
  kek: KeyMaterial,
  purpose: WrapPurpose
): Promise<CryptoKey> {
  return deriveAesGcmKey(
    await hkdfBaseKey(kek, 'Wrapping key'),
    new Uint8Array(),
    label(`v1 wrap ${purpose}`)
  );
}

async function kwKek(
  kek: KeyMaterial,
  context: WrapContext,
  encodedContext: Uint8Array
): Promise<CryptoKey> {
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: concatBytes(label(`v1 kw ${context.purpose}`), encodedContext)
    },
    await hkdfBaseKey(kek, 'Wrapping key'),
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Copies of a parent key and a context, taken before the first await: a
 * caller that clears its key buffer or edits the context while a call is
 * pending must not get a wrap made from something else.
 */
function snapshotKek(kek: KeyMaterial): KeyMaterial {
  // Raw parent keys are 32 bytes; any other is passed through for the KEK
  // derivation to refuse, never copied.
  return kek instanceof Uint8Array && kek.byteLength === KEY_BYTES
    ? copyBytes(kek)
    : kek;
}

/** Largest wrapped or sealed record any purpose produces. */
const MAX_WRAP_RECORD_BYTES =
  1 + GCM_IV_BYTES + GCM_TAG_BYTES + MAX_PRIVATE_KEY_BYTES;
const MAX_SEAL_RECORD_BYTES =
  1 +
  P256_PUBLIC_KEY_BYTES +
  GCM_IV_BYTES +
  GCM_TAG_BYTES +
  MAX_PRIVATE_KEY_BYTES;

function snapshotContext<C extends WrapContext>(context: C): C {
  return context !== null && typeof context === 'object'
    ? { ...context }
    : context;
}

/** @internal Tests inject the IV source; production uses `wrapKey`. */
export async function wrapKeyWith(
  kek: KeyMaterial,
  secret: Uint8Array,
  context: WrapContext,
  random: RandomSource
): Promise<Bytes> {
  kek = snapshotKek(kek);
  context = snapshotContext(context);
  const encodedContext = encodeWrapContext(context);
  secret = snapshotBytes(secret, 'Secret', MAX_PRIVATE_KEY_BYTES);
  checkSecretLength(secret, context);
  if (!isPrivateKeyPurpose(context.purpose)) {
    const toWrap = await subtle().importKey(
      'raw',
      asBytes(secret),
      'AES-GCM',
      true,
      ['encrypt']
    );
    const wrapped = await subtle().wrapKey(
      'raw',
      toWrap,
      await kwKek(kek, context, encodedContext),
      'AES-KW'
    );
    return concatBytes(Uint8Array.of(WRAP_VERSION_KW), new Uint8Array(wrapped));
  }
  const iv = random(GCM_IV_BYTES);
  const version = Uint8Array.of(WRAP_VERSION_GCM);
  const ciphertext = await aesGcmEncrypt(
    await gcmKek(kek, context.purpose),
    iv,
    concatBytes(version, encodedContext),
    secret
  );
  return concatBytes(version, iv, ciphertext);
}

/**
 * Wraps a key under a long-lived parent secret: a version or share key
 * under the project key, a share snapshot's version key under the share
 * key, a project key or the encryption private key under the account key,
 * the account key under an unlock secret, or the identity key under the
 * recovery key or a passkey.
 *
 * Symmetric keys use AES-KW (`u8 2 | 40 bytes`), which takes no nonce; the
 * context is bound by deriving the KEK from it. Private keys use AES-GCM
 * with a fresh random IV (`u8 1 | 12-byte IV | ciphertext+tag`) and the
 * context in the AAD. Each purpose derives its own KEK.
 */
export async function wrapKey(
  kek: KeyMaterial,
  secret: Uint8Array,
  context: WrapContext
): Promise<Bytes> {
  return wrapKeyWith(kek, secret, context, systemRandom);
}

function readVersion(bytes: Uint8Array, expected: number, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new E2eeError('malformed', `${what} is empty`);
  }
  if (bytes[0] !== expected) {
    throw new E2eeError(
      'unsupported-version',
      `${what} version ${bytes[0]} is not supported`
    );
  }
}

/** A known wrap format used for the wrong purpose is malformed, not new. */
function readWrapVersion(bytes: Uint8Array, expected: number): void {
  const other =
    expected === WRAP_VERSION_KW ? WRAP_VERSION_GCM : WRAP_VERSION_KW;
  if (bytes instanceof Uint8Array && bytes[0] === other) {
    throw new E2eeError(
      'malformed',
      'Wrapped key uses the other wrap format for this purpose'
    );
  }
  readVersion(bytes, expected, 'Wrapped key');
}

const KW_WRAPPED_BYTES = 1 + KEY_BYTES + 8;

export async function unwrapKey(
  kek: KeyMaterial,
  wrapped: Uint8Array,
  context: WrapContext
): Promise<Bytes> {
  kek = snapshotKek(kek);
  context = snapshotContext(context);
  const encodedContext = encodeWrapContext(context);
  wrapped = snapshotBytes(
    wrapped,
    'Wrapped key',
    MAX_WRAP_RECORD_BYTES,
    'malformed'
  );
  if (!isPrivateKeyPurpose(context.purpose)) {
    readWrapVersion(wrapped, WRAP_VERSION_KW);
    if (wrapped.byteLength !== KW_WRAPPED_BYTES) {
      throw new E2eeError('malformed', 'An AES-KW wrap is 41 bytes');
    }
    const kwKey = await kwKek(kek, context, encodedContext);
    let key: CryptoKey;
    try {
      key = await subtle().unwrapKey(
        'raw',
        asBytes(wrapped.subarray(1)),
        kwKey,
        'AES-KW',
        'AES-GCM',
        true,
        ['encrypt']
      );
    } catch (cause) {
      throw new E2eeError(
        'authentication-failed',
        'Wrapped key failed authentication: wrong key, wrong context or altered bytes',
        { cause }
      );
    }
    return new Uint8Array(await subtle().exportKey('raw', key));
  }
  readWrapVersion(wrapped, WRAP_VERSION_GCM);
  const reader = new ByteReader(wrapped, 'Wrapped key');
  const version = reader.bytes(1);
  const iv = reader.bytes(GCM_IV_BYTES);
  checkCiphertextLength(reader.remaining, context, 'Wrapped key');
  const secret = await aesGcmDecrypt(
    await gcmKek(kek, context.purpose),
    iv,
    concatBytes(version, encodedContext),
    reader.bytes(reader.remaining),
    'Wrapped key'
  );
  checkSecretLength(secret, context);
  return secret;
}

export interface ShareSnapshotKeyContext {
  readonly projectId: string;
  readonly keyEpoch: number;
  readonly shareId: string;
  readonly versionId: string;
}

export interface ShareSnapshotKeyWraps {
  /** Under the project key (`version-key`), for members. */
  readonly forMembers: Bytes;
  /** Under the share key (`share-version-key`), for link visitors. */
  readonly forLinkVisitors: Bytes;
}

/**
 * Wraps a share snapshot's fresh version key twice with AES-KW: under the
 * project key for members and under the share key for link visitors. The
 * share key itself never encrypts content.
 */
export async function wrapShareSnapshotKey(
  projectKey: KeyMaterial,
  shareKey: KeyMaterial,
  versionKey: Uint8Array,
  context: ShareSnapshotKeyContext
): Promise<ShareSnapshotKeyWraps> {
  // One copy of every input for both wraps, so members and link visitors
  // open the same key under the context the call began with.
  versionKey = snapshotBytes(versionKey, 'Version key', KEY_BYTES);
  projectKey = snapshotKek(projectKey);
  shareKey = snapshotKek(shareKey);
  context = { ...context };
  const forMembers = await wrapKey(projectKey, versionKey, {
    purpose: 'version-key',
    projectId: context.projectId,
    keyEpoch: context.keyEpoch,
    kind: 'share-snapshot',
    versionId: context.versionId
  });
  const forLinkVisitors = await wrapKey(shareKey, versionKey, {
    purpose: 'share-version-key',
    projectId: context.projectId,
    shareId: context.shareId,
    versionId: context.versionId
  });
  return { forMembers, forLinkVisitors };
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
  context: SealContext,
  ephemeral: CryptoKeyPair,
  random: RandomSource
): Promise<Bytes> {
  context = snapshotContext(context);
  const aadContext = encodeWrapContext(context);
  checkSealContext(context);
  secret = snapshotBytes(secret, 'Secret', MAX_PRIVATE_KEY_BYTES);
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
 * Seals a key to someone's ECDH public key: a project key to a member, the
 * account key to a certified unlock target or a device being approved, or
 * the identity key to the recovery-key or a passkey target. Output: `u8
 * version, 65-byte ephemeral public key, 12-byte IV, ciphertext+tag`.
 */
export async function sealKey(
  recipientPublicKey: Uint8Array | CryptoKey,
  secret: Uint8Array,
  context: SealContext
): Promise<Bytes> {
  context = snapshotContext(context);
  checkSealContext(context);
  // Copy caller bytes before the first await (see `snapshotBytes`).
  const recipient =
    recipientPublicKey instanceof Uint8Array
      ? snapshotBytes(
          recipientPublicKey,
          'Public key',
          P256_PUBLIC_KEY_BYTES,
          'malformed'
        )
      : recipientPublicKey;
  const secretBytes = snapshotBytes(secret, 'Secret', MAX_PRIVATE_KEY_BYTES);
  const ephemeral = await subtle().generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  return sealKeyWith(recipient, secretBytes, context, ephemeral, systemRandom);
}

export interface SealRecipient {
  readonly privateKey: CryptoKey;
  /** Bound into the KDF, so a seal opens only for the key it named. */
  readonly publicKey: Uint8Array | CryptoKey;
}

export async function openSealedKey(
  recipient: SealRecipient,
  sealed: Uint8Array,
  context: SealContext
): Promise<Bytes> {
  context = snapshotContext(context);
  const aadContext = encodeWrapContext(context);
  checkSealContext(context);
  sealed = snapshotBytes(
    sealed,
    'Sealed key',
    MAX_SEAL_RECORD_BYTES,
    'malformed'
  );
  readVersion(sealed, SEAL_VERSION_1, 'Sealed key');
  const reader = new ByteReader(sealed, 'Sealed key');
  const version = reader.bytes(1);
  const ephemeralRaw = reader.bytes(P256_PUBLIC_KEY_BYTES);
  const iv = reader.bytes(GCM_IV_BYTES);
  checkCiphertextLength(reader.remaining, context, 'Sealed key');
  // Read the recipient once: the object may change while keys import.
  const privateKey = recipient?.privateKey;
  const publicKey = recipient?.publicKey;
  if (!isP256Key(privateKey, 'ECDH', 'private')) {
    throw new E2eeError(
      'invalid-argument',
      'Expected a P-256 ECDH private key'
    );
  }
  // Both start now, so each copies its raw bytes before anything is awaited.
  const [ephemeral, own] = await Promise.all([
    toEncryptionPublicKey(ephemeralRaw),
    toEncryptionPublicKey(publicKey)
  ]);
  let kek: CryptoKey;
  try {
    kek = await sealKek(
      privateKey,
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
