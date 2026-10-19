import { describe, expect, it } from 'vitest';
import type { Bytes } from './bytes';
import {
  assetDedupeHash,
  commitDeviceApproval,
  createApprovalNonce,
  generateAssetDedupeSecret,
  importAssetDedupeSecret,
  deviceApprovalCode,
  formatComparisonCode,
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
  projectStateCode,
  publicKeyHash,
  verifyDeviceApprovalCommitment,
  verifyScannedDeviceKey
} from './codes';
import {
  EnvelopeKey,
  decryptProjectEnvelope,
  encryptContentBlob,
  encryptProjectEnvelope,
  envelopeKeyFromBytes,
  parseEnvelope
} from './envelope';
import { E2eeError, type E2eeErrorCode } from './errors';
import type { ProjectEnvelopeHeaderInit } from './header';
import {
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair
} from './keys';
import {
  signProjectEnvelope,
  verifyProjectEnvelopeSignature,
  verifyVersionChain,
  versionHash
} from './signing';
import { generateSymmetricKey } from './primitives';
import { patternBytes } from './test-support';
import { unwrapKey, wrapKey } from './wrap';

async function rejectsWith(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof E2eeError && error.code === code
  );
}

const header = (
  documentVersion: number,
  previous: Uint8Array | null,
  change: Partial<ProjectEnvelopeHeaderInit> = {}
): ProjectEnvelopeHeaderInit => ({
  kind: 'document',
  projectId: 'project-a',
  documentVersion,
  previousVersionHash: previous,
  rosterEntryHash: patternBytes(32, 0xb0),
  schemaVersion: 23,
  keyEpoch: 1,
  chunkSize: 64,
  ...change
});

async function version(
  documentVersion: number,
  previous: Uint8Array | null,
  change: Partial<ProjectEnvelopeHeaderInit> = {}
): Promise<Bytes> {
  return encryptProjectEnvelope(
    EnvelopeKey.generate(),
    header(documentVersion, previous, change),
    patternBytes(100, documentVersion)
  );
}

async function chainOf(length: number): Promise<Bytes[]> {
  const chain: Bytes[] = [];
  for (let v = 1; v <= length; v += 1) {
    const previous = chain.at(-1);
    chain.push(await version(v, previous ? await versionHash(previous) : null));
  }
  return chain;
}

describe('version signatures', () => {
  it('sign with a timestamp and verify', async () => {
    const author = await generateSigningKeyPair();
    const envelope = await version(1, null);
    const signature = await signProjectEnvelope(
      author.privateKey,
      envelope,
      1_760_000_000_000
    );
    expect(signature.byteLength).toBe(1 + 8 + 64);
    expect(
      await verifyProjectEnvelopeSignature(
        author.publicKey,
        envelope,
        signature
      )
    ).toEqual({ signedAt: 1_760_000_000_000 });
    expect(
      await verifyProjectEnvelopeSignature(
        await exportPublicKey(author.publicKey),
        envelope,
        signature
      )
    ).toEqual({ signedAt: 1_760_000_000_000 });
  });

  it('cover the header, the ciphertext and the timestamp', async () => {
    const author = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const envelope = await version(3, null);
    const signature = await signProjectEnvelope(author.privateKey, envelope);
    expect(
      await verifyProjectEnvelopeSignature(other.publicKey, envelope, signature)
    ).toBeNull();
    const changedBody = new Uint8Array(envelope);
    changedBody[changedBody.byteLength - 1]! ^= 1;
    expect(
      await verifyProjectEnvelopeSignature(
        author.publicKey,
        changedBody,
        signature
      )
    ).toBeNull();
    const changedHeader = new Uint8Array(envelope);
    changedHeader[22]! ^= 1; // low byte of keyEpoch
    expect(
      await verifyProjectEnvelopeSignature(
        author.publicKey,
        changedHeader,
        signature
      )
    ).toBeNull();
    const backdated = new Uint8Array(signature);
    backdated[8]! ^= 1;
    expect(
      await verifyProjectEnvelopeSignature(
        author.publicKey,
        envelope,
        backdated
      )
    ).toBeNull();
    for (const fill of [0x00, 0xff]) {
      const outOfRange = new Uint8Array(signature);
      outOfRange.fill(fill, 9);
      expect(
        await verifyProjectEnvelopeSignature(
          author.publicKey,
          envelope,
          outOfRange
        )
      ).toBeNull();
    }
  });

  it('do not survive content re-encrypted under the same key and header', async () => {
    // A member holding the version key re-encrypts altered content with the
    // original header (same nonces, valid tags) and reuses the signature.
    const author = await generateSigningKeyPair();
    const keyBytes = patternBytes(32, 0x42);
    const init = header(4, null, { compression: 'none' });
    const original = await encryptProjectEnvelope(
      envelopeKeyFromBytes(keyBytes),
      init,
      patternBytes(300, 1)
    );
    const signature = await signProjectEnvelope(author.privateKey, original);
    const forged = await encryptProjectEnvelope(
      envelopeKeyFromBytes(keyBytes),
      init,
      patternBytes(300, 2)
    );
    // Same header bytes, same nonces, and it decrypts: only the content differs.
    const prefixLength = parseEnvelope(original).prefix.byteLength;
    expect(forged.subarray(0, prefixLength)).toEqual(
      original.subarray(0, prefixLength)
    );
    expect((await decryptProjectEnvelope(keyBytes, forged)).plaintext).toEqual(
      patternBytes(300, 2)
    );
    // The signature covers every chunk's ciphertext and tag, so it fails.
    expect(
      await verifyProjectEnvelopeSignature(author.publicKey, forged, signature)
    ).toBeNull();
    expect(
      await verifyProjectEnvelopeSignature(
        author.publicKey,
        original,
        signature
      )
    ).not.toBeNull();
  });

  it('refuse keys on other curves with typed errors', async () => {
    const p384 = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-384' },
      false,
      ['sign', 'verify']
    );
    const envelope = await version(1, null);
    await rejectsWith(
      signProjectEnvelope(p384.privateKey, envelope),
      'invalid-argument'
    );
    const author = await generateSigningKeyPair();
    const signature = await signProjectEnvelope(author.privateKey, envelope);
    await rejectsWith(
      verifyProjectEnvelopeSignature(p384.publicKey, envelope, signature),
      'invalid-argument'
    );
  });

  it('refuse a private key that cannot sign with a typed error', async () => {
    // WebCrypto never creates an ECDSA private key without `sign`, so the
    // ways in are look-alike objects; each must fail as an E2eeError, not
    // a native TypeError or InvalidAccessError.
    const { privateKey } = await generateSigningKeyPair();
    const envelope = await version(1, null);
    for (const usages of [[], undefined, ['sign']]) {
      const lookalike = {
        algorithm: privateKey.algorithm,
        type: privateKey.type,
        extractable: false,
        usages
      } as unknown as CryptoKey;
      await rejectsWith(
        signProjectEnvelope(lookalike, envelope),
        'invalid-argument'
      );
    }
  });

  it('refuse a public key without the verify usage', async () => {
    // The public half of a ['sign']-only pair has no usages; verifying with
    // it would throw inside WebCrypto and read as a forged signature.
    const signOnly = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign']
    );
    expect(signOnly.publicKey.usages).not.toContain('verify');
    const envelope = await version(1, null);
    const signature = await signProjectEnvelope(signOnly.privateKey, envelope);
    await rejectsWith(
      verifyProjectEnvelopeSignature(signOnly.publicKey, envelope, signature),
      'invalid-argument'
    );
  });

  it('refuse content blobs, malformed input and unknown versions', async () => {
    const author = await generateSigningKeyPair();
    const envelope = await version(1, null);
    const signature = await signProjectEnvelope(author.privateKey, envelope);
    const future = new Uint8Array(signature);
    future[0] = 2;
    await rejectsWith(
      verifyProjectEnvelopeSignature(author.publicKey, envelope, future),
      'unsupported-version'
    );
    for (const bad of [signature.subarray(0, 72), new Uint8Array()]) {
      await rejectsWith(
        verifyProjectEnvelopeSignature(author.publicKey, envelope, bad),
        'malformed'
      );
    }
    await rejectsWith(
      verifyProjectEnvelopeSignature(
        author.publicKey,
        patternBytes(40),
        signature
      ),
      'malformed'
    );
    await rejectsWith(
      signProjectEnvelope(author.publicKey, envelope),
      'invalid-argument'
    );
    await rejectsWith(
      signProjectEnvelope(author.privateKey, envelope, -1),
      'invalid-argument'
    );
    const { envelope: blob } = await encryptContentBlob(
      EnvelopeKey.generate(),
      'thumbnail',
      patternBytes(5)
    );
    await rejectsWith(
      signProjectEnvelope(author.privateKey, blob),
      'invalid-argument'
    );
  });
});

describe('version chains', () => {
  it('accepts an unbroken history that contains the pin', async () => {
    const chain = await chainOf(4);
    const hashes = await verifyVersionChain(chain);
    expect(hashes).toHaveLength(4);
    expect(
      await verifyVersionChain(chain, { pinnedVersionHash: hashes[2]! })
    ).toEqual(hashes);
    await verifyVersionChain(chain.slice(1), { pinnedVersionHash: hashes[1]! });
  });

  it('refuses rollback, forks and broken links', async () => {
    const chain = await chainOf(3);
    const hashes = await verifyVersionChain(chain);
    await rejectsWith(
      verifyVersionChain(chain.slice(0, 2), { pinnedVersionHash: hashes[2]! }),
      'chain-broken'
    );
    const sibling = await version(3, hashes[1]!);
    await rejectsWith(
      verifyVersionChain([chain[0]!, chain[1]!, sibling], {
        pinnedVersionHash: hashes[2]!
      }),
      'chain-broken'
    );
    for (const broken of [
      [chain[0]!, chain[2]!],
      [chain[1]!, chain[0]!],
      [chain[0]!, await version(2, hashes[0]!, { projectId: 'project-b' })],
      [chain[0]!, await version(1, hashes[0]!)],
      [chain[0]!, await version(2, null)]
    ]) {
      await rejectsWith(verifyVersionChain(broken), 'chain-broken');
    }
  });
});

describe('asset de-duplication', () => {
  it('is keyed by the dedupe secret and stable across epochs', async () => {
    const content = patternBytes(1000, 3);
    const secret = generateAssetDedupeSecret();
    const key = await importAssetDedupeSecret(secret);
    expect(key.extractable).toBe(false);
    const hash = await assetDedupeHash(key, content);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await assetDedupeHash(key, new Uint8Array(content))).toBe(hash);
    // Another project's secret gives a different hash.
    const other = await importAssetDedupeSecret(generateAssetDedupeSecret());
    expect(await assetDedupeHash(other, content)).not.toBe(hash);
    // Carried into a new epoch under the new project key, it hashes the same.
    const epoch2 = generateSymmetricKey();
    const context = {
      purpose: 'dedupe-secret',
      projectId: 'p',
      keyEpoch: 2
    } as const;
    const carried = await unwrapKey(
      epoch2,
      await wrapKey(epoch2, secret, context),
      context
    );
    expect(
      await assetDedupeHash(await importAssetDedupeSecret(carried), content)
    ).toBe(hash);
    await rejectsWith(
      importAssetDedupeSecret(patternBytes(31)),
      'invalid-argument'
    );
    // Any HMAC key other than SHA-256 would yield an incompatible index.
    const sha1 = await crypto.subtle.importKey(
      'raw',
      patternBytes(32),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    );
    await rejectsWith(assetDedupeHash(sha1, content), 'invalid-argument');
    const verifyOnly = await crypto.subtle.importKey(
      'raw',
      patternBytes(32),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    await rejectsWith(assetDedupeHash(verifyOnly, content), 'invalid-argument');
    // A short HMAC key would let the server enumerate the secret.
    const short = await crypto.subtle.importKey(
      'raw',
      patternBytes(1),
      { name: 'HMAC', hash: 'SHA-256', length: 8 },
      false,
      ['sign']
    );
    await rejectsWith(assetDedupeHash(short, content), 'invalid-argument');
  });
});

describe('codes people compare', () => {
  it('hashes keys in full and shows at least 128 bits', async () => {
    const enc = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    const sig = await exportPublicKey(
      (await generateSigningKeyPair()).publicKey
    );
    const single = await publicKeyHash(enc);
    expect(single.byteLength).toBe(32);
    expect(await publicKeyHash([enc])).toEqual(single);
    const identity = await publicKeyHash([enc, sig]);
    expect(identity).not.toEqual(single);
    expect(await publicKeyHash([sig, enc])).not.toEqual(identity);
    const code = formatComparisonCode(identity);
    expect(code).toMatch(/^\d{5}( \d{5}){7}$/);
    expect(Math.log2(10) * code.replace(/ /g, '').length).toBeGreaterThan(128);
    await rejectsWith(publicKeyHash(enc.subarray(1)), 'invalid-argument');
    await rejectsWith(publicKeyHash([]), 'invalid-argument');
    expect(() => formatComparisonCode(identity.subarray(0, 16))).toThrow(
      E2eeError
    );
  });

  it('derives a project state code from version, hash and signer', async () => {
    const input = {
      versionHash: patternBytes(32, 1),
      documentVersion: 9,
      signerKeyHash: patternBytes(32, 2)
    };
    const { hash, code } = await projectStateCode(input);
    expect(code).toBe(formatComparisonCode(hash));
    for (const change of [
      { versionHash: patternBytes(32, 3) },
      { documentVersion: 10 },
      { signerKeyHash: patternBytes(32, 4) }
    ]) {
      expect((await projectStateCode({ ...input, ...change })).code).not.toBe(
        code
      );
    }
    await rejectsWith(
      projectStateCode({ ...input, versionHash: patternBytes(16) }),
      'invalid-argument'
    );
  });

  it('approves a device by scanning its full key hash', async () => {
    const device = await exportPublicKey(
      (await generateEncryptionKeyPair(false)).publicKey
    );
    const substitute = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    const scanned = await publicKeyHash(device);
    expect(await verifyScannedDeviceKey(device, scanned)).toBe(true);
    expect(await verifyScannedDeviceKey(substitute, scanned)).toBe(false);
  });

  it('runs the commitment-based comparison', async () => {
    const newDevicePublicKey = await exportPublicKey(
      (await generateEncryptionKeyPair(false)).publicKey
    );
    const approverPublicKey = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    // 1. The new device commits before it sees anything from the approver.
    const { nonce, commitment } =
      await commitDeviceApproval(newDevicePublicKey);
    // 2. The approver answers with its key and nonce; 3. the device reveals.
    const approverNonce = createApprovalNonce();
    expect(
      await verifyDeviceApprovalCommitment(
        newDevicePublicKey,
        nonce,
        commitment
      )
    ).toBe(true);
    const input = {
      newDevicePublicKey,
      approverPublicKey,
      newDeviceNonce: nonce,
      approverNonce
    };
    const code = await deviceApprovalCode(input);
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect(await deviceApprovalCode({ ...input })).toBe(code);

    // A relay that substitutes a key cannot reuse the device's commitment.
    const relay = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    expect(await verifyDeviceApprovalCommitment(relay, nonce, commitment)).toBe(
      false
    );
    expect(
      await verifyDeviceApprovalCommitment(
        newDevicePublicKey,
        approverNonce,
        commitment
      )
    ).toBe(false);
    // Every input feeds the code.
    for (const change of [
      { newDevicePublicKey: relay },
      { approverPublicKey: relay },
      { newDeviceNonce: approverNonce },
      { approverNonce: nonce }
    ]) {
      expect(await deviceApprovalCode({ ...input, ...change })).not.toBe(code);
    }
    await rejectsWith(
      deviceApprovalCode({ ...input, newDeviceNonce: nonce.subarray(1) }),
      'invalid-argument'
    );
    await rejectsWith(
      deviceApprovalCode({ ...input, approverPublicKey: relay.subarray(1) }),
      'invalid-argument'
    );
  });
});

describe('recovery keys', () => {
  it('formats, parses and tolerates spacing, case and look-alikes', async () => {
    const { secret, formatted } = await generateRecoveryKey();
    expect(formatted).toMatch(
      /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/
    );
    expect(await parseRecoveryKey(formatted)).toEqual(secret);
    const sloppy = formatted
      .toLowerCase()
      .replace(/-/g, ' ')
      .replace(/0/g, 'o')
      .replace(/1/g, 'l');
    expect(await parseRecoveryKey(sloppy)).toEqual(secret);
  });

  it('catches a mistyped character', async () => {
    const formatted = await formatRecoveryKey(patternBytes(32, 0x42));
    const first = formatted[0] === 'A' ? 'B' : 'A';
    await rejectsWith(
      parseRecoveryKey(first + formatted.slice(1)),
      'malformed'
    );
    await rejectsWith(parseRecoveryKey(formatted.slice(0, -1)), 'malformed');
    await rejectsWith(
      parseRecoveryKey(formatted.replace(/^./, 'U')),
      'malformed'
    );
  });
});
