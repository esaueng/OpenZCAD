/**
 * Test-only accounts for the MLS client tests: a real identity-signed,
 * verified device list whose devices hold real signing keys, so leaf
 * certifications are signed and checked exactly as in the app.
 */
import {
  accountKeyCommitment,
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  generateSymmetricKey,
  nextDeviceListEntry,
  signDeviceListEntry,
  verifyDeviceList,
  type DeviceListEntry,
  type ListedDevice,
  type SignedDeviceListEntry,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import type { CertifyingDevice } from './certify';

export interface TestDevice extends CertifyingDevice {
  readonly signing: CryptoKeyPair;
}

export interface TestAccount {
  readonly userId: string;
  readonly devices: ReadonlyMap<string, TestDevice>;
  list: VerifiedDeviceList;
  /** Append an identity-signed entry revoking `deviceId`. */
  revoke(deviceId: string): Promise<VerifiedDeviceList>;
}

const ADDED_AT = 1_700_000_000_000;

async function ecdhPublic(): Promise<Uint8Array> {
  return exportPublicKey((await generateEncryptionKeyPair()).publicKey);
}

export async function testAccount(
  userId: string,
  deviceIds: readonly string[]
): Promise<TestAccount> {
  const identity = await generateSigningKeyPair(false);
  const identityRaw = await exportPublicKey(identity.publicKey);
  const devices = new Map<string, TestDevice>();
  const listed: ListedDevice[] = [];
  for (const deviceId of deviceIds) {
    const signing = await generateSigningKeyPair(false);
    devices.set(deviceId, { userId, deviceId, signing });
    listed.push({
      deviceId,
      label: deviceId,
      signingKey: await exportPublicKey(signing.publicKey),
      unlockKey: await ecdhPublic(),
      addedAt: ADDED_AT
    });
  }
  const genesis: DeviceListEntry = {
    userId,
    sequence: 0,
    previousEntryHash: null,
    issuedAt: ADDED_AT,
    previousIdentityKeyHash: null,
    encryptionKey: await ecdhPublic(),
    accountKeyCommitment: await accountKeyCommitment(generateSymmetricKey()),
    devices: listed,
    unlockTargets: [
      {
        kind: 'recovery-key',
        targetId: 'rk_1',
        publicKey: await ecdhPublic(),
        addedAt: ADDED_AT
      }
    ],
    revoked: []
  };
  const chain: SignedDeviceListEntry[] = [
    await signDeviceListEntry(identity.privateKey, genesis)
  ];
  const account: TestAccount = {
    userId,
    devices,
    list: await verifyDeviceList(identityRaw, chain),
    async revoke(deviceId) {
      const entry = nextDeviceListEntry(account.list, {
        issuedAt: ADDED_AT + chain.length,
        removeDeviceIds: [deviceId],
        encryptionKey: await ecdhPublic(),
        accountKeyCommitment: await accountKeyCommitment(generateSymmetricKey())
      });
      chain.push(await signDeviceListEntry(identity.privateKey, entry));
      account.list = await verifyDeviceList(identityRaw, chain);
      return account.list;
    }
  };
  return account;
}

export function device(account: TestAccount, deviceId: string): TestDevice {
  const found = account.devices.get(deviceId);
  if (!found) throw new Error(`no test device ${deviceId}`);
  return found;
}
