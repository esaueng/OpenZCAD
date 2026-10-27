import { beforeAll, describe, expect, it } from 'vitest';
import {
  exportPublicKey,
  generateSigningKeyPair,
  generateSymmetricKey,
  toBase64Url
} from './index';
import {
  decodeMlsAuthorityManifest,
  decodeMlsAuthorityTrust,
  encodeMlsAuthorityManifest,
  encodeMlsAuthorityTrust,
  openMlsAuthorityTrust,
  signMlsAuthorityManifest,
  signMlsAuthorityTrust,
  verifyMlsAuthorityManifest,
  type MlsAuthorityManifest,
  type MlsAuthorityTrust
} from './mls-authority';

const manifest: MlsAuthorityManifest = {
  projectId: 'project_test',
  ownerUserId: 'owner',
  ownerIdentityKeyHash: '1'.repeat(64),
  roots: [
    { generation: 0, keyEpochBase: 0, groupInfo: 'AA' },
    {
      generation: 1,
      keyEpochBase: 7,
      groupInfo: 'AQ',
      previousGroupInfo: 'Aw',
      resetAuthority: { statement: 'AA', signature: 'AA' }
    }
  ],
  checkpoint: { generation: 1, keyEpoch: 9, groupInfo: 'Ag' },
  signerDeviceId: 'owner_laptop'
};
let owner: CryptoKeyPair;
let device: CryptoKeyPair;
beforeAll(async () => {
  owner = await generateSigningKeyPair();
  device = await generateSigningKeyPair();
});
const wrapped = (statement: Uint8Array, signature: Uint8Array) => ({
  statement: toBase64Url(statement),
  signature: toBase64Url(signature)
});

describe('application MLS authority anchors', () => {
  it('binds the owner, every generation/base/root, and the checkpoint to the owner signature', async () => {
    const signed = await signMlsAuthorityManifest(owner.privateKey, manifest);
    expect(await verifyMlsAuthorityManifest(signed, owner.publicKey)).toEqual(
      manifest
    );
    for (const changed of [
      { ...manifest, ownerUserId: 'someone_else' },
      { ...manifest, ownerIdentityKeyHash: '2'.repeat(64) },
      { ...manifest, projectId: 'another_project' },
      {
        ...manifest,
        roots: [{ ...manifest.roots[0]!, groupInfo: 'Aw' }, manifest.roots[1]!]
      },
      {
        ...manifest,
        roots: [manifest.roots[0]!, { ...manifest.roots[1]!, keyEpochBase: 8 }]
      },
      { ...manifest, checkpoint: { ...manifest.checkpoint!, keyEpoch: 10 } }
    ])
      await expect(
        verifyMlsAuthorityManifest(
          { ...signed, statement: encodeMlsAuthorityManifest(changed) },
          owner.publicKey
        )
      ).rejects.toThrow();
    await expect(
      verifyMlsAuthorityManifest(signed, device.publicKey)
    ).rejects.toThrow();
  });

  it('transfers trusted roots and accepted membership with both an account MAC and device signature', async () => {
    const root = await signMlsAuthorityManifest(owner.privateKey, manifest);
    const record: MlsAuthorityTrust = {
      userId: 'invitee',
      projectId: manifest.projectId,
      sequence: 4,
      accountKeyGeneration: 2,
      accountKeySequence: 3,
      signerDeviceId: 'invitee_laptop',
      manifest: wrapped(root.statement, root.signature),
      latestKeyEpoch: 10,
      latestGroupInfo: 'Aw'
    };
    const key = generateSymmetricKey();
    const signed = await signMlsAuthorityTrust(key, device.privateKey, record);
    expect(
      await openMlsAuthorityTrust(
        key,
        await exportPublicKey(device.publicKey),
        signed
      )
    ).toEqual(record);
    await expect(
      openMlsAuthorityTrust(generateSymmetricKey(), device.publicKey, signed)
    ).rejects.toThrow();
    await expect(
      openMlsAuthorityTrust(key, owner.publicKey, signed)
    ).rejects.toThrow();
    for (const change of [
      { userId: 'other' },
      { projectId: 'different' },
      { latestKeyEpoch: 11 },
      { accountKeyGeneration: 3 },
      { accountKeySequence: 4 },
      { sequence: 5 },
      { signerDeviceId: 'other_device' }
    ]) {
      await expect(
        openMlsAuthorityTrust(key, device.publicKey, {
          ...signed,
          record: encodeMlsAuthorityTrust({
            ...record,
            ...change,
            ...(change.projectId
              ? {
                  manifest: wrapped(
                    encodeMlsAuthorityManifest({
                      ...manifest,
                      projectId: change.projectId
                    }),
                    root.signature
                  )
                }
              : {})
          })
        })
      ).rejects.toThrow();
    }
    const changedMac = signed.recordMac.slice();
    changedMac[0]! ^= 1;
    await expect(
      openMlsAuthorityTrust(key, device.publicKey, {
        ...signed,
        recordMac: changedMac
      })
    ).rejects.toThrow();
    expect(decodeMlsAuthorityTrust(signed.record)).toEqual(record);
  });

  it('rejects noncanonical encodings and invalid generation/checkpoint mappings', () => {
    const encoded = encodeMlsAuthorityManifest(manifest);
    expect(decodeMlsAuthorityManifest(encoded)).toEqual(manifest);
    for (const value of [
      { ...manifest, roots: [] },
      { ...manifest, roots: [{ ...manifest.roots[0]!, keyEpochBase: 1 }] },
      { ...manifest, roots: [{ ...manifest.roots[0]!, generation: 1 }] },
      {
        ...manifest,
        roots: [manifest.roots[0]!, { ...manifest.roots[1]!, keyEpochBase: 0 }]
      },
      {
        ...manifest,
        checkpoint: { generation: 0, keyEpoch: 7, groupInfo: 'AA' }
      },
      {
        ...manifest,
        checkpoint: { generation: 2, keyEpoch: 10, groupInfo: 'AA' }
      },
      { ...manifest, roots: [{ ...manifest.roots[0]!, groupInfo: 'AB' }] }
    ])
      expect(() => encodeMlsAuthorityManifest(value)).toThrow();
    const withExtra = JSON.parse(new TextDecoder().decode(encoded)) as Record<
      string,
      unknown
    >;
    withExtra.extra = true;
    expect(() =>
      decodeMlsAuthorityManifest(
        new TextEncoder().encode(JSON.stringify(withExtra))
      )
    ).toThrow();
    expect(() =>
      decodeMlsAuthorityManifest(
        new TextEncoder().encode(` ${new TextDecoder().decode(encoded)}`)
      )
    ).toThrow();
  });
});
