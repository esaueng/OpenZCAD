import { describe, expect, it } from 'vitest';
import { E2eeError, type E2eeErrorCode } from './errors';
import {
  exportPrivateKey,
  exportPublicKey,
  generateDeviceUnlockKey,
  generateEncryptionKeyPair,
  generateIdentityKeyPair,
  importEncryptionPrivateKey,
  importEncryptionPublicKey,
  importSigningPrivateKey,
  importUnlockSecret
} from './keys';
import { generateSymmetricKey } from './primitives';
import { patternBytes } from './test-support';
import {
  encodeWrapContext,
  openSealedKey,
  sealKey,
  unwrapKey,
  wrapKey,
  wrapShareSnapshotKey,
  type WrapContext
} from './wrap';

async function rejectsWith(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof E2eeError && error.code === code
  );
}

const PROJECT_KEY = patternBytes(32, 0x10);
const BLOB_KEY = patternBytes(32, 0x30);
const BLOB_CONTEXT: WrapContext = {
  purpose: 'version-key',
  projectId: 'project-a',
  keyEpoch: 2,
  kind: 'document',
  versionId: '7'
};

describe('symmetric key wrapping', () => {
  it('wraps a version key under the project key and back', async () => {
    const wrapped = await wrapKey(PROJECT_KEY, BLOB_KEY, BLOB_CONTEXT);
    // AES-KW: no nonce, deterministic, 8 bytes of integrity check.
    expect(wrapped[0]).toBe(2);
    expect(wrapped.byteLength).toBe(1 + 32 + 8);
    expect(await wrapKey(PROJECT_KEY, BLOB_KEY, BLOB_CONTEXT)).toEqual(wrapped);
    expect(await unwrapKey(PROJECT_KEY, wrapped, BLOB_CONTEXT)).toEqual(
      BLOB_KEY
    );
  });

  it('binds every context field and the purpose', async () => {
    const wrapped = await wrapKey(PROJECT_KEY, BLOB_KEY, BLOB_CONTEXT);
    const moved: WrapContext[] = [
      { ...BLOB_CONTEXT, projectId: 'project-b' },
      { ...BLOB_CONTEXT, keyEpoch: 3 },
      { ...BLOB_CONTEXT, kind: 'view-state' },
      { ...BLOB_CONTEXT, versionId: '8' },
      {
        purpose: 'share-key',
        projectId: 'project-a',
        keyEpoch: 2,
        shareId: '7'
      }
    ];
    for (const context of moved) {
      await rejectsWith(
        unwrapKey(PROJECT_KEY, wrapped, context),
        'authentication-failed'
      );
    }
    await rejectsWith(
      unwrapKey(patternBytes(32, 0x11), wrapped, BLOB_CONTEXT),
      'authentication-failed'
    );
  });

  it('refuses tampered, truncated and future-version wraps', async () => {
    const wrapped = await wrapKey(PROJECT_KEY, BLOB_KEY, BLOB_CONTEXT);
    for (let at = 1; at < wrapped.byteLength; at += 1) {
      const forged = new Uint8Array(wrapped);
      forged[at]! ^= 0x04;
      await rejectsWith(
        unwrapKey(PROJECT_KEY, forged, BLOB_CONTEXT),
        'authentication-failed'
      );
    }
    const future = new Uint8Array(wrapped);
    future[0] = 9;
    await rejectsWith(
      unwrapKey(PROJECT_KEY, future, BLOB_CONTEXT),
      'unsupported-version'
    );
    // The GCM format is known, but not for a symmetric key.
    const otherFormat = new Uint8Array(wrapped);
    otherFormat[0] = 1;
    await rejectsWith(
      unwrapKey(PROJECT_KEY, otherFormat, BLOB_CONTEXT),
      'malformed'
    );
    await rejectsWith(
      unwrapKey(PROJECT_KEY, wrapped.subarray(0, 20), BLOB_CONTEXT),
      'malformed'
    );
    await rejectsWith(
      unwrapKey(PROJECT_KEY, new Uint8Array(), BLOB_CONTEXT),
      'malformed'
    );
  });

  it('wraps the account key under each unlock method', async () => {
    const accountKey = generateSymmetricKey();
    const device = await generateDeviceUnlockKey();
    expect(device.extractable).toBe(false);
    const passkey = await importUnlockSecret(patternBytes(32, 0x70));
    const recovery = patternBytes(32, 0x90);
    const unlocks = [
      { kek: device, method: 'device', unlockId: 'device-1' },
      { kek: passkey, method: 'passkey-prf', unlockId: 'cred-1' },
      { kek: recovery, method: 'recovery-key', unlockId: 'recovery-1' }
    ] as const;
    for (const { kek, method, unlockId } of unlocks) {
      const context: WrapContext = {
        purpose: 'account-key',
        userId: 'user-1',
        method,
        unlockId
      };
      const wrapped = await wrapKey(kek, accountKey, context);
      expect(await unwrapKey(kek, wrapped, context)).toEqual(accountKey);
      await rejectsWith(
        unwrapKey(kek, wrapped, { ...context, userId: 'user-2' }),
        'authentication-failed'
      );
    }
    // The same secret under another method is a different KEK context.
    const context: WrapContext = {
      purpose: 'account-key',
      userId: 'user-1',
      method: 'recovery-key',
      unlockId: 'x'
    };
    const wrapped = await wrapKey(recovery, accountKey, context);
    await rejectsWith(
      unwrapKey(recovery, wrapped, { ...context, method: 'passkey-prf' }),
      'authentication-failed'
    );
  });

  it('wraps the identity key only under the recovery key or a passkey', async () => {
    const identity = await generateIdentityKeyPair();
    const pkcs8 = await exportPrivateKey(identity.privateKey);
    const recovery = patternBytes(32, 0x90);
    const passkey = await importUnlockSecret(patternBytes(32, 0x70));
    for (const [kek, method] of [
      [recovery, 'recovery-key'],
      [passkey, 'passkey-prf']
    ] as const) {
      const context: WrapContext = {
        purpose: 'identity-key',
        userId: 'user-1',
        method,
        unlockId: 'u1'
      };
      const wrapped = await wrapKey(kek, pkcs8, context);
      const restored = await importSigningPrivateKey(
        await unwrapKey(kek, wrapped, context)
      );
      expect(restored.extractable).toBe(false);
      const message = patternBytes(10);
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        restored,
        message
      );
      expect(
        await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          identity.publicKey,
          signature,
          message
        )
      ).toBe(true);
      // An account-key wrap is a different format and KEK altogether.
      await rejectsWith(
        unwrapKey(kek, wrapped, {
          purpose: 'account-key',
          userId: 'user-1',
          method,
          unlockId: 'u1'
        }),
        'malformed'
      );
    }
    // Device keys and approvals are not identity unlock methods.
    for (const method of ['device', 'device-approval']) {
      await rejectsWith(
        wrapKey(recovery, pkcs8, {
          purpose: 'identity-key',
          userId: 'user-1',
          method: method as never,
          unlockId: 'u1'
        }),
        'invalid-argument'
      );
    }
  });

  it('wraps the encryption private key under the account key', async () => {
    const accountKey = generateSymmetricKey();
    const encryption = await generateEncryptionKeyPair();
    const context: WrapContext = {
      purpose: 'encryption-private-key',
      userId: 'user-1',
      keyId: 'k1'
    };
    const wrapped = await wrapKey(
      accountKey,
      await exportPrivateKey(encryption.privateKey),
      context
    );
    const restored = await importEncryptionPrivateKey(
      await unwrapKey(accountKey, wrapped, context)
    );
    const sealed = await sealKey(encryption.publicKey, PROJECT_KEY, {
      purpose: 'project-key',
      userId: 'user-1',
      projectId: 'p',
      keyEpoch: 1
    });
    expect(
      await openSealedKey(
        { privateKey: restored, publicKey: encryption.publicKey },
        sealed,
        {
          purpose: 'project-key',
          userId: 'user-1',
          projectId: 'p',
          keyEpoch: 1
        }
      )
    ).toEqual(PROJECT_KEY);
    await rejectsWith(
      unwrapKey(accountKey, wrapped, { ...context, keyId: 'k2' }),
      'authentication-failed'
    );
  });

  it('validates contexts and key lengths', async () => {
    const bad: unknown[] = [
      { purpose: 'version-key', projectId: 'p', keyEpoch: 1, kind: 'document' },
      { ...BLOB_CONTEXT, extra: 'x' },
      { ...BLOB_CONTEXT, keyEpoch: -1 },
      { ...BLOB_CONTEXT, kind: 'thumbnail' },
      { ...BLOB_CONTEXT, projectId: '' },
      { ...BLOB_CONTEXT, versionId: 'x'.repeat(257) },
      { purpose: 'unknown' },
      { purpose: 'toString' },
      null
    ];
    for (const context of bad) {
      await rejectsWith(
        wrapKey(PROJECT_KEY, BLOB_KEY, context as WrapContext),
        'invalid-argument'
      );
    }
    await rejectsWith(
      wrapKey(PROJECT_KEY, patternBytes(31), BLOB_CONTEXT),
      'invalid-argument'
    );
    await rejectsWith(
      wrapKey(patternBytes(31), BLOB_KEY, BLOB_CONTEXT),
      'invalid-argument'
    );
  });

  it('encodes contexts canonically regardless of property order', () => {
    const reordered = {
      versionId: '7',
      kind: 'document',
      keyEpoch: 2,
      projectId: 'project-a',
      purpose: 'version-key'
    } as const;
    expect(encodeWrapContext(reordered)).toEqual(
      encodeWrapContext(BLOB_CONTEXT)
    );
  });
});

describe('share snapshot keys', () => {
  it('wraps one version key for members and for link visitors', async () => {
    const projectKey = generateSymmetricKey();
    const shareKey = generateSymmetricKey();
    const versionKey = generateSymmetricKey();
    const context = {
      projectId: 'project-a',
      keyEpoch: 2,
      shareId: 'share-1',
      versionId: '9'
    };
    const wraps = await wrapShareSnapshotKey(
      projectKey,
      shareKey,
      versionKey,
      context
    );
    expect(wraps.forMembers[0]).toBe(2);
    expect(wraps.forLinkVisitors[0]).toBe(2);
    expect(
      await unwrapKey(projectKey, wraps.forMembers, {
        purpose: 'version-key',
        projectId: 'project-a',
        keyEpoch: 2,
        kind: 'share-snapshot',
        versionId: '9'
      })
    ).toEqual(versionKey);
    const visitorContext: WrapContext = {
      purpose: 'share-version-key',
      projectId: 'project-a',
      shareId: 'share-1',
      versionId: '9'
    };
    expect(
      await unwrapKey(shareKey, wraps.forLinkVisitors, visitorContext)
    ).toEqual(versionKey);
    // A visitor's share key opens neither the member wrap nor another share.
    await rejectsWith(
      unwrapKey(shareKey, wraps.forMembers, {
        purpose: 'version-key',
        projectId: 'project-a',
        keyEpoch: 2,
        kind: 'share-snapshot',
        versionId: '9'
      }),
      'authentication-failed'
    );
    await rejectsWith(
      unwrapKey(shareKey, wraps.forLinkVisitors, {
        ...visitorContext,
        shareId: 'share-2'
      }),
      'authentication-failed'
    );
  });
});

describe('sealing to a public key', () => {
  const CONTEXT: WrapContext = {
    purpose: 'project-key',
    userId: 'member-1',
    projectId: 'project-a',
    keyEpoch: 4
  };

  it('seals a project key to a member and opens it', async () => {
    const member = await generateEncryptionKeyPair();
    const raw = await exportPublicKey(member.publicKey);
    const sealed = await sealKey(raw, PROJECT_KEY, CONTEXT);
    expect(sealed[0]).toBe(1);
    expect(sealed.byteLength).toBe(1 + 65 + 12 + 32 + 16);
    expect(await openSealedKey(member, sealed, CONTEXT)).toEqual(PROJECT_KEY);
    expect(
      await openSealedKey(
        { privateKey: member.privateKey, publicKey: raw },
        sealed,
        CONTEXT
      )
    ).toEqual(PROJECT_KEY);
    // A re-wrap under the member's own account key afterwards.
    const accountKey = generateSymmetricKey();
    const rewrapped = await wrapKey(accountKey, PROJECT_KEY, CONTEXT);
    expect(await unwrapKey(accountKey, rewrapped, CONTEXT)).toEqual(
      PROJECT_KEY
    );
  });

  it('only the named recipient, context and version open it', async () => {
    const member = await generateEncryptionKeyPair();
    const other = await generateEncryptionKeyPair();
    const sealed = await sealKey(member.publicKey, PROJECT_KEY, CONTEXT);
    await rejectsWith(
      openSealedKey(other, sealed, CONTEXT),
      'authentication-failed'
    );
    // The right private key with a different claimed public key fails too.
    await rejectsWith(
      openSealedKey(
        { privateKey: member.privateKey, publicKey: other.publicKey },
        sealed,
        CONTEXT
      ),
      'authentication-failed'
    );
    await rejectsWith(
      openSealedKey(member, sealed, { ...CONTEXT, keyEpoch: 5 }),
      'authentication-failed'
    );
    await rejectsWith(
      openSealedKey(member, sealed, { ...CONTEXT, userId: 'member-2' }),
      'authentication-failed'
    );
    for (const at of [1, 40, 66, 80, sealed.byteLength - 1]) {
      const forged = new Uint8Array(sealed);
      forged[at]! ^= 0x01;
      await expect(
        openSealedKey(member, forged, CONTEXT)
      ).rejects.toBeInstanceOf(E2eeError);
    }
    const future = new Uint8Array(sealed);
    future[0] = 9;
    await rejectsWith(
      openSealedKey(member, future, CONTEXT),
      'unsupported-version'
    );
    await rejectsWith(
      openSealedKey(member, sealed.subarray(0, 70), CONTEXT),
      'malformed'
    );
  });

  it('seals the account key to a device being approved', async () => {
    const device = await generateEncryptionKeyPair(false);
    expect(device.privateKey.extractable).toBe(false);
    const accountKey = generateSymmetricKey();
    const context: WrapContext = {
      purpose: 'account-key',
      userId: 'user-1',
      method: 'device-approval',
      unlockId: 'device-2'
    };
    const sealed = await sealKey(device.publicKey, accountKey, context);
    expect(await openSealedKey(device, sealed, context)).toEqual(accountKey);
  });

  it('rejects malformed public keys', async () => {
    const raw = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    const offCurve = new Uint8Array(raw);
    offCurve[64]! ^= 0x01;
    await rejectsWith(importEncryptionPublicKey(offCurve), 'malformed');
    await rejectsWith(importEncryptionPublicKey(raw.subarray(1)), 'malformed');
    await rejectsWith(sealKey(offCurve, PROJECT_KEY, CONTEXT), 'malformed');
    await rejectsWith(
      importEncryptionPrivateKey(patternBytes(40)),
      'malformed'
    );
  });
});
