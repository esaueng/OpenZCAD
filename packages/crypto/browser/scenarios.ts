/**
 * Real-browser scenarios for `@openzcad/crypto`: envelopes (including
 * chunked and streamed content blobs), key wrap, seal and open, signatures
 * over project envelopes and device statements, the external-key seam, and
 * fixed vectors that must come out byte-identical in every engine. Test code
 * only (not exported from the package): `run.mjs` runs it on a page in
 * Chromium, WebKit and Firefox, and `test/crypto-browser-scenarios.test.ts`
 * runs the same steps in Node so they cannot rot unnoticed in CI. No test
 * framework, so the steps run anywhere WebCrypto and web streams exist.
 */
import { concatBytes, fromHex, toHex, type Bytes } from '../src/bytes';
import {
  assetDedupeHash,
  commitDeviceApproval,
  createApprovalNonce,
  deviceApprovalCode,
  deviceKeysHash,
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
  TEST_EPHEMERAL_JWK,
  TEST_RECIPIENT_JWK,
  TEST_SIGNER_JWK,
  importFixedPair,
  patternBytes,
  queuedRandom
} from '../src/test-support';
import {
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

export interface StepResult {
  suite: string;
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export interface CryptoScenario {
  suite: string;
  name: string;
  /** Throws on failure; resolves to a short detail line. */
  run(): Promise<string>;
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
  rosterEntryHash: patternBytes(32, 0xb0),
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
          rosterEntryHash: patternBytes(32, 0xb0)
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

/**
 * Raw WebCrypto, no package code: does the engine's AES-KW unwrap enforce
 * the RFC 3394 integrity check? The package's KW wraps bind their context
 * only through it, so when this fails the package step after it fails too,
 * and the cause is the engine.
 */
async function engineKwRejects(): Promise<string[]> {
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

const wrapSteps: CryptoScenario[] = [
  {
    suite: 'wrap',
    name: "the engine's AES-KW unwrap rejects a wrong KEK and altered bytes",
    async run() {
      const accepted = await engineKwRejects();
      assert(
        accepted.length === 0,
        `engine defect: WebCrypto AES-KW unwrapKey accepted ${accepted.join(' and ')} instead of failing the RFC 3394 integrity check`
      );
      return 'both rejected (OperationError)';
    }
  },
  {
    suite: 'wrap',
    name: 'an AES-KW wrap opens only under its own context',
    async run() {
      const projectKey = generateSymmetricKey();
      const wrapped = await wrapKey(
        projectKey,
        generateSymmetricKey(),
        VERSION_CONTEXT
      );
      await refused(
        unwrapKey(projectKey, wrapped, { ...VERSION_CONTEXT, versionId: '8' }),
        'authentication-failed'
      );
      await refused(
        unwrapKey(generateSymmetricKey(), wrapped, VERSION_CONTEXT),
        'authentication-failed'
      );
      return 'another context and another parent key are refused';
    }
  },
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
  rosterEntryHash: patternBytes(32, 0xc0),
  schemaVersion: 23,
  keyEpoch: 1,
  blobIds: ['707172737475767778797a7b7c7d7e7f'],
  compression: 'none',
  chunkSize: 64
};
const VECTOR_KEK = patternBytes(32, 0x10);
const VECTOR_SECRET = patternBytes(32, 0x30);

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
        fromHex(
          '0100000199c82cc000490ad620f6a014d8a29e34a5fa46571999c909682e86ee4331409a368d23954ad4448a3983dcc657f7fcb29d6b74602bd37919179b2ed6f9206b243c54fe9464'
        )
      );
      assert(
        verified?.signedAt === 1_760_000_000_000,
        `verified as ${JSON.stringify(verified)}`
      );
      return 'signedAt 1760000000000';
    }
  }
];

export const cryptoScenarios: readonly CryptoScenario[] = [
  ...envelopeSteps,
  ...wrapSteps,
  ...signingSteps,
  ...externalSteps,
  ...vectorSteps
];

/** Runs every step in order, reporting each; never throws. */
export async function runCryptoScenarios(
  report: (result: StepResult) => void
): Promise<void> {
  for (const scenario of cryptoScenarios) {
    const started = performance.now();
    try {
      const detail = await scenario.run();
      report({
        suite: scenario.suite,
        step: scenario.name,
        ok: true,
        detail,
        ms: performance.now() - started
      });
    } catch (error) {
      report({
        suite: scenario.suite,
        step: scenario.name,
        ok: false,
        detail:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
        ms: performance.now() - started
      });
    }
  }
}
