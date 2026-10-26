/**
 * Real-browser scenarios for `@openzcad/crypto`: envelopes (including
 * chunked and streamed content blobs), key wrap, seal and open, signatures
 * over project envelopes and device statements, the project data formats
 * (the project-info and key-archive kinds and their bodies, the epoch
 * binding, the version log and its authorship check), the external-key seam,
 * and fixed vectors that must come out byte-identical in every engine. Test
 * code only (not exported from the package): `run.mjs` runs it on a page in
 * Chromium, WebKit and Firefox, and `test/crypto-browser-scenarios.test.ts`
 * runs the same steps in Node so they cannot rot unnoticed in CI. No test
 * framework, so the steps run anywhere WebCrypto and web streams exist.
 *
 * Every step goes through the package and must pass on every engine, except
 * the steps marked `engineProbe`: those call the engine's WebCrypto
 * directly to describe the engine, and report a warning, not a failure,
 * when the engine falls short in a way the package already guards against.
 */
import {
  decodeEncryptedDocumentBody,
  decodeKeyArchiveBody,
  decodeProjectInfoBody,
  encodeEncryptedDocumentBody,
  encodeKeyArchiveBody,
  encodeProjectInfoBody
} from '../src/bodies';
import { concatBytes, fromHex, toHex, type Bytes } from '../src/bytes';
import {
  assetDedupeHash,
  commitDeviceApproval,
  createApprovalNonce,
  deviceApprovalCode,
  deviceKeysHash,
  epochBinding,
  formatRecoveryKey,
  generateAssetDedupeSecret,
  generateRecoveryKey,
  importAssetDedupeSecret,
  parseRecoveryKey,
  publicKeyHash,
  verifyDeviceApprovalCommitment
} from '../src/codes';
import { gzipBytes } from '../src/compression';
import {
  accountKeyCommitment,
  deviceListEntryHash,
  encodeDeviceListEntry,
  nextDeviceListEntry,
  signDeviceApprovalGrant,
  signDeviceListEntry,
  signIdentityTransition,
  verifyDeviceApprovalGrant,
  verifyDeviceList,
  verifyIdentityTransition,
  type DeviceListEntry,
  type ListedDevice
} from '../src/devices';
import {
  EnvelopeKey,
  contentBlobReference,
  contentBlobReferenceFromJson,
  contentBlobReferenceToJson,
  createContentBlobReader,
  createContentBlobWriter,
  decryptContentBlob,
  decryptContentBlobStream,
  decryptProjectEnvelope,
  encryptContentBlob,
  encryptContentBlobStream,
  encryptContentBlobWith,
  encryptProjectEnvelope,
  encryptWithHeaderForTests,
  envelopeKeyFromBytes,
  parseEnvelope
} from '../src/envelope';
import { E2eeError, type E2eeErrorCode } from '../src/errors';
import {
  ecdhDeriveBits,
  ecdsaSign,
  type ExternalAgreementKey,
  type ExternalSigningKey
} from '../src/external-keys';
import type {
  ProjectEnvelopeHeader,
  ProjectEnvelopeHeaderInit
} from '../src/header';
import {
  exportPrivateKey,
  exportPublicKey,
  generateDeviceUnlockKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  importEncryptionPrivateKey
} from '../src/keys';
import { generateSymmetricKey } from '../src/primitives';
import {
  signProjectEnvelope,
  verifyProjectEnvelopeSignature,
  verifyVersionChain,
  versionHash
} from '../src/signing';
import {
  AuthorshipError,
  VersionLogError,
  authorCutoffKey,
  decodeVersionLogRecord,
  encodeVersionLogRecord,
  verifyAuthoredEnvelope,
  verifyAuthoredLogRecord,
  verifyVersionLog,
  versionLogRecord,
  type AuthorshipFailure,
  type VersionLogFailure,
  type VersionLogRecord
} from '../src/version-log';
import {
  TEST_EPHEMERAL_JWK,
  TEST_RECIPIENT_JWK,
  TEST_SIGNER_JWK,
  importFixedPair,
  patternBytes,
  queuedRandom
} from '../src/test-support';
import {
  encodeWrapContext,
  openSealedKey,
  sealKey,
  sealKeyWith,
  unwrapKey,
  wrapKey,
  wrapKeyWith,
  wrapShareSnapshotKey,
  type SealContext,
  type WrapContext
} from '../src/wrap';

/**
 * What a step resolves to: a short detail line, or (from an `engineProbe`
 * step only) a warning that the engine falls short where the package
 * already compensates.
 */
export type StepOutcome = string | { readonly warning: string };

export type StepStatus = 'pass' | 'warn' | 'fail';

export interface StepResult {
  suite: string;
  step: string;
  status: StepStatus;
  detail: string;
  ms: number;
}

export interface CryptoScenario {
  suite: string;
  name: string;
  /**
   * Calls the engine's WebCrypto directly instead of the package, to
   * describe the engine. Only these steps may resolve to a warning; a
   * warning from any other step counts as a failure.
   */
  engineProbe?: true;
  /** Throws on failure; resolves to a detail line or a probe's warning. */
  run(): Promise<StepOutcome>;
}

// ---------------------------------------------------------------------------
// Assertions and helpers

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, what: string) {
  assert(
    actual.byteLength === expected.byteLength &&
      actual.every((byte, i) => byte === expected[i]),
    `${what} differs (${actual.byteLength} B vs ${expected.byteLength} B)`
  );
}

function assertHex(actual: Uint8Array, expected: string, what: string) {
  const hex = toHex(actual);
  assert(hex === expected, `${what} is ${hex}, expected ${expected}`);
}

/** Resolves when `promise` rejects with an `E2eeError` of `code`. */
async function refused(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(
      error instanceof E2eeError,
      `expected E2eeError ${code}, got ${String(error)}`
    );
    assert(
      error.code === code,
      `expected ${code}, got ${error.code}: ${error.message}`
    );
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/** Resolves when `promise` rejects with a `VersionLogError` for `reason`. */
async function logRefused(
  promise: Promise<unknown>,
  reason: VersionLogFailure,
  index: number | null
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(
      error instanceof VersionLogError,
      `expected VersionLogError ${reason}, got ${String(error)}`
    );
    assert(
      error.reason === reason && error.index === index,
      `expected ${reason} at ${index}, got ${error.reason} at ${error.index}`
    );
    return;
  }
  throw new Error(`expected ${reason}, but the log verified`);
}

/** Resolves when `promise` rejects with an `AuthorshipError` for `reason`. */
async function authorRefused(
  promise: Promise<unknown>,
  reason: AuthorshipFailure
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(
      error instanceof AuthorshipError,
      `expected AuthorshipError ${reason}, got ${String(error)}`
    );
    assert(
      error.reason === reason && error.code === 'authentication-failed',
      `expected ${reason}, got ${error.reason} (${error.code})`
    );
    return;
  }
  throw new Error(`expected ${reason}, but the author verified`);
}

/** getRandomValues fills at most 64 KiB per call in every browser. */
function randomBytes(length: number): Bytes {
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length; at += 65_536) {
    crypto.getRandomValues(bytes.subarray(at, at + 65_536));
  }
  return bytes;
}

const utf8 = (text: string): Bytes => new TextEncoder().encode(text);

function stream(
  bytes: Uint8Array,
  pieces: readonly number[]
): ReadableStream<Bytes> {
  return new ReadableStream<Bytes>({
    start(controller) {
      let at = 0;
      for (const size of pieces) {
        controller.enqueue(bytes.slice(at, at + size));
        at += size;
      }
      if (at < bytes.byteLength) controller.enqueue(bytes.slice(at));
      controller.close();
    }
  });
}

async function collect(readable: ReadableStream<Bytes>): Promise<Bytes> {
  const parts: Bytes[] = [];
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concatBytes(...parts);
    parts.push(value);
  }
}

function chunkCount(envelope: Uint8Array): number {
  const { prefix, header } = parseEnvelope(envelope);
  return Math.ceil(
    (envelope.byteLength - prefix.byteLength) / (header.chunkSize + 16)
  );
}

/** A native host stand-in: it holds the key and returns only results. */
function hostSigner(privateKey: CryptoKey): ExternalSigningKey {
  return {
    external: 'ecdsa-p256-sha256',
    sign: async (message) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          privateKey,
          message
        )
      )
  };
}

function hostAgreement(
  privateKey: CryptoKey,
  seen: Uint8Array[] = []
): ExternalAgreementKey {
  return {
    external: 'ecdh-p256',
    deriveBits: async (peer) => {
      seen.push(new Uint8Array(peer));
      const key = await crypto.subtle.importKey(
        'raw',
        peer,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
      return new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'ECDH', public: key },
          privateKey,
          256
        )
      );
    }
  };
}

const PROJECT: ProjectEnvelopeHeaderInit = {
  kind: 'document',
  projectId: 'project-a',
  documentVersion: 7,
  previousVersionHash: patternBytes(32, 0xa0),
  epochBindingHash: patternBytes(32, 0xb0),
  schemaVersion: 23,
  keyEpoch: 2,
  chunkSize: 1024
};

/** A compressible document with an incompressible tail, ~70 KiB. */
function documentBytes(): Bytes {
  return concatBytes(
    utf8('{"features":[{"type":"sketch","plane":"XY"}],'.repeat(1200)),
    randomBytes(16 * 1024)
  );
}

const SEAL_CONTEXT: SealContext = {
  purpose: 'project-key',
  userId: 'user-1',
  projectId: 'project-a',
  keyEpoch: 2
};

async function rawKey(algorithm: 'ECDH' | 'ECDSA'): Promise<Bytes> {
  const pair =
    algorithm === 'ECDH'
      ? await generateEncryptionKeyPair()
      : await generateSigningKeyPair();
  return exportPublicKey(pair.publicKey);
}

async function listedDevice(id: string): Promise<ListedDevice> {
  return {
    deviceId: id,
    label: `Device ${id}`,
    signingKey: await rawKey('ECDSA'),
    unlockKey: await rawKey('ECDH'),
    addedAt: 1_700_000_000_000
  };
}

// ---------------------------------------------------------------------------
// Envelopes

const envelopeSteps: CryptoScenario[] = [
  {
    suite: 'envelope',
    name: 'a gzip project envelope round-trips over many 1 KiB chunks',
    async run() {
      const plaintext = documentBytes();
      // Decryption takes the raw key bytes, so encrypt under known ones.
      const key = generateSymmetricKey();
      const known = await encryptProjectEnvelope(
        envelopeKeyFromBytes(key),
        PROJECT,
        plaintext
      );
      const { header } = parseEnvelope(known);
      assert(header.compression === 'gzip', 'gzip is the default');
      const chunks = chunkCount(known);
      assert(chunks > 1, `expected several chunks, got ${chunks}`);
      const opened = await decryptProjectEnvelope(key, known, {
        expect: {
          projectId: 'project-a',
          kind: 'document',
          documentVersion: 7,
          keyEpoch: 2,
          schemaVersion: 23,
          previousVersionHash: patternBytes(32, 0xa0),
          epochBindingHash: patternBytes(32, 0xb0)
        }
      });
      assertBytes(opened.plaintext, plaintext, 'plaintext');
      return `${plaintext.byteLength} B in ${chunks} chunks (${known.byteLength} B sealed)`;
    }
  },
  {
    suite: 'envelope',
    name: 'tampering, a wrong key, a wrong context and key reuse are refused',
    async run() {
      const key = generateSymmetricKey();
      const envelopeKey = envelopeKeyFromBytes(key);
      const envelope = await encryptProjectEnvelope(
        envelopeKey,
        { ...PROJECT, chunkSize: 64, compression: 'none' },
        patternBytes(300, 1)
      );
      const flipped = new Uint8Array(envelope);
      flipped[flipped.byteLength - 20]! ^= 1;
      await refused(
        decryptProjectEnvelope(key, flipped),
        'authentication-failed'
      );
      await refused(
        decryptProjectEnvelope(generateSymmetricKey(), envelope),
        'authentication-failed'
      );
      await refused(
        decryptProjectEnvelope(key, envelope, { expect: { keyEpoch: 3 } }),
        'context-mismatch'
      );
      await refused(
        encryptProjectEnvelope(envelopeKey, PROJECT, patternBytes(1)),
        'key-reused'
      );
      return 'authentication-failed, context-mismatch, key-reused';
    }
  },
  {
    suite: 'envelope',
    name: 'content blobs round-trip in 1 KiB chunks and through JSON references',
    async run() {
      const raw = randomBytes(48 * 1024);
      const plain = await encryptContentBlob(
        EnvelopeKey.generate(),
        'import-source',
        raw,
        { compression: 'none', chunkSize: 1024 }
      );
      assertBytes(
        await decryptContentBlob(plain.reference, plain.envelope),
        raw,
        'uncompressed blob'
      );
      const json = JSON.parse(
        JSON.stringify(contentBlobReferenceToJson(plain.reference))
      ) as Parameters<typeof contentBlobReferenceFromJson>[0];
      assertBytes(
        await decryptContentBlob(
          contentBlobReferenceFromJson(json),
          plain.envelope
        ),
        raw,
        'blob via JSON reference'
      );
      const text = documentBytes();
      const gzip = await encryptContentBlob(
        EnvelopeKey.generate(),
        'mesh-payload',
        text,
        { chunkSize: 1024 }
      );
      assertBytes(
        await decryptContentBlob(gzip.reference, gzip.envelope),
        text,
        'gzip blob'
      );
      const swapped = { ...plain.reference, blobId: gzip.reference.blobId };
      await refused(
        decryptContentBlob(swapped, plain.envelope),
        'context-mismatch'
      );
      const wrongHash = {
        ...plain.reference,
        ciphertextHash: patternBytes(32)
      };
      await refused(
        decryptContentBlob(wrongHash, plain.envelope),
        'authentication-failed'
      );
      return `${chunkCount(plain.envelope)} + ${chunkCount(gzip.envelope)} chunks`;
    }
  },
  {
    suite: 'envelope',
    name: 'the writer and reader process a blob incrementally',
    async run() {
      const plaintext = randomBytes(10_000);
      const writer = await createContentBlobWriter(
        EnvelopeKey.generate(),
        'export',
        {
          compression: 'none',
          chunkSize: 512,
          plaintextLength: plaintext.byteLength
        }
      );
      const parts: Bytes[] = [writer.prefix];
      for (let at = 0; at < plaintext.byteLength; at += 777) {
        parts.push(...(await writer.write(plaintext.subarray(at, at + 777))));
      }
      parts.push(await writer.finish());
      const envelope = concatBytes(...parts);
      const reference = contentBlobReference(writer);
      const reader = createContentBlobReader(reference);
      const out: Bytes[] = [];
      for (let at = 0; at < envelope.byteLength; at += 333) {
        out.push(...(await reader.push(envelope.subarray(at, at + 333))));
      }
      out.push(...(await reader.finish()));
      assertBytes(concatBytes(...out), plaintext, 'incremental plaintext');
      return `${chunkCount(envelope)} chunks, writes of 777 B, pushes of 333 B`;
    }
  },
  {
    suite: 'envelope',
    name: 'content blob streams encrypt and decrypt, with and without gzip',
    async run() {
      const plaintext = concatBytes(documentBytes(), randomBytes(3000));
      const details: string[] = [];
      for (const compression of ['none', 'gzip'] as const) {
        const encrypted = encryptContentBlobStream(
          EnvelopeKey.generate(),
          'mesh-payload',
          stream(plaintext, [100, 5000, 1]),
          {
            compression,
            chunkSize: 1024,
            plaintextLength: plaintext.byteLength
          }
        );
        const envelope = await collect(encrypted.envelope);
        const reference = await encrypted.reference;
        assertBytes(
          await decryptContentBlob(reference, envelope),
          plaintext,
          `${compression} one-shot decrypt`
        );
        const decrypted = decryptContentBlobStream(
          reference,
          stream(envelope, [50, 1100, 7, 4096])
        );
        assertBytes(
          await collect(decrypted),
          plaintext,
          `${compression} stream decrypt`
        );
        details.push(`${compression}: ${chunkCount(envelope)} chunks`);
      }
      return details.join(', ');
    }
  },
  {
    suite: 'envelope',
    name: 'a truncated, swapped or failing stream errors with a typed error',
    async run() {
      const { envelope, reference } = await encryptContentBlob(
        EnvelopeKey.generate(),
        'export',
        randomBytes(64 * 5),
        { compression: 'none', chunkSize: 64 }
      );
      await refused(
        collect(
          decryptContentBlobStream(
            reference,
            stream(envelope.subarray(0, envelope.byteLength - 80), [])
          )
        ),
        'authentication-failed'
      );
      await refused(
        collect(
          decryptContentBlobStream(
            { ...reference, ciphertextHash: patternBytes(32) },
            stream(envelope, [])
          )
        ),
        'authentication-failed'
      );
      let sent = false;
      const failing = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            controller.error(new TypeError('network connection lost'));
            return;
          }
          sent = true;
          controller.enqueue(envelope.subarray(0, 40));
        }
      });
      await refused(
        collect(decryptContentBlobStream(reference, failing)),
        'aborted'
      );
      const broken = encryptContentBlobStream(
        EnvelopeKey.generate(),
        'export',
        new ReadableStream<Bytes>({
          start(controller) {
            controller.enqueue(patternBytes(100));
          },
          pull(controller) {
            controller.error(new Error('disk read failed'));
          }
        }),
        { compression: 'none', chunkSize: 64, plaintextLength: 1000 }
      );
      await refused(collect(broken.envelope), 'aborted');
      await refused(broken.reference, 'aborted');
      return 'authentication-failed, aborted';
    }
  },
  {
    suite: 'envelope',
    name: 'a gzip bomb stops at the declared plaintext size',
    async run() {
      const bomb = await gzipBytes(new Uint8Array(16 * 1024 * 1024));
      const key = generateSymmetricKey();
      const header = {
        ...(parseEnvelope(
          await encryptProjectEnvelope(
            envelopeKeyFromBytes(generateSymmetricKey()),
            PROJECT,
            utf8('x')
          )
        ).header as ProjectEnvelopeHeader),
        chunkSize: 4096,
        compression: 'gzip' as const,
        plaintextLength: 1024
      };
      const { envelope } = await encryptWithHeaderForTests(
        envelopeKeyFromBytes(key),
        header,
        bomb
      );
      await refused(decryptProjectEnvelope(key, envelope), 'limit-exceeded');
      return `16 MiB of zeros in ${bomb.byteLength} B, refused past 1 KiB`;
    }
  }
];

// ---------------------------------------------------------------------------
// Key wrapping and sealing

const VERSION_CONTEXT: WrapContext = {
  purpose: 'version-key',
  projectId: 'project-a',
  keyEpoch: 2,
  kind: 'document',
  versionId: '7'
};

/** One context of every purpose that wraps with AES-KW (symmetric keys). */
const KW_CONTEXTS: readonly WrapContext[] = [
  VERSION_CONTEXT,
  { ...VERSION_CONTEXT, kind: 'project-info' },
  { ...VERSION_CONTEXT, kind: 'key-archive' },
  {
    purpose: 'account-key',
    userId: 'user-1',
    method: 'recovery-key',
    unlockId: 'rk_1'
  },
  {
    purpose: 'project-key',
    userId: 'user-1',
    projectId: 'project-a',
    keyEpoch: 2
  },
  { purpose: 'dedupe-secret', projectId: 'project-a', keyEpoch: 2 },
  {
    purpose: 'share-key',
    projectId: 'project-a',
    keyEpoch: 2,
    shareId: 'share-1'
  },
  {
    purpose: 'share-version-key',
    projectId: 'project-a',
    keyEpoch: 2,
    shareId: 'share-1',
    versionId: '7'
  },
  {
    purpose: 'rejoin-psk',
    userId: 'user-1',
    projectId: 'project-a',
    keyEpoch: 12
  },
  {
    purpose: 'archived-project-key',
    projectId: 'project-a',
    archivedEpoch: 1,
    underEpoch: 2
  },
  {
    purpose: 'previous-account-key',
    userId: 'user-1',
    generation: 1,
    keySequence: 3
  }
];

/** Byte positions flipped in a 41-byte KW wrap: first, middle and last. */
const KW_FLIPS = [1, 20, 40] as const;

/**
 * Raw WebCrypto, no package code: does the engine's AES-KW unwrap enforce
 * the RFC 3394 integrity check? Returns what it accepted instead of
 * refusing. `unwrapKey` does not depend on the answer: it re-wraps every
 * unwrapped key and compares, so the package steps refuse either way.
 */
async function engineKwAccepts(): Promise<string[]> {
  const subtle = crypto.subtle;
  const kek = async (byte: number) =>
    subtle.importKey('raw', new Uint8Array(32).fill(byte), 'AES-KW', false, [
      'wrapKey',
      'unwrapKey'
    ]);
  const secret = await subtle.importKey(
    'raw',
    patternBytes(32, 0x30),
    'AES-GCM',
    true,
    ['encrypt']
  );
  const wrapped = new Uint8Array(
    await subtle.wrapKey('raw', secret, await kek(1), 'AES-KW')
  );
  // A correct unwrap must open; anything else here is a plain failure.
  const opened = await subtle.unwrapKey(
    'raw',
    wrapped,
    await kek(1),
    'AES-KW',
    'AES-GCM',
    true,
    ['encrypt']
  );
  assertBytes(
    new Uint8Array(await subtle.exportKey('raw', opened)),
    patternBytes(32, 0x30),
    'raw AES-KW round trip'
  );
  const flipped = new Uint8Array(wrapped);
  flipped[3]! ^= 1;
  const accepted: string[] = [];
  for (const [what, key, bytes] of [
    ['a wrong KEK', await kek(2), wrapped],
    ['a flipped byte', await kek(1), flipped]
  ] as const) {
    try {
      const opened = await subtle.unwrapKey(
        'raw',
        bytes,
        key,
        'AES-KW',
        'AES-GCM',
        true,
        ['encrypt']
      );
      const raw = new Uint8Array(await subtle.exportKey('raw', opened));
      accepted.push(`${what} (returned ${toHex(raw.subarray(0, 4))}…)`);
    } catch {
      // Rejected, as RFC 3394 requires.
    }
  }
  return accepted;
}

/**
 * Runs `body` with `crypto.subtle.unwrapKey` replaced by a stand-in for an
 * engine that skips the RFC 3394 integrity check: whatever the real unwrap
 * would refuse comes back as a zeroed key, as Playwright's Windows WebKit
 * build does. `returned` counts every unwrap that handed back a key, so a
 * caller can show a refusal came from the package, not the engine.
 */
async function withKwIntegrityBypassed<T>(
  body: (stats: { readonly returned: number }) => Promise<T>
): Promise<{ result: T; zeroed: number }> {
  const subtle = crypto.subtle;
  const own = Object.getOwnPropertyDescriptor(subtle, 'unwrapKey');
  const original = subtle.unwrapKey.bind(subtle);
  const stats = { returned: 0, zeroed: 0 };
  const stand = async (...args: Parameters<SubtleCrypto['unwrapKey']>) => {
    let key: CryptoKey;
    try {
      key = await original(...args);
    } catch {
      stats.zeroed += 1;
      key = await subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', true, [
        'encrypt'
      ]);
    }
    stats.returned += 1;
    return key;
  };
  Object.defineProperty(subtle, 'unwrapKey', {
    configurable: true,
    writable: true,
    value: stand
  });
  try {
    assert(
      (globalThis.crypto.subtle.unwrapKey as unknown) === stand,
      'could not replace crypto.subtle.unwrapKey on this engine'
    );
    return { result: await body(stats), zeroed: stats.zeroed };
  } finally {
    if (own) Object.defineProperty(subtle, 'unwrapKey', own);
    else delete (subtle as { unwrapKey?: unknown }).unwrapKey;
  }
}

const engineSteps: CryptoScenario[] = [
  {
    suite: 'engine',
    name: "raw WebCrypto: the engine's AES-KW unwrap refuses a wrong KEK and altered bytes",
    engineProbe: true,
    async run() {
      const accepted = await engineKwAccepts();
      if (accepted.length > 0) {
        return {
          warning: `this engine's AES-KW unwrapKey skips the RFC 3394 integrity check: it accepted ${accepted.join(' and ')}. @openzcad/crypto does not rely on it (unwrapKey re-wraps and compares); the wrap steps show its refusals`
        };
      }
      return 'both refused, as RFC 3394 requires';
    }
  }
];

const kwRefusalSteps: CryptoScenario[] = [
  {
    suite: 'wrap',
    name: 'every AES-KW purpose refuses a wrong parent key, another context and altered bytes',
    async run() {
      const secret = generateSymmetricKey();
      const parent = generateSymmetricKey();
      let refusals = 0;
      for (const [i, context] of KW_CONTEXTS.entries()) {
        const wrapped = await wrapKey(parent, secret, context);
        assert(
          wrapped[0] === 2 && wrapped.byteLength === 41,
          `${context.purpose} is not a 41-byte KW wrap`
        );
        assertBytes(
          await unwrapKey(parent, wrapped, context),
          secret,
          `${context.purpose} round trip`
        );
        await refused(
          unwrapKey(generateSymmetricKey(), wrapped, context),
          'authentication-failed'
        );
        await refused(
          unwrapKey(
            parent,
            wrapped,
            KW_CONTEXTS[(i + 1) % KW_CONTEXTS.length]!
          ),
          'authentication-failed'
        );
        refusals += 2;
        for (const at of KW_FLIPS) {
          const flipped = new Uint8Array(wrapped);
          flipped[at]! ^= 1;
          await refused(
            unwrapKey(parent, flipped, context),
            'authentication-failed'
          );
          refusals += 1;
        }
      }
      const engineSkips = (await engineKwAccepts()).length > 0;
      return `${refusals} refusals over ${KW_CONTEXTS.length} purposes (${
        engineSkips
          ? 'the engine skips RFC 3394, so the re-wrap check made them'
          : 'the engine enforces RFC 3394 as well'
      })`;
    }
  },
  {
    suite: 'wrap',
    name: "with the engine's AES-KW integrity check bypassed, the package still refuses",
    async run() {
      const secret = generateSymmetricKey();
      const parent = generateSymmetricKey();
      const wraps = await Promise.all(
        KW_CONTEXTS.map((context) => wrapKey(parent, secret, context))
      );
      const vectorContext: WrapContext = {
        purpose: 'version-key',
        projectId: 'prj_1',
        keyEpoch: 1,
        kind: 'document',
        versionId: '5'
      };
      const { result: refusals, zeroed } = await withKwIntegrityBypassed(
        async (stats) => {
          let count = 0;
          // Each bad unwrap must get a key back from the stand-in and still
          // be refused: the refusal is the package's own re-wrap check.
          const refusedByPackage = async (call: () => Promise<unknown>) => {
            const before = stats.returned;
            await refused(call(), 'authentication-failed');
            assert(
              stats.returned === before + 1,
              'the unwrap was refused before the engine stand-in returned a key'
            );
            count += 1;
          };
          for (const [i, context] of KW_CONTEXTS.entries()) {
            const wrapped = wraps[i]!;
            await refusedByPackage(() =>
              unwrapKey(patternBytes(32, 0x77), wrapped, context)
            );
            await refusedByPackage(() =>
              unwrapKey(
                parent,
                wrapped,
                KW_CONTEXTS[(i + 1) % KW_CONTEXTS.length]!
              )
            );
            for (const at of KW_FLIPS) {
              const flipped = new Uint8Array(wrapped);
              flipped[at]! ^= 1;
              await refusedByPackage(() => unwrapKey(parent, flipped, context));
            }
            assertBytes(
              await unwrapKey(parent, wrapped, context),
              secret,
              `${context.purpose} still opens`
            );
          }
          // The fixed KW vector keeps opening through the stand-in.
          assertBytes(
            await unwrapKey(
              VECTOR_KEK,
              fromHex(
                '02bbbd0963d86843d8312990b54c24a975feb9cbf435334efaba7d1078736e81400335de6fcee2946f'
              ),
              vectorContext
            ),
            VECTOR_SECRET,
            'KW vector through the stand-in'
          );
          return count;
        }
      );
      assert(
        refusals === KW_CONTEXTS.length * (2 + KW_FLIPS.length),
        `${refusals} refusals`
      );
      return `${refusals} refusals over ${KW_CONTEXTS.length} purposes, each after the engine handed back a key (${zeroed} zeroed by the stand-in, ${refusals - zeroed} by the engine itself)`;
    }
  },
  {
    suite: 'wrap',
    name: 'rejoin-psk, archived-project-key and previous-account-key wraps bind every field',
    async run() {
      const accountKey = generateSymmetricKey();
      const secret = generateSymmetricKey();
      const rejoin: WrapContext = {
        purpose: 'rejoin-psk',
        userId: 'user-1',
        projectId: 'project-a',
        keyEpoch: 12
      };
      const archived: WrapContext = {
        purpose: 'archived-project-key',
        projectId: 'project-a',
        archivedEpoch: 1,
        underEpoch: 4
      };
      const previous: WrapContext = {
        purpose: 'previous-account-key',
        userId: 'user-1',
        generation: 1,
        keySequence: 3
      };
      const contexts = [rejoin, archived, previous];
      const moved: [WrapContext, WrapContext[]][] = [
        [
          rejoin,
          [
            { ...rejoin, userId: 'user-2' },
            { ...rejoin, projectId: 'project-b' },
            { ...rejoin, keyEpoch: 13 }
          ]
        ],
        [
          archived,
          [
            { ...archived, projectId: 'project-b' },
            { ...archived, archivedEpoch: 2 },
            { ...archived, underEpoch: 5 }
          ]
        ],
        [
          previous,
          [
            { ...previous, userId: 'user-2' },
            { ...previous, keySequence: 4 }
          ]
        ]
      ];
      let refusals = 0;
      for (const [context, others] of moved) {
        const wrapped = await wrapKey(accountKey, secret, context);
        assertBytes(
          await unwrapKey(accountKey, wrapped, context),
          secret,
          `${context.purpose} round trip`
        );
        for (const other of [
          ...others,
          ...contexts.filter((c) => c !== context)
        ]) {
          await refused(
            unwrapKey(accountKey, wrapped, other),
            'authentication-failed'
          );
          refusals += 1;
        }
        // None of them is ever sealed to a public key.
        const member = await generateEncryptionKeyPair(false);
        await refused(
          sealKey(member.publicKey, secret, context as unknown as SealContext),
          'invalid-argument'
        );
      }
      // An archive only carries older keys forward under a newer one.
      for (const archivedEpoch of [4, 5]) {
        await refused(
          wrapKey(accountKey, secret, { ...archived, archivedEpoch }),
          'invalid-argument'
        );
      }
      return `${refusals} moved or cross-purpose contexts refused; never sealed; archivedEpoch < underEpoch enforced`;
    }
  }
];

const wrapSteps: CryptoScenario[] = [
  {
    suite: 'wrap',
    name: 'AES-KW wraps a version key under raw and non-extractable KEKs',
    async run() {
      const versionKey = generateSymmetricKey();
      const projectKey = generateSymmetricKey();
      const wrapped = await wrapKey(projectKey, versionKey, VERSION_CONTEXT);
      assert(wrapped.byteLength === 41, `KW wrap is ${wrapped.byteLength} B`);
      assertBytes(
        await unwrapKey(projectKey, wrapped, VERSION_CONTEXT),
        versionKey,
        'unwrapped version key'
      );
      const unlockKey = await generateDeviceUnlockKey();
      assert(!unlockKey.extractable, 'the device unlock key is extractable');
      const memberContext: WrapContext = {
        purpose: 'project-key',
        userId: 'user-1',
        projectId: 'project-a',
        keyEpoch: 2
      };
      const underUnlock = await wrapKey(unlockKey, projectKey, memberContext);
      assertBytes(
        await unwrapKey(unlockKey, underUnlock, memberContext),
        projectKey,
        'project key under a CryptoKey KEK'
      );
      return 'raw KEK and non-extractable HKDF KEK';
    }
  },
  {
    suite: 'wrap',
    name: 'AES-GCM wraps a PKCS #8 private key that still derives',
    async run() {
      const pair = await generateEncryptionKeyPair(true);
      const pkcs8 = await exportPrivateKey(pair.privateKey);
      const accountKey = generateSymmetricKey();
      const context: WrapContext = {
        purpose: 'encryption-private-key',
        userId: 'user-1',
        keyId: 'k1'
      };
      const wrapped = await wrapKey(accountKey, pkcs8, context);
      assert(wrapped[0] === 1, 'a private key uses the GCM wrap');
      const restored = await importEncryptionPrivateKey(
        await unwrapKey(accountKey, wrapped, context)
      );
      const peer = await generateEncryptionKeyPair(false);
      const derive = async (key: CryptoKey) =>
        new Uint8Array(
          await crypto.subtle.deriveBits(
            { name: 'ECDH', public: peer.publicKey },
            key,
            256
          )
        );
      assertBytes(
        await derive(restored),
        await derive(pair.privateKey),
        'ECDH secret of the restored key'
      );
      await refused(
        unwrapKey(generateSymmetricKey(), wrapped, context),
        'authentication-failed'
      );
      return `${pkcs8.byteLength} B PKCS #8, ${wrapped.byteLength} B wrapped`;
    }
  },
  {
    suite: 'wrap',
    name: 'a sealed project key opens only for its recipient and context',
    async run() {
      const recipient = await generateEncryptionKeyPair(false);
      const recipientRaw = await exportPublicKey(recipient.publicKey);
      const projectKey = generateSymmetricKey();
      const sealed = await sealKey(recipientRaw, projectKey, SEAL_CONTEXT);
      assertBytes(
        await openSealedKey(recipient, sealed, SEAL_CONTEXT),
        projectKey,
        'opened project key'
      );
      await refused(
        openSealedKey(recipient, sealed, { ...SEAL_CONTEXT, keyEpoch: 3 }),
        'authentication-failed'
      );
      const other = await generateEncryptionKeyPair(false);
      await refused(
        openSealedKey(
          { privateKey: other.privateKey, publicKey: recipient.publicKey },
          sealed,
          SEAL_CONTEXT
        ),
        'authentication-failed'
      );
      return `${sealed.byteLength} B seal`;
    }
  },
  {
    suite: 'wrap',
    name: 'a share snapshot key opens for members and link visitors',
    async run() {
      const projectKey = generateSymmetricKey();
      const shareKey = generateSymmetricKey();
      const versionKey = generateSymmetricKey();
      const wraps = await wrapShareSnapshotKey(
        projectKey,
        shareKey,
        versionKey,
        {
          projectId: 'project-a',
          keyEpoch: 2,
          shareId: 'share-1',
          versionId: '7'
        }
      );
      assertBytes(
        await unwrapKey(projectKey, wraps.forMembers, {
          purpose: 'version-key',
          projectId: 'project-a',
          keyEpoch: 2,
          kind: 'share-snapshot',
          versionId: '7'
        }),
        versionKey,
        'member wrap'
      );
      assertBytes(
        await unwrapKey(shareKey, wraps.forLinkVisitors, {
          purpose: 'share-version-key',
          projectId: 'project-a',
          keyEpoch: 2,
          shareId: 'share-1',
          versionId: '7'
        }),
        versionKey,
        'link visitor wrap'
      );
      return 'both wraps open';
    }
  }
];

// ---------------------------------------------------------------------------
// Signatures, chains and codes

const signingSteps: CryptoScenario[] = [
  {
    suite: 'signing',
    name: 'project envelope signatures verify and a re-encrypted forgery fails',
    async run() {
      const author = await generateSigningKeyPair(false);
      const authorRaw = await exportPublicKey(author.publicKey);
      const init = { ...PROJECT, compression: 'none' as const, chunkSize: 64 };
      const envelope = await encryptProjectEnvelope(
        EnvelopeKey.generate(),
        init,
        utf8('genuine content')
      );
      const signature = await signProjectEnvelope(
        author.privateKey,
        envelope,
        1_760_000_000_000
      );
      const verified = await verifyProjectEnvelopeSignature(
        authorRaw,
        envelope,
        signature
      );
      assert(
        verified?.signedAt === 1_760_000_000_000,
        `verified as ${JSON.stringify(verified)}`
      );
      // Same header, different content: valid tags, but not what was signed.
      const forged = await encryptProjectEnvelope(
        EnvelopeKey.generate(),
        init,
        utf8('altered content')
      );
      assert(
        (await verifyProjectEnvelopeSignature(authorRaw, forged, signature)) ===
          null,
        'the signature verified over a forged envelope'
      );
      const other = await generateSigningKeyPair();
      assert(
        (await verifyProjectEnvelopeSignature(
          await exportPublicKey(other.publicKey),
          envelope,
          signature
        )) === null,
        'the signature verified under another key'
      );
      return `${signature.byteLength} B signature`;
    }
  },
  {
    suite: 'signing',
    name: 'a version chain links by hash and refuses a reordering',
    async run() {
      const versions: Bytes[] = [];
      let previous: Bytes | null = null;
      for (let version = 1; version <= 3; version += 1) {
        const envelope: Bytes = await encryptProjectEnvelope(
          EnvelopeKey.generate(),
          {
            ...PROJECT,
            documentVersion: version,
            previousVersionHash: previous
          },
          utf8(`version ${version}`)
        );
        versions.push(envelope);
        previous = await versionHash(envelope);
      }
      const hashes = await verifyVersionChain(versions, {
        pinnedVersionHash: previous!
      });
      assert(hashes.length === 3, `${hashes.length} hashes`);
      await refused(
        verifyVersionChain([versions[0]!, versions[2]!, versions[1]!]),
        'chain-broken'
      );
      return '3 linked versions';
    }
  },
  {
    suite: 'signing',
    name: 'a device list verifies across a revocation and refuses a forgery',
    async run() {
      const identity = await generateSigningKeyPair(false);
      const identityRaw = await exportPublicKey(identity.publicKey);
      const genesis: DeviceListEntry = {
        userId: 'user-1',
        sequence: 0,
        previousEntryHash: null,
        issuedAt: 1_700_000_000_000,
        previousIdentityKeyHash: null,
        encryptionKey: await rawKey('ECDH'),
        accountKeyCommitment: await accountKeyCommitment(
          generateSymmetricKey()
        ),
        devices: [await listedDevice('dev_0'), await listedDevice('dev_1')],
        unlockTargets: [
          {
            kind: 'recovery-key',
            targetId: 'rk_1',
            publicKey: await rawKey('ECDH'),
            addedAt: 1_700_000_000_000
          }
        ],
        revoked: []
      };
      const chain = [await signDeviceListEntry(identity.privateKey, genesis)];
      const first = await verifyDeviceList(identityRaw, chain);
      const next = nextDeviceListEntry(first, {
        issuedAt: 1_700_000_100_000,
        removeDeviceIds: ['dev_1'],
        addDevices: [await listedDevice('dev_2')],
        encryptionKey: await rawKey('ECDH'),
        accountKeyCommitment: await accountKeyCommitment(generateSymmetricKey())
      });
      chain.push(await signDeviceListEntry(identity.privateKey, next));
      const list = await verifyDeviceList(identityRaw, chain, {
        pin: first.pin
      });
      assert(list.head.sequence === 1, `head is ${list.head.sequence}`);
      assert(
        list.devices.map((d) => d.deviceId).join() === 'dev_0,dev_2',
        `live devices ${list.devices.map((d) => d.deviceId).join()}`
      );
      assert(list.revoked[0]?.id === 'dev_1', 'dev_1 is not revoked');
      assertBytes(
        list.headHash,
        await deviceListEntryHash(encodeDeviceListEntry(next)),
        'head hash'
      );
      const forged = new Uint8Array(chain[1]!.signature);
      forged[10]! ^= 1;
      await refused(
        verifyDeviceList(identityRaw, [
          chain[0]!,
          { ...chain[1]!, signature: forged }
        ]),
        'authentication-failed'
      );
      return `2 entries, ${list.devices.length} live devices, 1 revoked`;
    }
  },
  {
    suite: 'signing',
    name: 'an approval grant and an identity transition verify',
    async run() {
      const approver = await generateSigningKeyPair(false);
      const approverRaw = await exportPublicKey(approver.publicKey);
      const newDevice = await listedDevice('dev_new');
      const grant = {
        userId: 'user-1',
        deviceKeysHash: await deviceKeysHash(
          newDevice.signingKey,
          newDevice.unlockKey
        ),
        deviceId: 'dev_new',
        identityKeyHash: patternBytes(32, 2),
        headSequence: 3,
        headHash: patternBytes(32, 4),
        certified: true,
        approverKeyHash: await publicKeyHash(approverRaw),
        issuedAt: 99
      };
      const signedGrant = await signDeviceApprovalGrant(
        approver.privateKey,
        grant
      );
      const verifiedGrant = await verifyDeviceApprovalGrant(
        signedGrant,
        approverRaw
      );
      assert(
        verifiedGrant.deviceId === 'dev_new' && verifiedGrant.certified,
        'grant fields differ'
      );
      const withContacts = await verifyDeviceApprovalGrant(
        await signDeviceApprovalGrant(approver.privateKey, {
          ...grant,
          contacts: {
            head: { sequence: 5, entryHash: patternBytes(32, 6) },
            confirmed: true
          }
        }),
        approverRaw
      );
      assert(
        withContacts.contacts?.head?.sequence === 5 &&
          withContacts.contacts.confirmed &&
          verifiedGrant.contacts === undefined,
        'grant contacts head differs'
      );
      const old = await generateSigningKeyPair(false);
      const oldRaw = await exportPublicKey(old.publicKey);
      const transition = {
        userId: 'user-1',
        oldIdentityKeyHash: await publicKeyHash(oldRaw),
        newIdentityKey: await rawKey('ECDSA'),
        newGenesisHash: patternBytes(32, 9),
        signer: 'identity' as const,
        signerKeyHash: await publicKeyHash(oldRaw),
        signedAt: 1_760_000_000_000
      };
      const signedTransition = await signIdentityTransition(
        old.privateKey,
        transition
      );
      const verifiedTransition = await verifyIdentityTransition(
        signedTransition,
        oldRaw
      );
      assert(verifiedTransition.signedAt === transition.signedAt, 'signedAt');
      const forged = new Uint8Array(signedTransition.signature);
      forged[5]! ^= 1;
      await refused(
        verifyIdentityTransition(
          { statement: signedTransition.statement, signature: forged },
          oldRaw
        ),
        'authentication-failed'
      );
      return 'grant and transition verify; a flipped signature fails';
    }
  },
  {
    suite: 'signing',
    name: 'approval codes, recovery keys and dedupe hashes agree',
    async run() {
      const keys = [await rawKey('ECDSA'), await rawKey('ECDH')];
      const approverRaw = await rawKey('ECDSA');
      const { nonce, commitment } = await commitDeviceApproval(keys);
      assert(
        await verifyDeviceApprovalCommitment(keys, nonce, commitment),
        'the commitment does not verify'
      );
      assert(
        !(await verifyDeviceApprovalCommitment(
          keys,
          createApprovalNonce(),
          commitment
        )),
        'another nonce verified'
      );
      const input = {
        newDevicePublicKey: keys,
        approverPublicKey: approverRaw,
        newDeviceNonce: nonce,
        approverNonce: createApprovalNonce()
      };
      const code = await deviceApprovalCode(input);
      assert(/^\d{3} \d{3}$/.test(code), `approval code ${code}`);
      assert(
        code === (await deviceApprovalCode(input)),
        'the code is not stable'
      );
      const recovery = await generateRecoveryKey();
      assertBytes(
        await parseRecoveryKey(recovery.formatted.toLowerCase()),
        recovery.secret,
        'parsed recovery key'
      );
      assert(
        recovery.formatted === (await formatRecoveryKey(recovery.secret)),
        'recovery key formatting'
      );
      const dedupe = await importAssetDedupeSecret(generateAssetDedupeSecret());
      const hash = await assetDedupeHash(dedupe, utf8('same file'));
      assert(/^[0-9a-f]{64}$/.test(hash), `dedupe hash ${hash}`);
      assert(
        hash === (await assetDedupeHash(dedupe, utf8('same file'))),
        'the dedupe hash is not stable'
      );
      return `approval code ${code.replace(/\d/g, '#')}, recovery key ${recovery.formatted.length} chars`;
    }
  }
];

// ---------------------------------------------------------------------------
// Project data: the project-info and key-archive kinds, their bodies and the
// epoch binding (ADR-024 Phase 4-2)

const projectDataSteps: CryptoScenario[] = [
  {
    suite: 'project data',
    name: 'a project-info envelope round-trips its body and the blobs it names',
    async run() {
      const thumbnailBytes = randomBytes(6000);
      const exportBytes = documentBytes();
      const thumbnail = await encryptContentBlob(
        EnvelopeKey.generate(),
        'thumbnail',
        thumbnailBytes,
        { compression: 'none', chunkSize: 1024 }
      );
      const exported = await encryptContentBlob(
        EnvelopeKey.generate(),
        'export',
        exportBytes,
        { chunkSize: 1024 }
      );
      const init: ProjectEnvelopeHeaderInit = {
        ...PROJECT,
        kind: 'project-info',
        blobIds: [exported.reference.blobId, thumbnail.reference.blobId]
      };
      const body = encodeProjectInfoBody(
        {
          name: 'Bracket — rev C',
          thumbnail: thumbnail.reference,
          exports: [
            {
              ref: exported.reference,
              fileName: 'bracket.step',
              contentType: 'model/step',
              metadata: { units: 'mm', parts: 3, watertight: true }
            }
          ]
        },
        init
      );
      const key = generateSymmetricKey();
      const envelope = await encryptProjectEnvelope(
        envelopeKeyFromBytes(key),
        init,
        body
      );
      assert(envelope[9] === 5, `kind byte ${envelope[9]}`);
      const opened = await decryptProjectEnvelope(key, envelope, {
        expect: { projectId: 'project-a', kind: 'project-info', keyEpoch: 2 }
      });
      const info = decodeProjectInfoBody(opened.plaintext, opened.header);
      assert(info.name === 'Bracket — rev C', `name ${info.name}`);
      assert(
        info.exports[0]?.fileName === 'bracket.step' &&
          info.exports[0].metadata.parts === 3,
        'export entry differs'
      );
      assertBytes(
        await decryptContentBlob(info.thumbnail!, thumbnail.envelope),
        thumbnailBytes,
        'thumbnail through the decoded reference'
      );
      assertBytes(
        await decryptContentBlob(info.exports[0].ref, exported.envelope),
        exportBytes,
        'export through the decoded reference'
      );
      await refused(
        decryptProjectEnvelope(key, envelope, { expect: { kind: 'document' } }),
        'context-mismatch'
      );
      // The header's blob ids must equal the body's references.
      await refused(
        (async () =>
          decodeProjectInfoBody(opened.plaintext, {
            ...opened.header,
            blobIds: [thumbnail.reference.blobId]
          }))(),
        'context-mismatch'
      );
      await refused(
        (async () =>
          decodeProjectInfoBody(opened.plaintext, {
            ...opened.header,
            kind: 'key-archive'
          }))(),
        'context-mismatch'
      );
      return `${body.byteLength} B body, 2 blobs, kind 5`;
    }
  },
  {
    suite: 'project data',
    name: 'a key-archive envelope carries earlier keys and recomputes its epoch binding',
    async run() {
      const authenticator = randomBytes(32);
      const binding = await epochBinding('project-a', 3, authenticator);
      const init: ProjectEnvelopeHeaderInit = {
        ...PROJECT,
        kind: 'key-archive',
        keyEpoch: 3,
        epochBindingHash: binding,
        blobIds: []
      };
      const previousKeys = [0, 1, 2].map((keyEpoch) => ({
        keyEpoch,
        key: generateSymmetricKey()
      }));
      const dedupeSecret = generateSymmetricKey();
      const body = encodeKeyArchiveBody(
        {
          previousKeys,
          dedupeSecret,
          epochRecord: randomBytes(2000),
          epochAuthenticator: authenticator
        },
        init
      );
      const key = generateSymmetricKey();
      const envelope = await encryptProjectEnvelope(
        envelopeKeyFromBytes(key),
        init,
        body
      );
      assert(envelope[9] === 6, `kind byte ${envelope[9]}`);
      const opened = await decryptProjectEnvelope(key, envelope, {
        expect: { kind: 'key-archive', keyEpoch: 3, epochBindingHash: binding }
      });
      const archive = decodeKeyArchiveBody(opened.plaintext, opened.header);
      for (const [i, entry] of archive.previousKeys.entries()) {
        assert(entry.keyEpoch === i, `archived epoch ${entry.keyEpoch}`);
        assertBytes(entry.key, previousKeys[i]!.key, `archived key ${i}`);
      }
      assertBytes(archive.dedupeSecret, dedupeSecret, 'dedupe secret');
      // A reader recomputes the header's binding from the archived record.
      assertBytes(
        await epochBinding(
          opened.header.projectId,
          opened.header.keyEpoch,
          archive.epochAuthenticator
        ),
        opened.header.epochBindingHash,
        'recomputed epoch binding'
      );
      assert(
        toHex(await epochBinding('project-a', 3, randomBytes(32))) !==
          toHex(binding),
        'another authenticator gave the same binding'
      );
      assert(
        toHex(await epochBinding('project-a', 4, authenticator)) !==
          toHex(binding),
        'another key epoch gave the same binding'
      );
      await refused(
        decryptProjectEnvelope(key, envelope, {
          expect: { epochBindingHash: patternBytes(32, 0xb0) }
        }),
        'context-mismatch'
      );
      // An archive holds only keys older than its own epoch.
      await refused(
        (async () =>
          decodeKeyArchiveBody(opened.plaintext, {
            ...opened.header,
            keyEpoch: 2
          }))(),
        'context-mismatch'
      );
      await refused(
        epochBinding('project-a', 3, randomBytes(31)),
        'invalid-argument'
      );
      return `${archive.previousKeys.length} archived keys, kind 6, binding ${toHex(binding).slice(0, 8)}…`;
    }
  },
  {
    suite: 'project data',
    name: 'version keys of the new kinds open only for their own kind',
    async run() {
      const projectKey = generateSymmetricKey();
      const versionKey = generateSymmetricKey();
      for (const kind of ['project-info', 'key-archive'] as const) {
        const context: WrapContext = { ...VERSION_CONTEXT, kind };
        const wrapped = await wrapKey(projectKey, versionKey, context);
        assertBytes(
          await unwrapKey(projectKey, wrapped, context),
          versionKey,
          `${kind} version key`
        );
        await refused(
          unwrapKey(projectKey, wrapped, VERSION_CONTEXT),
          'authentication-failed'
        );
      }
      return 'project-info and key-archive wraps refuse the document context';
    }
  },
  {
    suite: 'project data',
    name: 'an encrypted document body round-trips with its revision hashes',
    async run() {
      const blob = await encryptContentBlob(
        EnvelopeKey.generate(),
        'mesh-payload',
        randomBytes(3000),
        { compression: 'none' }
      );
      const init: ProjectEnvelopeHeaderInit = {
        ...PROJECT,
        blobIds: [blob.reference.blobId]
      };
      const revision = patternBytes(32, 0x55);
      const body = encodeEncryptedDocumentBody(
        {
          document: { features: [{ type: 'sketch', plane: 'XY' }] },
          blobs: [blob.reference],
          revisionVersionHashes: new Map([['rev-1', revision]])
        },
        init
      );
      const key = generateSymmetricKey();
      const opened = await decryptProjectEnvelope(
        key,
        await encryptProjectEnvelope(envelopeKeyFromBytes(key), init, body)
      );
      const decoded = decodeEncryptedDocumentBody(
        opened.plaintext,
        opened.header
      );
      assert(
        JSON.stringify(decoded.document) ===
          '{"features":[{"type":"sketch","plane":"XY"}]}',
        `document ${JSON.stringify(decoded.document)}`
      );
      assertBytes(
        decoded.revisionVersionHashes.get('rev-1')!,
        revision,
        'revision hash'
      );
      await refused(
        (async () =>
          decodeEncryptedDocumentBody(opened.plaintext, {
            ...opened.header,
            blobIds: []
          }))(),
        'context-mismatch'
      );
      return `${body.byteLength} B body, 1 blob, 1 revision hash`;
    }
  }
];

// ---------------------------------------------------------------------------
// The version log (maintainer decision D1) and who wrote a version

interface SignedVersion {
  readonly envelope: Bytes;
  readonly signature: Bytes;
  readonly record: VersionLogRecord;
}

async function signedVersions(
  signer: CryptoKey,
  steps: readonly {
    documentVersion?: number;
    keyEpoch?: number;
    previousVersionHash?: Bytes | null;
  }[]
): Promise<SignedVersion[]> {
  const out: SignedVersion[] = [];
  for (const [index, step] of steps.entries()) {
    const envelope = await encryptProjectEnvelope(
      EnvelopeKey.generate(),
      {
        ...PROJECT,
        documentVersion: step.documentVersion ?? index + 1,
        previousVersionHash:
          step.previousVersionHash !== undefined
            ? step.previousVersionHash
            : (out.at(-1)?.record.versionHash ?? null),
        keyEpoch: step.keyEpoch ?? 0,
        compression: 'none',
        chunkSize: 64
      },
      utf8(`autosave ${index}`)
    );
    const signature = await signProjectEnvelope(
      signer,
      envelope,
      1_760_000_000_000 + index
    );
    out.push({
      envelope,
      signature,
      record: await versionLogRecord(envelope, signature)
    });
  }
  return out;
}

const versionLogSteps: CryptoScenario[] = [
  {
    suite: 'version log',
    name: 'a signed version log verifies; a rollback, a gap, a reorder and a forgery are refused',
    async run() {
      const author = await generateSigningKeyPair(false);
      const authorRaw = await exportPublicKey(author.publicKey);
      const chain = await signedVersions(author.privateKey, [
        { keyEpoch: 0 },
        { keyEpoch: 0 },
        { keyEpoch: 1 },
        { keyEpoch: 1 }
      ]);
      // Stored compactly and read back, without the envelope bodies.
      const records = chain.map((s) =>
        decodeVersionLogRecord(encodeVersionLogRecord(s.record))
      );
      for (const [i, record] of records.entries()) {
        assertBytes(
          encodeVersionLogRecord(record),
          encodeVersionLogRecord(chain[i]!.record),
          `record ${i} encoding`
        );
      }
      const resolveSigningKey = () => authorRaw;
      const log = await verifyVersionLog(records, {
        pinnedVersionHash: records[1]!.versionHash,
        projectId: 'project-a',
        resolveSigningKey
      });
      assert(
        log.entries.length === 4 && log.head.header.documentVersion === 4,
        `head ${log.head.header.documentVersion} of ${log.entries.length}`
      );
      assert(
        log.head.signedAt === 1_760_000_000_003,
        `signedAt ${log.head.signedAt}`
      );
      const [r0, r1, r2, r3] = records as [
        VersionLogRecord,
        VersionLogRecord,
        VersionLogRecord,
        VersionLogRecord
      ];
      // A server serving an older log than the pinned head: a rollback.
      await logRefused(
        verifyVersionLog([r0, r1], {
          pinnedVersionHash: r3.versionHash,
          resolveSigningKey
        }),
        'pinned-missing',
        null
      );
      // A fork: another version 3 on the same parent hides the real head.
      const [fork] = await signedVersions(author.privateKey, [
        {
          documentVersion: 3,
          keyEpoch: 1,
          previousVersionHash: r1.versionHash
        }
      ]);
      await logRefused(
        verifyVersionLog([r0, r1, fork!.record], {
          pinnedVersionHash: r3.versionHash,
          resolveSigningKey
        }),
        'pinned-missing',
        null
      );
      await logRefused(
        verifyVersionLog([r0, r2, r3], { resolveSigningKey }),
        'previous-hash-mismatch',
        1
      );
      await logRefused(
        verifyVersionLog([r1, r0], { resolveSigningKey }),
        'version-not-increasing',
        1
      );
      await logRefused(
        verifyVersionLog(records, {
          projectId: 'project-b',
          resolveSigningKey
        }),
        'project-mismatch',
        0
      );
      const stepDown = await signedVersions(author.privateKey, [
        { keyEpoch: 2 },
        { keyEpoch: 1 }
      ]);
      await logRefused(
        verifyVersionLog(
          stepDown.map((s) => s.record),
          { resolveSigningKey }
        ),
        'epoch-decreased',
        1
      );
      const other = await generateSigningKeyPair();
      await logRefused(
        verifyVersionLog(records, {
          resolveSigningKey: ({ index }) =>
            index === 2 ? other.publicKey : authorRaw
        }),
        'signature-invalid',
        2
      );
      await logRefused(
        verifyVersionLog(records, {
          resolveSigningKey: ({ index }) => (index === 3 ? null : authorRaw)
        }),
        'signer-unknown',
        3
      );
      const forged = encodeVersionLogRecord(r3);
      forged[forged.byteLength - 5]! ^= 1;
      await logRefused(
        verifyVersionLog([r0, r1, r2, decodeVersionLogRecord(forged)], {
          resolveSigningKey
        }),
        'signature-invalid',
        3
      );
      await refused(
        (async () => decodeVersionLogRecord(forged.subarray(1)))(),
        'malformed'
      );
      return '4 records verify; 9 bad logs refused with the right reason';
    }
  },
  {
    suite: 'version log',
    name: 'the certified author is found; an unknown key and a revoked device past its cutoff are refused',
    async run() {
      const identity = await generateSigningKeyPair(false);
      const identityRaw = await exportPublicKey(identity.publicKey);
      const signers = [
        await generateSigningKeyPair(false),
        await generateSigningKeyPair(false)
      ];
      const devices: ListedDevice[] = [];
      for (const [i, pair] of signers.entries()) {
        devices.push({
          deviceId: `dev_${i}`,
          label: `Device ${i}`,
          signingKey: await exportPublicKey(pair.publicKey),
          unlockKey: await rawKey('ECDH'),
          addedAt: 1_700_000_000_000
        });
      }
      const genesis: DeviceListEntry = {
        userId: 'user-1',
        sequence: 0,
        previousEntryHash: null,
        issuedAt: 1_700_000_000_000,
        previousIdentityKeyHash: null,
        encryptionKey: await rawKey('ECDH'),
        accountKeyCommitment: await accountKeyCommitment(
          generateSymmetricKey()
        ),
        devices,
        unlockTargets: [
          {
            kind: 'recovery-key',
            targetId: 'rk_1',
            publicKey: await rawKey('ECDH'),
            addedAt: 1_700_000_000_000
          }
        ],
        revoked: []
      };
      const listChain = [
        await signDeviceListEntry(identity.privateKey, genesis)
      ];
      const live = await verifyDeviceList(identityRaw, listChain);
      const chain = await signedVersions(signers[0]!.privateKey, [{}, {}, {}]);
      const author = await verifyAuthoredEnvelope(
        chain[0]!.envelope,
        chain[0]!.signature,
        { deviceLists: [live] }
      );
      assert(
        author.userId === 'user-1' &&
          author.deviceId === 'dev_0' &&
          !author.revoked,
        `author ${author.userId}/${author.deviceId}`
      );
      const stranger = await generateSigningKeyPair(false);
      const [unknown] = await signedVersions(stranger.privateKey, [{}]);
      await authorRefused(
        verifyAuthoredLogRecord(unknown!.record, { deviceLists: [live] }),
        'unknown-signer'
      );
      // Revoke dev_0 with a cutoff at version 2.
      listChain.push(
        await signDeviceListEntry(
          identity.privateKey,
          nextDeviceListEntry(live, {
            issuedAt: 1_700_000_100_000,
            removeDeviceIds: ['dev_0'],
            encryptionKey: await rawKey('ECDH'),
            accountKeyCommitment: await accountKeyCommitment(
              generateSymmetricKey()
            )
          })
        )
      );
      const lists = [await verifyDeviceList(identityRaw, listChain)];
      const cutoffs = new Map([
        [
          authorCutoffKey('user-1', 'dev_0'),
          { documentVersion: 2, versionHash: chain[1]!.record.versionHash }
        ]
      ]);
      for (const signed of chain.slice(0, 2)) {
        const verified = await verifyAuthoredLogRecord(signed.record, {
          deviceLists: lists,
          cutoffs
        });
        assert(verified.revoked, 'a pre-cutoff version is not marked revoked');
      }
      await authorRefused(
        verifyAuthoredLogRecord(chain[2]!.record, {
          deviceLists: lists,
          cutoffs
        }),
        'outside-cutoff'
      );
      await authorRefused(
        verifyAuthoredLogRecord(chain[0]!.record, { deviceLists: lists }),
        'revoked-without-cutoff'
      );
      const [survivor] = await signedVersions(signers[1]!.privateKey, [{}]);
      const kept = await verifyAuthoredLogRecord(survivor!.record, {
        deviceLists: lists
      });
      assert(
        kept.deviceId === 'dev_1' && !kept.revoked,
        'the surviving device'
      );
      return 'dev_0 found, then accepted only up to its cutoff; dev_1 unaffected';
    }
  }
];

// ---------------------------------------------------------------------------
// The external-key seam (keys a native host holds)

const externalSteps: CryptoScenario[] = [
  {
    suite: 'external keys',
    name: 'ecdsaSign: a host signer signs envelopes and device statements',
    async run() {
      const device = await generateSigningKeyPair(false);
      const deviceRaw = await exportPublicKey(device.publicKey);
      const host = hostSigner(device.privateKey);
      const message = patternBytes(100, 3);
      for (const key of [host, device.privateKey]) {
        const rs = await ecdsaSign(key, message);
        assert(rs.byteLength === 64, `r || s is ${rs.byteLength} B`);
        assert(
          await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            device.publicKey,
            rs,
            message
          ),
          'ecdsaSign output does not verify'
        );
      }
      const envelope = await encryptProjectEnvelope(
        EnvelopeKey.generate(),
        PROJECT,
        utf8('signed natively')
      );
      const signature = await signProjectEnvelope(host, envelope, 1234);
      const verified = await verifyProjectEnvelopeSignature(
        deviceRaw,
        envelope,
        signature
      );
      assert(verified?.signedAt === 1234, 'host envelope signature');
      const grant = {
        userId: 'user-1',
        deviceKeysHash: patternBytes(32, 1),
        deviceId: 'dev_new',
        identityKeyHash: patternBytes(32, 2),
        headSequence: 3,
        headHash: patternBytes(32, 4),
        certified: false,
        approverKeyHash: await publicKeyHash(deviceRaw),
        issuedAt: 99
      };
      const signed = await signDeviceApprovalGrant(host, grant);
      assert(
        (await verifyDeviceApprovalGrant(signed, deviceRaw)).deviceId ===
          'dev_new',
        'host grant signature'
      );
      return 'CryptoKey and host signatures verify';
    }
  },
  {
    suite: 'external keys',
    name: 'ecdhDeriveBits: a host agreement opens a sealed key',
    async run() {
      const recipient = await generateEncryptionKeyPair(false);
      const peer = await generateEncryptionKeyPair(false);
      const peerRaw = await exportPublicKey(peer.publicKey);
      assertBytes(
        await ecdhDeriveBits(
          hostAgreement(recipient.privateKey),
          peer.publicKey,
          peerRaw
        ),
        await ecdhDeriveBits(recipient.privateKey, peer.publicKey, peerRaw),
        'host and CryptoKey ECDH secrets'
      );
      const secret = generateSymmetricKey();
      const sealed = await sealKey(recipient.publicKey, secret, SEAL_CONTEXT);
      const seen: Uint8Array[] = [];
      assertBytes(
        await openSealedKey(
          {
            privateKey: hostAgreement(recipient.privateKey, seen),
            publicKey: recipient.publicKey
          },
          sealed,
          SEAL_CONTEXT
        ),
        secret,
        'key opened through the host'
      );
      assert(seen.length === 1, `the host derived ${seen.length} times`);
      assertBytes(seen[0]!, sealed.subarray(1, 66), 'what the host saw');
      return 'the host saw only the ephemeral public key';
    }
  },
  {
    suite: 'external keys',
    name: 'malformed or failing host results are refused',
    async run() {
      const message = patternBytes(10, 1);
      for (const result of [new Uint8Array(63), new Uint8Array(65)]) {
        await refused(
          ecdsaSign(
            { external: 'ecdsa-p256-sha256', sign: async () => result },
            message
          ),
          'invalid-argument'
        );
      }
      await refused(
        ecdsaSign(
          {
            external: 'ecdsa-p256-sha256',
            sign: async () => {
              throw new Error('Keychain locked');
            }
          },
          message
        ),
        'invalid-argument'
      );
      const peer = await generateEncryptionKeyPair(false);
      const peerRaw = await exportPublicKey(peer.publicKey);
      await refused(
        ecdhDeriveBits(
          { external: 'ecdh-p256', deriveBits: async () => new Uint8Array(31) },
          peer.publicKey,
          peerRaw
        ),
        'invalid-argument'
      );
      const recipient = await generateEncryptionKeyPair(false);
      const sealed = await sealKey(
        recipient.publicKey,
        generateSymmetricKey(),
        SEAL_CONTEXT
      );
      await refused(
        openSealedKey(
          {
            privateKey: hostAgreement(peer.privateKey),
            publicKey: recipient.publicKey
          },
          sealed,
          SEAL_CONTEXT
        ),
        'authentication-failed'
      );
      return 'invalid-argument, authentication-failed';
    }
  }
];

// ---------------------------------------------------------------------------
// Fixed vectors (copied from src/vectors.test.ts): every engine must produce
// the same bytes.

const VECTOR_PLAINTEXT = utf8('OpenZCAD envelope test vector. '.repeat(3));
const VECTOR_HEADER: ProjectEnvelopeHeaderInit = {
  kind: 'document',
  projectId: 'prj_1',
  documentVersion: 5,
  previousVersionHash: patternBytes(32, 0xa0),
  epochBindingHash: patternBytes(32, 0xc0),
  schemaVersion: 23,
  keyEpoch: 1,
  blobIds: ['707172737475767778797a7b7c7d7e7f'],
  compression: 'none',
  chunkSize: 64
};
const VECTOR_KEK = patternBytes(32, 0x10);
const VECTOR_SECRET = patternBytes(32, 0x30);
// ECDSA signatures are randomized: a recorded signature over projectVector().
const VECTOR_SIGNATURE =
  '0100000199c82cc000490ad620f6a014d8a29e34a5fa46571999c909682e86ee4331409a368d23954ad4448a3983dcc657f7fcb29d6b74602bd37919179b2ed6f9206b243c54fe9464';

const projectVector = () =>
  encryptProjectEnvelope(
    envelopeKeyFromBytes(patternBytes(32, 0x00)),
    VECTOR_HEADER,
    VECTOR_PLAINTEXT
  );

const vectorSteps: CryptoScenario[] = [
  {
    suite: 'vectors',
    name: 'the project envelope and its version hash are fixed',
    async run() {
      const envelope = await projectVector();
      assertHex(
        envelope,
        '4f5a45010000008901010000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f31000120373037313732373337343735373637373738373937613762376337643765376641ccd0b0ef6fc2f928cdc7437d40fee9b76322365bf54059e5fdc7ecb7d17d193e3a88e669b3fc2656ad0790ada1192b897324950d5130c033c2505464400194ac79cc8557d0b73b6fc145fe380a6b410d63da358bfe9a8b630caa878e8d6b0ab4fd9d1bf92e807fc5adbfdc173f6d67e029e68a4601b6ec9d72a5c44d',
        'project envelope'
      );
      assertHex(
        await versionHash(envelope),
        '319935295d2b281ed58c71760f5936274f3bb923762e0e9c6c4f8cb7cc2e1426',
        'version hash'
      );
      return `${envelope.byteLength} B`;
    }
  },
  {
    suite: 'vectors',
    name: 'the content blob and its ciphertext hash are fixed',
    async run() {
      const { envelope, reference } = await encryptContentBlobWith(
        envelopeKeyFromBytes(patternBytes(32, 0x40)),
        'import-source',
        VECTOR_PLAINTEXT,
        { compression: 'none', chunkSize: 64 },
        queuedRandom(patternBytes(16, 0x70))
      );
      assertHex(
        envelope,
        '4f5a45010000003002010000000040000000000000005d20373037313732373337343735373637373738373937613762376337643765376615445516ce2b93eff8eef6855a910d364aa274fbe5629127dec7a9929c1e3209b356d7d85fde4061f0df9abf811bec589adb82e0c43480bf2b9bb7994fae870c3c6678cc54e1a26b1b13cffda038bb701da07ee2684afbdc95606b37e54e8c8264e6724bb2499b526ee40194b96ea6dc153d7c19ea9d129bbaee38697a',
        'content blob'
      );
      assertHex(
        reference.ciphertextHash,
        '45cd73f5fe1e124aca36d61fcaa78d6e20a7ad2393bc43e4ddac1e1e97637483',
        'ciphertext hash'
      );
      return `${envelope.byteLength} B`;
    }
  },
  {
    suite: 'vectors',
    name: 'the AES-KW and AES-GCM wraps are fixed',
    async run() {
      const kw = await wrapKey(VECTOR_KEK, VECTOR_SECRET, {
        purpose: 'version-key',
        projectId: 'prj_1',
        keyEpoch: 1,
        kind: 'document',
        versionId: '5'
      });
      assertHex(
        kw,
        '02bbbd0963d86843d8312990b54c24a975feb9cbf435334efaba7d1078736e81400335de6fcee2946f',
        'AES-KW wrap'
      );
      const gcm = await wrapKeyWith(
        VECTOR_KEK,
        patternBytes(40, 0x01),
        { purpose: 'encryption-private-key', userId: 'usr_1', keyId: 'k1' },
        queuedRandom(patternBytes(12, 0xc0))
      );
      assertHex(
        gcm,
        '01c0c1c2c3c4c5c6c7c8c9cacb5e48a0622c8158b29517a3e35785d2293491c4d5dc99ebbb88365c71eecc9bbd0705c78fe77bc01a7d9625d664061e61bd0f0fe67a5a3d0b',
        'AES-GCM wrap'
      );
      return 'both wraps match';
    }
  },
  {
    suite: 'vectors',
    name: 'the seal for a fixed ephemeral key is fixed',
    async run() {
      const context: SealContext = {
        purpose: 'project-key',
        userId: 'usr_1',
        projectId: 'prj_1',
        keyEpoch: 1
      };
      const recipient = await importFixedPair(TEST_RECIPIENT_JWK, 'ECDH');
      const sealed = await sealKeyWith(
        recipient.publicKey,
        VECTOR_SECRET,
        context,
        await importFixedPair(TEST_EPHEMERAL_JWK, 'ECDH'),
        queuedRandom(patternBytes(12, 0xd0))
      );
      assertHex(
        sealed,
        '010482fb6c30813d84508322c122efce43026e7dcea6f0de9d961a6df375f86fa2e43f13841960e6c63aa427f8e019c41cabc8b60a6ab516b3e8eca9c754e5e8385ed0d1d2d3d4d5d6d7d8d9dadbfe59717957995a878dcf5398e698853d13a567337d4e5c7e8e0877a78da169b507307627a4e44cedc21acb64652ad48d',
        'seal'
      );
      assertBytes(
        await openSealedKey(recipient, sealed, context),
        VECTOR_SECRET,
        'opened seal'
      );
      return `${sealed.byteLength} B`;
    }
  },
  {
    suite: 'vectors',
    name: 'a recorded version signature verifies',
    async run() {
      const signer = await importFixedPair(TEST_SIGNER_JWK, 'ECDSA');
      const verified = await verifyProjectEnvelopeSignature(
        signer.publicKey,
        await projectVector(),
        fromHex(VECTOR_SIGNATURE)
      );
      assert(
        verified?.signedAt === 1_760_000_000_000,
        `verified as ${JSON.stringify(verified)}`
      );
      return 'signedAt 1760000000000';
    }
  },
  {
    suite: 'vectors',
    name: 'the project-info and key-archive envelopes are fixed (kinds 5 and 6)',
    async run() {
      const expected = {
        'project-info':
          '4f5a45010000006801050000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f31000041ccd0b0ef6fc2f928cdc7437d40fee9b76322365bf54059e5fdc7ecb7d17d193e3a88e669b3fc2656ad0790ada1192b897324950d5130c033c2505464400194776bcad4256c4db45b779b3c3dac06030d63da358bfe9a8b630caa878e8d6b0ab4fd9d1bf92e807fc5adbfdc17420a162bf7d0bd70235a77252ccec385',
        'key-archive':
          '4f5a45010000006801060000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f31000041ccd0b0ef6fc2f928cdc7437d40fee9b76322365bf54059e5fdc7ecb7d17d193e3a88e669b3fc2656ad0790ada1192b897324950d5130c033c2505464400194155cbc930acb3d774f4c0ec70fe121ee0d63da358bfe9a8b630caa878e8d6b0ab4fd9d1bf92e807fc5adbfdc1718c6fb69b64616260745e55619cbc461'
      } as const;
      for (const kind of ['project-info', 'key-archive'] as const) {
        assertHex(
          await encryptProjectEnvelope(
            envelopeKeyFromBytes(patternBytes(32, 0x00)),
            { ...VECTOR_HEADER, kind, blobIds: [] },
            VECTOR_PLAINTEXT
          ),
          expected[kind],
          `${kind} envelope`
        );
      }
      return 'both match';
    }
  },
  {
    suite: 'vectors',
    name: 'the epoch binding is fixed',
    async run() {
      assertHex(
        await epochBinding('prj_1', 1, patternBytes(32, 0xb0)),
        '66840854760abafa110678ea0ee957f609007ea80cff13b4e56a05940881a2b6',
        'epoch binding'
      );
      return 'matches';
    }
  },
  {
    suite: 'vectors',
    name: 'the rejoin-psk, archived-project-key and previous-account-key wraps are fixed',
    async run() {
      const cases: [WrapContext, string, string][] = [
        [
          {
            purpose: 'rejoin-psk',
            userId: 'usr_1',
            projectId: 'prj_1',
            keyEpoch: 7
          },
          '086b657945706f63680200000000000000070970726f6a656374496401000570726a5f3107707572706f736501000a72656a6f696e2d70736b067573657249640100057573725f31',
          '02e5bdafb70e3f87ac40825cfdf1683742463c197250ef54a277dfd4685f112b4b86be5a3fa2840753'
        ],
        [
          {
            purpose: 'archived-project-key',
            projectId: 'prj_1',
            archivedEpoch: 0,
            underEpoch: 1
          },
          '0d617263686976656445706f63680200000000000000000970726f6a656374496401000570726a5f3107707572706f736501001461726368697665642d70726f6a6563742d6b65790a756e64657245706f6368020000000000000001',
          '028b0f51b06b7da52ce55e781f3fb455343965288158275e8a68894be1afd1ce7c592502faf85c499c'
        ],
        [
          {
            purpose: 'previous-account-key',
            userId: 'usr_1',
            generation: 1,
            keySequence: 2
          },
          '0a67656e65726174696f6e0200000000000000010b6b657953657175656e636502000000000000000207707572706f736501001470726576696f75732d6163636f756e742d6b6579067573657249640100057573725f31',
          '02074482bb3f13c74326b5d84666116da1a3fb53382684e8a90f074a4fa7f72370f85068e749d51f07'
        ]
      ];
      for (const [context, encoded, wrap] of cases) {
        assertHex(
          encodeWrapContext(context),
          encoded,
          `${context.purpose} context`
        );
        const wrapped = await wrapKey(VECTOR_KEK, VECTOR_SECRET, context);
        assertHex(wrapped, wrap, `${context.purpose} wrap`);
        assertBytes(
          await unwrapKey(VECTOR_KEK, wrapped, context),
          VECTOR_SECRET,
          `${context.purpose} unwrap`
        );
      }
      return 'contexts and wraps match';
    }
  },
  {
    suite: 'vectors',
    name: 'the version log record of the envelope vector is fixed and verifies',
    async run() {
      const record = await versionLogRecord(
        await projectVector(),
        fromHex(VECTOR_SIGNATURE)
      );
      const encoded = encodeVersionLogRecord(record);
      assertHex(
        encoded,
        '4f5a5601000000914f5a45010000008901010000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f310001203730373137323733373437353736373737383739376137623763376437653766319935295d2b281ed58c71760f5936274f3bb923762e0e9c6c4f8cb7cc2e1426490100000199c82cc000490ad620f6a014d8a29e34a5fa46571999c909682e86ee4331409a368d23954ad4448a3983dcc657f7fcb29d6b74602bd37919179b2ed6f9206b243c54fe9464',
        'version log record'
      );
      const signer = await importFixedPair(TEST_SIGNER_JWK, 'ECDSA');
      const log = await verifyVersionLog([decodeVersionLogRecord(encoded)], {
        pinnedVersionHash: record.versionHash,
        resolveSigningKey: () => signer.publicKey
      });
      assert(
        log.head.signedAt === 1_760_000_000_000,
        `signedAt ${log.head.signedAt}`
      );
      return `${encoded.byteLength} B record`;
    }
  },
  {
    suite: 'vectors',
    name: 'the key archive body is fixed',
    async run() {
      const body = encodeKeyArchiveBody(
        {
          previousKeys: [{ keyEpoch: 0, key: patternBytes(32, 0x00) }],
          dedupeSecret: patternBytes(32, 0x20),
          epochRecord: patternBytes(8, 0x40),
          epochAuthenticator: patternBytes(32, 0x60)
        },
        { kind: 'key-archive', keyEpoch: 1, blobIds: [] }
      );
      const text = new TextDecoder().decode(body);
      const expected =
        '{"version":1,"previousKeys":[{"keyEpoch":0,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}],"dedupeSecret":"ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8","epochRecord":"QEFCQ0RFRkc","epochAuthenticator":"YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8"}';
      assert(text === expected, `key archive body is ${text}`);
      return `${body.byteLength} B`;
    }
  }
];

export const cryptoScenarios: readonly CryptoScenario[] = [
  ...engineSteps,
  ...envelopeSteps,
  ...kwRefusalSteps,
  ...wrapSteps,
  ...signingSteps,
  ...projectDataSteps,
  ...versionLogSteps,
  ...externalSteps,
  ...vectorSteps
];

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/**
 * Runs the steps in order, reporting each; never throws. A warning counts
 * only from an `engineProbe` step: from any other step it is a failure.
 */
export async function runCryptoScenarios(
  report: (result: StepResult) => void,
  scenarios: readonly CryptoScenario[] = cryptoScenarios
): Promise<void> {
  for (const scenario of scenarios) {
    const started = performance.now();
    let status: StepStatus;
    let detail: string;
    try {
      const outcome = await scenario.run();
      if (typeof outcome === 'string') {
        status = 'pass';
        detail = outcome;
      } else if (scenario.engineProbe) {
        status = 'warn';
        detail = outcome.warning;
      } else {
        status = 'fail';
        detail = `a package step may not warn: ${outcome.warning}`;
      }
    } catch (error) {
      status = 'fail';
      detail = describeError(error);
    }
    report({
      suite: scenario.suite,
      step: scenario.name,
      status,
      detail,
      ms: performance.now() - started
    });
  }
}
