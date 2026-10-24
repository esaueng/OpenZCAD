// @vitest-environment node
// The committed MLS WASM is read from disk, which needs Node’s file URLs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Mls, MlsSession } from '@openzcad/mls';
import { inProcessMls } from '../../../../../../packages/mls/src/test-support';
import { ecdsaSign } from '@openzcad/crypto';
import {
  certifyLeaf,
  claimedCertifiedEpoch,
  verifyLeafCertification
} from './certify';
import {
  buildDeviceDirectory,
  MlsDirectoryError,
  type LeafCertification
} from './directory';
import { device, testAccount, type TestAccount } from './testFixtures';

const PROJECT = 'prj_directory';

let mls: Mls;
let alice: TestAccount;
let bob: TestAccount;

beforeAll(async () => {
  mls = inProcessMls();
  alice = await testAccount('user_alice', ['alice_laptop']);
  bob = await testAccount('user_bob', ['bob_phone', 'bob_tablet']);
});

async function leaf(
  account: TestAccount,
  deviceId: string,
  projectId = PROJECT,
  certifiedEpoch = 0
): Promise<{ session: MlsSession; certification: LeafCertification }> {
  const session = await mls.generate({
    projectId,
    userId: account.userId,
    deviceId
  });
  const certification = await certifyLeaf(
    session,
    device(account, deviceId),
    certifiedEpoch
  );
  return {
    session,
    certification: {
      userId: account.userId,
      deviceId,
      leafKey: await session.signatureKey(),
      certification
    }
  };
}

/** The same certification, claiming another epoch than the one signed. */
function claiming(certification: Uint8Array, epoch: number): Uint8Array {
  const copy = new Uint8Array(certification);
  new DataView(copy.buffer).setBigUint64(1, BigInt(epoch));
  return copy;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MlsDirectoryError);
    return (error as MlsDirectoryError).code;
  }
  throw new Error('expected a refusal');
}

describe('leaf certifications', () => {
  it('sign the package payload, epoch included, with the device key and verify against it', async () => {
    const { session, certification } = await leaf(
      alice,
      'alice_laptop',
      PROJECT,
      7
    );
    // u8 version 2 | u64 epoch | r || s
    expect(certification.certification).toHaveLength(73);
    expect(certification.certification[0]).toBe(2);
    expect([...certification.certification.subarray(1, 9)]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 7
    ]);
    expect(claimedCertifiedEpoch(certification.certification)).toBe(7);
    const signingKey = alice.list.devices[0]!.signingKey;
    expect(
      await verifyLeafCertification(
        mls,
        { projectId: PROJECT, ...certification },
        signingKey
      )
    ).toEqual({ certifiedEpoch: 7 });
    // The signature is over the session's own payload for that epoch.
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        await crypto.subtle.importKey(
          'raw',
          new Uint8Array(signingKey),
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify']
        ),
        new Uint8Array(certification.certification.subarray(9)),
        new Uint8Array(await session.certificationPayload(7))
      )
    ).toBe(true);
    // Bound to the project, the device, the key and the epoch it names.
    expect(
      await verifyLeafCertification(
        mls,
        { projectId: 'prj_other', ...certification },
        signingKey
      )
    ).toBeNull();
    expect(
      await verifyLeafCertification(
        mls,
        { projectId: PROJECT, ...certification, deviceId: 'alice_other' },
        signingKey
      )
    ).toBeNull();
    expect(
      await verifyLeafCertification(
        mls,
        { projectId: PROJECT, ...certification },
        bob.list.devices[0]!.signingKey
      )
    ).toBeNull();
    for (const epoch of [6, 8, 0])
      expect(
        await verifyLeafCertification(
          mls,
          {
            projectId: PROJECT,
            ...certification,
            certification: claiming(certification.certification, epoch)
          },
          signingKey
        )
      ).toBeNull();
  });

  it('refuse a version 1 certification, which signs no epoch', async () => {
    const session = await mls.generate({
      projectId: PROJECT,
      userId: alice.userId,
      deviceId: 'alice_laptop'
    });
    // A version 1 certification: u8 1 | r || s, with no epoch to verify.
    const rs = await ecdsaSign(
      device(alice, 'alice_laptop').signing.privateKey,
      new Uint8Array(await session.certificationPayload(0))
    );
    const v1 = new Uint8Array(65);
    v1[0] = 1;
    v1.set(rs, 1);
    expect(claimedCertifiedEpoch(v1)).toBeNull();
    expect(
      await verifyLeafCertification(
        mls,
        {
          projectId: PROJECT,
          userId: alice.userId,
          deviceId: 'alice_laptop',
          leafKey: await session.signatureKey(),
          certification: v1
        },
        alice.list.devices[0]!.signingKey
      )
    ).toBeNull();
  });

  it('refuse to certify from something that is not an epoch', async () => {
    for (const epoch of [-1, 0.5, 2 ** 53]) {
      const session = await mls.generate({
        projectId: PROJECT,
        userId: alice.userId,
        deviceId: 'alice_laptop'
      });
      await expect(
        certifyLeaf(session, device(alice, 'alice_laptop'), epoch)
      ).rejects.toThrow('group epoch');
      expect((await session.status()).certified).toBe(false);
    }
  });

  it('accept an external signer such as a Keychain-held key', async () => {
    const session = await mls.generate({
      projectId: PROJECT,
      userId: alice.userId,
      deviceId: 'alice_laptop'
    });
    const inner = device(alice, 'alice_laptop').signing.privateKey;
    let calls = 0;
    const certification = await certifyLeaf(
      session,
      {
        userId: alice.userId,
        deviceId: 'alice_laptop',
        signing: {
          privateKey: {
            external: 'ecdsa-p256-sha256',
            async sign(message) {
              calls++;
              return new Uint8Array(
                await crypto.subtle.sign(
                  { name: 'ECDSA', hash: 'SHA-256' },
                  inner,
                  new Uint8Array(message)
                )
              );
            }
          }
        }
      },
      3
    );
    expect(calls).toBe(1);
    expect(
      await verifyLeafCertification(
        mls,
        {
          projectId: PROJECT,
          userId: alice.userId,
          deviceId: 'alice_laptop',
          leafKey: await session.signatureKey(),
          certification
        },
        alice.list.devices[0]!.signingKey
      )
    ).toEqual({ certifiedEpoch: 3 });
  });

  it('refuse to certify another device’s leaf', async () => {
    const session = await mls.generate({
      projectId: PROJECT,
      userId: alice.userId,
      deviceId: 'alice_laptop'
    });
    await expect(
      certifyLeaf(session, device(bob, 'bob_phone'), 0)
    ).rejects.toThrow('different device');
  });
});

describe('device directory', () => {
  it('lists verified leaf keys under their certified devices', async () => {
    const a = await leaf(alice, 'alice_laptop');
    const b = await leaf(bob, 'bob_phone');
    const directory = await buildDeviceDirectory(mls, PROJECT, {
      lists: [alice.list, bob.list],
      certifications: [a.certification, b.certification]
    });
    expect(directory.users.map((u) => u.userId)).toEqual([
      'user_alice',
      'user_bob'
    ]);
    const bobDevices = directory.users[1]!.devices;
    expect(bobDevices.map((d) => [d.deviceId, d.status])).toEqual([
      ['bob_phone', 'active'],
      ['bob_tablet', 'active']
    ]);
    // The epoch the device signed, verified, reaches the policy.
    expect(bobDevices[0]!.leafKeys).toEqual([
      { key: b.certification.leafKey, certifiedEpoch: 0 }
    ]);
  });

  it('refuses a certification whose claimed epoch differs from the signed one', async () => {
    const b = await leaf(bob, 'bob_phone', PROJECT, 2);
    for (const epoch of [9, 1]) {
      expect(
        await refusal(
          buildDeviceDirectory(mls, PROJECT, {
            lists: [bob.list],
            certifications: [
              {
                ...b.certification,
                certification: claiming(b.certification.certification, epoch)
              }
            ]
          })
        )
      ).toBe('certification-invalid');
    }
    const directory = await buildDeviceDirectory(mls, PROJECT, {
      lists: [bob.list],
      certifications: [b.certification]
    });
    expect(directory.users[0]!.devices[0]!.leafKeys).toEqual([
      { key: b.certification.leafKey, certifiedEpoch: 2 }
    ]);
  });

  it('keeps the earlier epoch when one key carries two verified certifications', async () => {
    const b = await leaf(bob, 'bob_phone', PROJECT, 5);
    // The same device's signature over the same key from epoch 2.
    const earlier = new Uint8Array(73);
    earlier[0] = 2;
    new DataView(earlier.buffer).setBigUint64(1, 2n);
    earlier.set(
      await ecdsaSign(
        device(bob, 'bob_phone').signing.privateKey,
        new Uint8Array(await b.session.certificationPayload(2))
      ),
      9
    );
    for (const order of [
      [b.certification.certification, earlier],
      [earlier, b.certification.certification]
    ]) {
      const directory = await buildDeviceDirectory(mls, PROJECT, {
        lists: [bob.list],
        certifications: order.map((certification) => ({
          ...b.certification,
          certification
        }))
      });
      expect(directory.users[0]!.devices[0]!.leafKeys).toEqual([
        { key: b.certification.leafKey, certifiedEpoch: 2 }
      ]);
    }
  });

  it('refuses a forged certification', async () => {
    const a = await leaf(alice, 'alice_laptop');
    const forged = new Uint8Array(a.certification.certification);
    forged[10]! ^= 1;
    expect(
      await refusal(
        buildDeviceDirectory(mls, PROJECT, {
          lists: [alice.list],
          certifications: [{ ...a.certification, certification: forged }]
        })
      )
    ).toBe('certification-invalid');
    // A real signature by a key the list does not certify for that device.
    const bobLeaf = await leaf(bob, 'bob_phone');
    expect(
      await refusal(
        buildDeviceDirectory(mls, PROJECT, {
          lists: [alice.list, bob.list],
          certifications: [{ ...bobLeaf.certification, deviceId: 'bob_tablet' }]
        })
      )
    ).toBe('certification-invalid');
    // A certification for another project's leaf.
    const elsewhere = await leaf(alice, 'alice_laptop', 'prj_other');
    expect(
      await refusal(
        buildDeviceDirectory(mls, PROJECT, {
          lists: [alice.list],
          certifications: [elsewhere.certification]
        })
      )
    ).toBe('certification-invalid');
  });

  it('refuses a device or user the device lists do not certify', async () => {
    const a = await leaf(alice, 'alice_laptop');
    expect(
      await refusal(
        buildDeviceDirectory(mls, PROJECT, {
          lists: [alice.list],
          certifications: [{ ...a.certification, deviceId: 'alice_rogue' }]
        })
      )
    ).toBe('device-unknown');
    expect(
      await refusal(
        buildDeviceDirectory(mls, PROJECT, {
          lists: [bob.list],
          certifications: [a.certification]
        })
      )
    ).toBe('user-unknown');
    expect(
      await refusal(
        buildDeviceDirectory(mls, PROJECT, {
          lists: [alice.list, alice.list],
          certifications: []
        })
      )
    ).toBe('list-duplicate');
  });

  it('refuses a revoked device without a revocation cutoff, never defaulting one', async () => {
    const carol = await testAccount('user_carol', ['carol_a', 'carol_b']);
    await carol.revoke('carol_b');
    expect(
      await refusal(
        buildDeviceDirectory(mls, PROJECT, {
          lists: [carol.list],
          certifications: []
        })
      )
    ).toBe('revocation-cutoff-missing');
    expect(
      await refusal(
        buildDeviceDirectory(mls, PROJECT, {
          lists: [carol.list],
          certifications: [],
          revocationCutoffs: new Map([
            ['user_carol', new Map([['carol_b', -1]])]
          ])
        })
      )
    ).toBe('revocation-cutoff-invalid');
    const directory = await buildDeviceDirectory(mls, PROJECT, {
      lists: [carol.list],
      certifications: [],
      revocationCutoffs: new Map([['user_carol', new Map([['carol_b', 3]])]])
    });
    expect(directory.users[0]!.devices).toEqual([
      { deviceId: 'carol_a', status: 'active', leafKeys: [] },
      {
        deviceId: 'carol_b',
        status: 'revoked',
        leafKeys: [],
        revocationCutoffEpoch: 3
      }
    ]);
  });

  describe('as the policy reads it', () => {
    async function owner() {
      const a = await leaf(alice, 'alice_laptop');
      return a;
    }

    async function refusedCodes(promise: Promise<unknown>): Promise<string[]> {
      try {
        await promise;
      } catch (error) {
        expect((error as { name?: string }).name).toBe('MlsError');
        return [...(error as { codes: string[] }).codes];
      }
      throw new Error('expected a policy refusal');
    }

    it('admits a certified device and refuses an uncertified one', async () => {
      const a = await owner();
      const b = await leaf(bob, 'bob_phone');
      const uncertified = await leaf(bob, 'bob_tablet');
      await a.session.setDirectory(
        await buildDeviceDirectory(mls, PROJECT, {
          lists: [alice.list, bob.list],
          // bob_tablet's certification is never shown to the directory.
          certifications: [a.certification, b.certification]
        })
      );
      await a.session.createGroup();
      const codes = await refusedCodes(
        a.session.commit({
          add: [await uncertified.session.keyPackage()],
          setRoles: [{ userId: bob.userId, role: 'editor' }]
        })
      );
      expect(codes).toContain('credential-unknown');
      const pending = await a.session.commit({
        add: [await b.session.keyPackage()],
        setRoles: [{ userId: bob.userId, role: 'editor' }]
      });
      expect(pending.welcome).not.toBeNull();
      await a.session.discardCommit();
    });

    it('refuses a revoked device’s leaf as revoked', async () => {
      const dave = await testAccount('user_dave', ['dave_old', 'dave_new']);
      const stale = await leaf(dave, 'dave_old');
      await dave.revoke('dave_old');
      const a = await owner();
      await a.session.setDirectory(
        await buildDeviceDirectory(mls, PROJECT, {
          lists: [alice.list, dave.list],
          certifications: [a.certification, stale.certification],
          revocationCutoffs: new Map([
            ['user_dave', new Map([['dave_old', 0]])]
          ])
        })
      );
      await a.session.createGroup();
      const codes = await refusedCodes(
        a.session.commit({
          add: [await stale.session.keyPackage()],
          setRoles: [{ userId: dave.userId, role: 'viewer' }]
        })
      );
      expect(codes).toContain('credential-revoked');
    });

    it('lets a recovery Add through only for a key certified at or after the latest removal', async () => {
      const a = await owner();
      const phone = await leaf(bob, 'bob_phone');
      // bob_tablet certifies two leaf keys: one at epoch 1, held back while
      // a leaf of Bob is removed in epoch 2, and one at epoch 2.
      const early = await leaf(bob, 'bob_tablet', PROJECT, 1);
      const late = await leaf(bob, 'bob_tablet', PROJECT, 2);
      await a.session.setDirectory(
        await buildDeviceDirectory(mls, PROJECT, {
          lists: [alice.list, bob.list],
          certifications: [
            a.certification,
            phone.certification,
            early.certification,
            late.certification
          ]
        })
      );
      await a.session.createGroup();
      await a.session.commit({
        add: [await phone.session.keyPackage()],
        setRoles: [{ userId: bob.userId, role: 'editor' }]
      });
      expect((await a.session.confirmCommit()).epoch).toBe(1);
      const phoneIndex = (await a.session.status()).members.find(
        (member) => member.deviceId === 'bob_phone'
      )!.index;
      await a.session.commit({ remove: [phoneIndex] });
      const removal = await a.session.confirmCommit();
      expect(removal.epoch).toBe(2);
      expect(removal.removed.map((leaf) => leaf.deviceId)).toEqual([
        'bob_phone'
      ]);
      // Bob is still listed as an editor: adding a leaf for him is a
      // recovery Add, which needs a key certified from epoch 2 or later.
      const codes = await refusedCodes(
        a.session.commit({ add: [await early.session.keyPackage()] })
      );
      expect(codes).toContain('leaf-certified-before-removal');
      const pending = await a.session.commit({
        add: [await late.session.keyPackage()]
      });
      expect(pending.welcome).not.toBeNull();
      const added = await a.session.confirmCommit();
      expect(added.added.map((leaf) => leaf.deviceId)).toEqual(['bob_tablet']);
    });
  });
});
