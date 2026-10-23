import { describe, expect, it, vi } from 'vitest';
import {
  E2eeError,
  EnvelopeKey,
  ecdhDeriveBits,
  ecdsaSign,
  encryptProjectEnvelope,
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  openSealedKey,
  publicKeyHash,
  sealKey,
  signDeviceApprovalGrant,
  signProjectEnvelope,
  verifyDeviceApprovalGrant,
  verifyProjectEnvelopeSignature,
  type E2eeErrorCode,
  type ExternalAgreementKey,
  type ExternalSigningKey
} from './index';
import { patternBytes } from './test-support';

async function rejectsWith(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof E2eeError && error.code === code
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

function hostAgreement(privateKey: CryptoKey): ExternalAgreementKey {
  return {
    external: 'ecdh-p256',
    deriveBits: async (peer) => {
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

const sealContext = {
  purpose: 'project-key',
  userId: 'user-1',
  projectId: 'project-a',
  keyEpoch: 1
} as const;

describe('device keys held outside WebCrypto', () => {
  it('signs project envelopes that verify against the public key', async () => {
    const author = await generateSigningKeyPair(false);
    const envelope = await encryptProjectEnvelope(
      EnvelopeKey.generate(),
      {
        kind: 'document',
        projectId: 'project-a',
        documentVersion: 1,
        previousVersionHash: null,
        rosterEntryHash: patternBytes(32, 0xb0),
        schemaVersion: 23,
        keyEpoch: 1,
        chunkSize: 64
      },
      patternBytes(100, 1)
    );
    const signature = await signProjectEnvelope(
      hostSigner(author.privateKey),
      envelope,
      1_760_000_000_000
    );
    expect(
      await verifyProjectEnvelopeSignature(
        await exportPublicKey(author.publicKey),
        envelope,
        signature
      )
    ).toEqual({ signedAt: 1_760_000_000_000 });
  });

  it('signs device statements that verify against the public key', async () => {
    const approver = await generateSigningKeyPair(false);
    const approverRaw = await exportPublicKey(approver.publicKey);
    const grant = {
      userId: 'user-1',
      deviceKeysHash: patternBytes(32, 1),
      deviceId: 'dev_new',
      identityKeyHash: patternBytes(32, 2),
      headSequence: 3,
      headHash: patternBytes(32, 4),
      certified: true,
      approverKeyHash: await publicKeyHash(approverRaw),
      issuedAt: 99
    };
    const signed = await signDeviceApprovalGrant(
      hostSigner(approver.privateKey),
      grant
    );
    expect(await verifyDeviceApprovalGrant(signed, approverRaw)).toEqual(grant);
  });

  it('opens a sealed key through the host agreement', async () => {
    const recipient = await generateEncryptionKeyPair(false);
    const secret = patternBytes(32, 7);
    const sealed = await sealKey(recipient.publicKey, secret, sealContext);
    expect(
      await openSealedKey(
        {
          privateKey: hostAgreement(recipient.privateKey),
          publicKey: recipient.publicKey
        },
        sealed,
        sealContext
      )
    ).toEqual(secret);
    // The host sees only the sender's ephemeral public key.
    const deriveBits = vi.fn(hostAgreement(recipient.privateKey).deriveBits);
    await openSealedKey(
      {
        privateKey: { external: 'ecdh-p256', deriveBits },
        publicKey: recipient.publicKey
      },
      sealed,
      sealContext
    );
    expect(deriveBits).toHaveBeenCalledOnce();
    expect(deriveBits.mock.calls[0]![0]).toEqual(sealed.subarray(1, 66));
  });

  it('refuses malformed host results as E2eeErrors', async () => {
    const message = patternBytes(10, 1);
    for (const result of [new Uint8Array(63), new Uint8Array(65)]) {
      await rejectsWith(
        ecdsaSign(
          { external: 'ecdsa-p256-sha256', sign: async () => result },
          message
        ),
        'invalid-argument'
      );
    }
    await rejectsWith(
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
    await rejectsWith(
      ecdhDeriveBits(
        { external: 'ecdh-p256', deriveBits: async () => new Uint8Array(31) },
        peer.publicKey,
        peerRaw
      ),
      'invalid-argument'
    );
    await rejectsWith(
      ecdhDeriveBits(
        {
          external: 'ecdh-p256',
          deriveBits: async () => {
            throw new Error('Keychain locked');
          }
        },
        peer.publicKey,
        peerRaw
      ),
      'invalid-argument'
    );
    const recipient = await generateEncryptionKeyPair(false);
    const sealed = await sealKey(
      recipient.publicKey,
      patternBytes(32, 7),
      sealContext
    );
    // A host deriving with the wrong key cannot open the seal.
    await rejectsWith(
      openSealedKey(
        {
          privateKey: hostAgreement(peer.privateKey),
          publicKey: recipient.publicKey
        },
        sealed,
        sealContext
      ),
      'authentication-failed'
    );
  });

  it('refuses objects that are neither key form', async () => {
    const message = patternBytes(10, 1);
    const ecdh = await generateEncryptionKeyPair(false);
    for (const key of [
      null,
      {},
      { external: 'ecdh-p256', deriveBits: async () => new Uint8Array(32) },
      ecdh.privateKey
    ]) {
      await rejectsWith(
        ecdsaSign(key as unknown as ExternalSigningKey, message),
        'invalid-argument'
      );
    }
    const signing = await generateSigningKeyPair(false);
    for (const key of [
      { external: 'ecdsa-p256-sha256', sign: async () => new Uint8Array(64) },
      signing.privateKey
    ]) {
      await rejectsWith(
        ecdhDeriveBits(
          key as unknown as ExternalAgreementKey,
          ecdh.publicKey,
          await exportPublicKey(ecdh.publicKey)
        ),
        'invalid-argument'
      );
    }
  });
});
