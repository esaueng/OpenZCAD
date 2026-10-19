/**
 * Test-only helpers: deterministic randomness and fixed P-256 keys. These
 * keys were generated for the test vectors and protect nothing.
 */
import type { Bytes } from './bytes';
import { publicKeyHash } from './codes';
import {
  signDeviceListEntry,
  verifyDeviceList,
  type DeviceListEntry,
  type DeviceSigner,
  type RevocationCutoff,
  type SignedDeviceListEntry,
  type VerifiedDeviceList
} from './devices';
import {
  exportPublicKey,
  generateDeviceSigningKeyPair,
  generateEncryptionKeyPair,
  generateIdentityKeyPair
} from './keys';
import type { RandomSource } from './primitives';

/** Bytes `start, start+1, …` (mod 256) on every call. */
export function patternBytes(length: number, start = 0): Bytes {
  return Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);
}

/** A random source that returns the queued values, then fails loudly. */
export function queuedRandom(...values: Uint8Array[]): RandomSource {
  return (length) => {
    const next = values.shift();
    if (!next || next.byteLength !== length) {
      throw new Error(`Test random source has no ${length}-byte value queued`);
    }
    return new Uint8Array(next);
  };
}

/** Mulberry32: a seeded generator for reproducible fuzzing. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FixedJwk {
  readonly x: string;
  readonly y: string;
  readonly d: string;
}

export const TEST_RECIPIENT_JWK: FixedJwk = {
  x: 'Il_lBM5w0Wogf5DaiEtdJ_QUa0byQPoAokzMujKnpCc',
  y: 'Kh--EaBkuIqCJ3WleqjVyBYHcp_t_juYEtoaklmZtDo',
  d: 'I0MKUV9N7yNf296BIyojD3mftIcW3RYlANrYKjrN_6w'
};

export const TEST_EPHEMERAL_JWK: FixedJwk = {
  x: 'gvtsMIE9hFCDIsEi785DAm59zqbw3p2WGm3zdfhvouQ',
  y: 'PxOEGWDmxjqkJ_jgGcQcq8i2Cmq1FrPo7KnHVOXoOF4',
  d: 'UOiZwiJEwRoOBQdOknIS5tZdGnNzwP8pB2oatR_u-Gs'
};

/** A fixed identity key for the device-list vector. */
export const TEST_IDENTITY_JWK: FixedJwk = {
  x: 'mv7B6kH6r7HXt4KYmwnKX_W-nrsGsRIqDlF3bvwZqJQ',
  y: 'QSBhdzfch7ycvgF0bsH6RKDKTiVHWIYySYz49P3Z9qU',
  d: '06ysBq-UkYBxen6Yq03bGC-WwFLiB0kW1L4lCn3nBjI'
};

/** A fixed device signing key for the signature vectors. */
export const TEST_SIGNER_JWK: FixedJwk = {
  x: '41Gt27rcv-RXJHMTMhBRl5wtB_4TGqC6CNz8u2IwHfw',
  y: '04RVfsEpwCPL1L5k0r_D7pxEmJxH8TaRuaMoMr-GJbQ',
  d: 'JmONwfHRPZHOzFmnywsOqRKPX_FZqn_8B-9WCVxtvd8'
};

export async function importFixedPair(
  jwk: FixedJwk,
  algorithm: 'ECDH' | 'ECDSA'
): Promise<CryptoKeyPair> {
  const base = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  const params = { name: algorithm, namedCurve: 'P-256' };
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey(
      'jwk',
      { ...base, d: jwk.d },
      params,
      false,
      algorithm === 'ECDH' ? ['deriveBits'] : ['sign']
    ),
    crypto.subtle.importKey(
      'jwk',
      base,
      params,
      true,
      algorithm === 'ECDH' ? [] : ['verify']
    )
  ]);
  return { privateKey, publicKey };
}

export interface TestDevice {
  readonly deviceId: string;
  readonly pair: CryptoKeyPair;
  readonly signingKey: Bytes;
  readonly keyHash: Bytes;
}

/** A user with an identity key, an encryption key and certified devices. */
export class TestUser {
  readonly chain: SignedDeviceListEntry[] = [];
  list!: VerifiedDeviceList;
  identityKey!: Bytes;
  encryptionKey!: Bytes;
  devices: TestDevice[] = [];

  private constructor(
    readonly userId: string,
    readonly identity: CryptoKeyPair
  ) {}

  static async create(userId: string, deviceIds = ['d1']): Promise<TestUser> {
    const user = new TestUser(userId, await generateIdentityKeyPair());
    user.identityKey = await exportPublicKey(user.identity.publicKey);
    user.encryptionKey = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    for (const deviceId of deviceIds) await user.addDevice(deviceId, false);
    await user.publish();
    return user;
  }

  async addDevice(deviceId: string, publish = true): Promise<TestDevice> {
    const pair = await generateDeviceSigningKeyPair();
    const signingKey = await exportPublicKey(pair.publicKey);
    const device = {
      deviceId,
      pair,
      signingKey,
      keyHash: await publicKeyHash(signingKey)
    };
    this.devices.push(device);
    if (publish) await this.publish();
    return device;
  }

  async revoke(
    deviceId: string,
    cutoffs: readonly RevocationCutoff[] = []
  ): Promise<void> {
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    await this.publish(cutoffs);
  }

  async replaceEncryptionKey(): Promise<void> {
    this.encryptionKey = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    await this.publish();
  }

  /** A signer for one device, citing the newest device-list entry. */
  signer(
    deviceId = this.devices[0]!.deviceId,
    device?: TestDevice
  ): DeviceSigner {
    const d = device ?? this.devices.find((x) => x.deviceId === deviceId)!;
    return {
      userId: this.userId,
      privateKey: d.pair.privateKey,
      deviceKeyHash: d.keyHash,
      deviceListSequence: this.list.latestSequence
    };
  }

  private async publish(
    cutoffs: readonly RevocationCutoff[] = []
  ): Promise<void> {
    const entry: DeviceListEntry = {
      userId: this.userId,
      sequence: this.chain.length,
      previousEntryHash: this.list?.latestHash ?? null,
      encryptionKey: this.encryptionKey,
      devices: this.devices.map(({ deviceId, signingKey }) => ({
        deviceId,
        signingKey
      })),
      cutoffs
    };
    this.chain.push(await signDeviceListEntry(this.identity.privateKey, entry));
    this.list = await verifyDeviceList(this.identity.publicKey, this.chain);
  }
}
