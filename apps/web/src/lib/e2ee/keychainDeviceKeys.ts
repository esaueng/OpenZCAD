import {
  importEncryptionPublicKey,
  importSigningPublicKey,
  type ExternalAgreementKey,
  type ExternalSigningKey
} from '@openzcad/crypto';
import {
  createNativeDeviceKeys,
  deleteNativeDeviceKeys,
  deriveWithNativeDeviceKey,
  isDesktopApp,
  NativeDeviceKeysError,
  signWithNativeDeviceKey,
  type NativeDeviceKeys
} from '../desktopBridge';
import type { DeviceKeyPairs } from './accountKeys';
import {
  indexedDbDeviceStore,
  type DeviceCandidateKeys,
  type DeviceKeyStore,
  type StoredDevice
} from './deviceStore';

/**
 * Desktop device keys in the macOS Keychain (ADR-024, Unlock and devices).
 *
 * The native host creates the signing and unlock keys and signs and derives
 * with them; the WebView holds only public keys and a key id. IndexedDB keeps
 * the device record as in a browser, with each private key replaced by its
 * Keychain key id, and the store rebuilds the native handles on load.
 */
export interface KeychainHost {
  create(): Promise<NativeDeviceKeys>;
  sign(keyId: string, message: Uint8Array): Promise<Uint8Array>;
  derive(keyId: string, peer: Uint8Array): Promise<Uint8Array>;
  remove(keyId: string): Promise<void>;
}

export const tauriKeychainHost: KeychainHost = {
  create: createNativeDeviceKeys,
  sign: signWithNativeDeviceKey,
  derive: deriveWithNativeDeviceKey,
  remove: deleteNativeDeviceKeys
};

interface KeychainSigningKey extends ExternalSigningKey {
  readonly keychainKeyId: string;
}

interface KeychainAgreementKey extends ExternalAgreementKey {
  readonly keychainKeyId: string;
}

/** What IndexedDB stores in place of a Keychain private key. */
interface StoredKeychainKey {
  readonly keychainKeyId: string;
}

function keychainKeyId(value: unknown): string | null {
  const id = (value as Partial<StoredKeychainKey> | null)?.keychainKeyId;
  return typeof id === 'string' ? id : null;
}

function signingHandle(host: KeychainHost, keyId: string): KeychainSigningKey {
  return {
    external: 'ecdsa-p256-sha256',
    keychainKeyId: keyId,
    sign: async (message) => new Uint8Array(await host.sign(keyId, message))
  };
}

function agreementHandle(
  host: KeychainHost,
  keyId: string
): KeychainAgreementKey {
  return {
    external: 'ecdh-p256',
    keychainKeyId: keyId,
    deriveBits: async (peer) => new Uint8Array(await host.derive(keyId, peer))
  };
}

async function keyPairs(
  host: KeychainHost,
  keyId: string,
  signingPublicKey: Uint8Array,
  unlockPublicKey: Uint8Array
): Promise<DeviceKeyPairs> {
  return {
    signing: {
      privateKey: signingHandle(host, keyId),
      publicKey: await importSigningPublicKey(signingPublicKey)
    },
    unlock: {
      privateKey: agreementHandle(host, keyId),
      publicKey: await importEncryptionPublicKey(unlockPublicKey)
    }
  };
}

/**
 * Key ids a failed native creation stored but could not remove again
 * (`NativeDeviceKeysError.keyId`). No record names them, so this page keeps
 * them and retries the removal before each later creation.
 */
const leftoverKeys = new WeakMap<KeychainHost, Set<string>>();

async function removeLeftoverKeys(host: KeychainHost): Promise<void> {
  const keyIds = leftoverKeys.get(host);
  for (const keyId of keyIds ?? []) {
    try {
      await host.remove(keyId);
      keyIds!.delete(keyId);
    } catch (error) {
      console.error(
        'OpenZCAD could not remove a partly created device key.',
        error
      );
    }
  }
}

/** The `createDeviceKeys` the desktop app uses in place of WebCrypto. */
export function createKeychainDeviceKeys(
  host: KeychainHost = tauriKeychainHost
): () => Promise<DeviceKeyPairs> {
  return async () => {
    await removeLeftoverKeys(host);
    let created: NativeDeviceKeys;
    try {
      created = await host.create();
    } catch (error) {
      if (error instanceof NativeDeviceKeysError && error.keyId !== null) {
        const keyIds = leftoverKeys.get(host) ?? new Set<string>();
        leftoverKeys.set(host, keyIds.add(error.keyId));
        await removeLeftoverKeys(host);
      }
      throw error;
    }
    try {
      return await keyPairs(
        host,
        created.keyId,
        created.signingPublicKey,
        created.unlockPublicKey
      );
    } catch (error) {
      await host.remove(created.keyId).catch(() => undefined);
      throw error;
    }
  };
}

function deviceKeyId(device: DeviceCandidateKeys | null): string | null {
  return device ? keychainKeyId(device.signing.privateKey) : null;
}

/** The device record as IndexedDB can hold it: no native handles. */
function storable(device: StoredDevice): StoredDevice {
  const keyId = deviceKeyId(device);
  if (keyId === null) return device;
  const stored = { keychainKeyId: keyId } as unknown;
  return {
    ...device,
    signing: {
      ...device.signing,
      privateKey: stored as KeychainSigningKey
    },
    unlock: { ...device.unlock, privateKey: stored as KeychainAgreementKey }
  };
}

function revived(
  host: KeychainHost,
  device: StoredDevice | null
): StoredDevice | null {
  const keyId = deviceKeyId(device);
  if (!device || keyId === null) return device;
  return {
    ...device,
    signing: { ...device.signing, privateKey: signingHandle(host, keyId) },
    unlock: { ...device.unlock, privateKey: agreementHandle(host, keyId) }
  };
}

/** Removing an unused Keychain entry is housekeeping; it never fails a flow. */
async function forget(host: KeychainHost, keyId: string | null) {
  if (keyId === null) return;
  try {
    await host.remove(keyId);
  } catch (error) {
    console.error('OpenZCAD could not remove an unused device key.', error);
  }
}

/**
 * A device store whose private keys live in the Keychain. Every write keeps
 * the record and its key id together. A Keychain key is reachable only
 * through a record or a key id held in memory, so whatever a write's outcome
 * (kept, refused by compare-and-swap, a losing setup race, or a rejected
 * IndexedDB transaction), the keys of the device it was handed survive only
 * if the stored record holds them afterwards, and keys the write replaced are
 * removed. Removing unused keys is best effort. Deleting a device removes its
 * keys first and fails, keeping the record, if the Keychain refuses.
 */
export function keychainDeviceStore(
  inner: DeviceKeyStore,
  host: KeychainHost = tauriKeychainHost
): DeviceKeyStore {
  /** Removes the candidate's keys unless the stored record holds them. */
  const discardCandidate = async (candidate: DeviceCandidateKeys) => {
    const keyId = deviceKeyId(candidate);
    if (keyId === null) return;
    let stored: string | null;
    try {
      stored = deviceKeyId(await inner.loadDevice(candidate.userId));
    } catch (error) {
      // Unknown: keeping a stray key is safer than deleting a used one.
      console.error(
        'OpenZCAD could not check whether a device key is in use.',
        error
      );
      return;
    }
    if (stored !== keyId) await forget(host, keyId);
  };
  const settle = async <T>(
    candidate: StoredDevice,
    write: () => Promise<T>
  ) => {
    try {
      return await write();
    } finally {
      await discardCandidate(candidate);
    }
  };
  return {
    loadDevice: async (userId) => revived(host, await inner.loadDevice(userId)),
    saveDevice: async (device) => {
      const previous = deviceKeyId(await inner.loadDevice(device.userId));
      await settle(device, () => inner.saveDevice(storable(device)));
      if (previous !== deviceKeyId(device)) await forget(host, previous);
    },
    getOrCreateDevice: async (candidate) =>
      revived(
        host,
        await settle(candidate, () =>
          inner.getOrCreateDevice(storable(candidate))
        )
      )!,
    withDeviceLock: (userId, run) => inner.withDeviceLock(userId, run),
    replaceDeviceIfCurrent: async (expected, candidate) => {
      const replaced = await settle(candidate, () =>
        inner.replaceDeviceIfCurrent(
          expected && storable(expected),
          storable(candidate)
        )
      );
      const previous = deviceKeyId(expected);
      if (replaced && previous !== deviceKeyId(candidate))
        await forget(host, previous);
      return replaced;
    },
    deleteDevice: async (userId) => {
      // An explicit removal: the keys go first, and a Keychain failure
      // rejects with the record kept, so the caller can retry. Deleting the
      // record first would lose the only key id while the keys remain.
      const previous = deviceKeyId(await inner.loadDevice(userId));
      if (previous !== null) await host.remove(previous);
      await inner.deleteDevice(userId);
    },
    discardCandidate,
    clearApprovalIfCurrent: (userId, approvalId) =>
      inner.clearApprovalIfCurrent(userId, approvalId),
    loadPin: (userId) => inner.loadPin(userId),
    savePin: (userId, list, options) => inner.savePin(userId, list, options),
    forgetErasedIdentity: (userId, expected) =>
      inner.forgetErasedIdentity(userId, expected)
  };
}

/** This app's device store: the Keychain on desktop, IndexedDB in browsers. */
export function deviceKeyStore(): DeviceKeyStore {
  return isDesktopApp()
    ? keychainDeviceStore(indexedDbDeviceStore())
    : indexedDbDeviceStore();
}

/** This app's key factory: native on desktop, WebCrypto's default otherwise. */
export function deviceKeyFactory():
  (() => Promise<DeviceKeyPairs>) | undefined {
  return isDesktopApp() ? createKeychainDeviceKeys() : undefined;
}
