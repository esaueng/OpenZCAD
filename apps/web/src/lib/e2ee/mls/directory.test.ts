// @vitest-environment node
// The committed MLS WASM is read from disk, which needs Node’s file URLs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Mls, MlsSession } from '@openzcad/mls';
import { inProcessMls } from '../../../../../../packages/mls/src/test-support';
import { certifyLeaf, verifyLeafCertification } from './certify';
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
  projectId = PROJECT
): Promise<{ session: MlsSession; certification: LeafCertification }> {
  const session = await mls.generate({
    projectId,
    userId: account.userId,
    deviceId
  });
  const certification = await certifyLeaf(session, device(account, deviceId));
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
  it('sign the package payload with the device key and verify against it', async () => {
    const { certification } = await leaf(alice, 'alice_laptop');
    expect(certification.certification).toHaveLength(65);
    expect(certification.certification[0]).toBe(1);
    const signingKey = alice.list.devices[0]!.signingKey;
    expect(
      await verifyLeafCertification(
        mls,
        { projectId: PROJECT, ...certification },
        signingKey
      )
    ).toBe(true);
    // Bound to the project, the device and the key it names.
    expect(
      await verifyLeafCertification(
        mls,
        { projectId: 'prj_other', ...certification },
        signingKey
      )
    ).toBe(false);
    expect(
      await verifyLeafCertification(
        mls,
        { projectId: PROJECT, ...certification, deviceId: 'alice_other' },
        signingKey
      )
    ).toBe(false);
    expect(
      await verifyLeafCertification(
        mls,
        { projectId: PROJECT, ...certification },
        bob.list.devices[0]!.signingKey
      )
    ).toBe(false);
  });

  it('accept an external signer such as a Keychain-held key', async () => {
    const session = await mls.generate({
      projectId: PROJECT,
      userId: alice.userId,
      deviceId: 'alice_laptop'
    });
    const inner = device(alice, 'alice_laptop').signing.privateKey;
    let calls = 0;
    const certification = await certifyLeaf(session, {
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
    });
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
    ).toBe(true);
  });

  it('refuse to certify another device’s leaf', async () => {
    const session = await mls.generate({
      projectId: PROJECT,
      userId: alice.userId,
      deviceId: 'alice_laptop'
    });
    await expect(
      certifyLeaf(session, device(bob, 'bob_phone'))
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
    expect(bobDevices[0]!.leafKeys).toEqual([{ key: b.certification.leafKey }]);
    // No certifiedEpoch: nothing verified binds one yet.
    expect(bobDevices[0]!.leafKeys[0]!.certifiedEpoch).toBeUndefined();
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
  });
});
