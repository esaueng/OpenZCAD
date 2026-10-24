import type {
  AgreementPrivateKey,
  Bytes,
  DeviceListPin,
  SigningPrivateKey,
  VerifiedDeviceList
} from '@openzcad/crypto';

/**
 * This device's key material for one account, and the device-list pin.
 *
 * The private halves are non-extractable `CryptoKey`s: IndexedDB stores them
 * by structured clone, and script can never read their bytes (ADR-024,
 * Unlock and devices). The desktop app keeps them in the macOS Keychain
 * instead and signs and derives natively; there the private halves are
 * external keys (`keychainDeviceKeys.ts`).
 */
export interface DeviceSigningKeys {
  readonly privateKey: SigningPrivateKey;
  readonly publicKey: CryptoKey;
}

export interface DeviceUnlockKeys {
  readonly privateKey: AgreementPrivateKey;
  readonly publicKey: CryptoKey;
}

export interface StoredDevice {
  readonly userId: string;
  readonly deviceId: string;
  readonly label: string;
  /** ECDSA P-256; signs versions once certified. */
  readonly signing: DeviceSigningKeys;
  /** ECDH P-256; the account key is sealed to its public half. */
  readonly unlock: DeviceUnlockKeys;
  readonly signingPublicKey: Bytes;
  readonly unlockPublicKey: Bytes;
  readonly createdAt: number;
  /** An approval request this device is waiting on, and its secret nonce. */
  readonly approval: {
    readonly id: string;
    readonly nonce: Bytes | null;
    /** Pin when this approval was requested; anchors an identity change. */
    readonly pinAtRequest?: DeviceListPin | null;
    /**
     * The approver key whose six digits the user confirmed on this device.
     * In the compare form a grant is accepted only from that key, so a
     * server answering in the approver's place gains nothing.
     */
    readonly confirmedApproverKey?: string | null;
  } | null;
}

/** The parts of a device record that hold its private keys. */
export type DeviceCandidateKeys = Pick<
  StoredDevice,
  'userId' | 'signing' | 'unlock'
>;

export interface DeviceKeyStore {
  loadDevice(userId: string): Promise<StoredDevice | null>;
  saveDevice(device: StoredDevice): Promise<void>;
  /** Keep the existing private keys when setup races or a response is lost. */
  getOrCreateDevice(candidate: StoredDevice): Promise<StoredDevice>;
  /** Serialize setup, enrollment, approval and teardown through their server boundary. */
  withDeviceLock<T>(userId: string, run: () => Promise<T>): Promise<T>;
  /** Refuse to overwrite keys or approval state changed by another context. */
  replaceDeviceIfCurrent(
    expected: StoredDevice | null,
    candidate: StoredDevice
  ): Promise<boolean>;
  deleteDevice(userId: string): Promise<void>;
  /**
   * Discard the keys of a device candidate the store was never handed (a
   * setup, enrollment or approval abandoned before it saved the device).
   * Non-extractable WebCrypto keys need nothing; native keys are removed
   * unless the stored record holds them. Never fails the flow.
   */
  discardCandidate(candidate: DeviceCandidateKeys): Promise<void>;
  /** Clear only the canceled request, preserving a newer request or device. */
  clearApprovalIfCurrent(userId: string, approvalId: string): Promise<void>;
  /** The newest device-list entry this browser accepted for the account. */
  loadPin(userId: string): Promise<DeviceListPin | null>;
  /** Atomically accept only a verified descendant of the currently stored pin. */
  savePin(
    userId: string,
    list: VerifiedDeviceList,
    options?: PinUpdateOptions
  ): Promise<void>;
  /** Retire only the identity captured before a confirmed account erasure. */
  forgetErasedIdentity(
    userId: string,
    expected: DeviceListPin | null
  ): Promise<void>;
}

interface StoredPin {
  pin: DeviceListPin | null;
  /** Prevent an in-flight old response from restoring deliberately erased trust. */
  erasedIdentities: Uint8Array[];
}

function storedPin(value?: StoredPin | DeviceListPin): StoredPin {
  return value && 'pin' in value
    ? value
    : { pin: value ?? null, erasedIdentities: [] };
}

function retireIdentity(
  current: StoredPin,
  expected: DeviceListPin | null
): StoredPin {
  if (!expected) return current;
  const erasedIdentities = current.erasedIdentities.map(
    (hash) => new Uint8Array(hash)
  );
  if (
    !erasedIdentities.some((hash) => sameBytes(hash, expected.identityKeyHash))
  )
    erasedIdentities.push(new Uint8Array(expected.identityKeyHash));
  return {
    pin:
      current.pin &&
      sameBytes(current.pin.identityKeyHash, expected.identityKeyHash)
        ? null
        : current.pin,
    erasedIdentities
  };
}

function acceptPin(
  current: StoredPin,
  next: ReturnType<typeof pinUpdate>
): StoredPin {
  if (
    current.erasedIdentities.some((hash) =>
      sameBytes(hash, next.pin.identityKeyHash)
    )
  )
    throw new DeviceListPinConflict('identity');
  checkPinUpdate(current.pin, next);
  return { pin: next.pin, erasedIdentities: current.erasedIdentities };
}

export interface PinUpdateOptions {
  /**
   * An identity change authorized by recovery/setup or a verified approval
   * grant. It may replace only this exact persistence snapshot. Undefined
   * never authorizes replacement; null means the browser had no pin.
   */
  readonly replaceIdentityFrom?: DeviceListPin | null;
}

export class DeviceListPinConflict extends Error {
  constructor(readonly reason: 'identity' | 'chain') {
    super(
      'The pinned device list changed in another tab. Reload and try again.'
    );
    this.name = 'DeviceListPinConflict';
  }
}

function copyPin(pin: DeviceListPin): DeviceListPin {
  return {
    sequence: pin.sequence,
    identityKeyHash: new Uint8Array(pin.identityKeyHash),
    entryHash: new Uint8Array(pin.entryHash)
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const samePin = (a: DeviceListPin | null, b: DeviceListPin | null) =>
  a === null || b === null
    ? a === b
    : a.sequence === b.sequence &&
      sameBytes(a.identityKeyHash, b.identityKeyHash) &&
      sameBytes(a.entryHash, b.entryHash);

function sameDeviceState(
  a: StoredDevice | null,
  b: StoredDevice | null
): boolean {
  if (!a || !b) return a === b;
  if (
    a.userId !== b.userId ||
    a.deviceId !== b.deviceId ||
    a.label !== b.label ||
    a.createdAt !== b.createdAt ||
    !sameBytes(a.signingPublicKey, b.signingPublicKey) ||
    !sameBytes(a.unlockPublicKey, b.unlockPublicKey)
  )
    return false;
  if (!a.approval || !b.approval) return a.approval === b.approval;
  return (
    a.approval.id === b.approval.id &&
    a.approval.confirmedApproverKey === b.approval.confirmedApproverKey &&
    (a.approval.nonce === null || b.approval.nonce === null
      ? a.approval.nonce === b.approval.nonce
      : sameBytes(a.approval.nonce, b.approval.nonce)) &&
    samePin(a.approval.pinAtRequest ?? null, b.approval.pinAtRequest ?? null)
  );
}

function pinUpdate(
  userId: string,
  list: VerifiedDeviceList,
  options: PinUpdateOptions
) {
  if (list.userId !== userId) throw new DeviceListPinConflict('chain');
  // Snapshot before the first await. Neither a caller nor a memory-store
  // reader may mutate bytes that the acceptance decision later relies on.
  return {
    pin: copyPin(list.pin),
    hashes: list.entries.map((entry) => new Uint8Array(entry.hash)),
    replaceIdentityFrom:
      options.replaceIdentityFrom === undefined
        ? undefined
        : options.replaceIdentityFrom === null
          ? null
          : copyPin(options.replaceIdentityFrom)
  };
}

function checkPinUpdate(
  current: DeviceListPin | null,
  next: ReturnType<typeof pinUpdate>
): void {
  if (current && sameBytes(current.identityKeyHash, next.pin.identityKeyHash)) {
    const ancestor = next.hashes[current.sequence];
    if (!ancestor || !sameBytes(ancestor, current.entryHash)) {
      throw new DeviceListPinConflict('chain');
    }
  } else if (current || next.replaceIdentityFrom !== undefined) {
    if (
      next.replaceIdentityFrom === undefined ||
      !samePin(current, next.replaceIdentityFrom)
    ) {
      throw new DeviceListPinConflict('identity');
    }
  }
}

export function memoryDeviceStore(): DeviceKeyStore {
  const devices = new Map<string, StoredDevice>();
  const pins = new Map<string, StoredPin>();
  const locks = new Map<string, Promise<void>>();
  return {
    loadDevice: async (userId) => devices.get(userId) ?? null,
    saveDevice: async (device) => {
      devices.set(device.userId, device);
    },
    getOrCreateDevice: async (candidate) => {
      const existing = devices.get(candidate.userId);
      if (existing) return existing;
      devices.set(candidate.userId, candidate);
      return candidate;
    },
    withDeviceLock: (userId, run) => {
      const active = (locks.get(userId) ?? Promise.resolve()).then(run);
      const settled = active.then(
        () => {},
        () => {}
      );
      locks.set(userId, settled);
      return active.finally(() => {
        if (locks.get(userId) === settled) locks.delete(userId);
      });
    },
    replaceDeviceIfCurrent: async (expected, candidate) => {
      if (!sameDeviceState(devices.get(candidate.userId) ?? null, expected))
        return false;
      devices.set(candidate.userId, candidate);
      return true;
    },
    deleteDevice: async (userId) => {
      devices.delete(userId);
    },
    discardCandidate: async () => {},
    clearApprovalIfCurrent: async (userId, approvalId) => {
      const device = devices.get(userId);
      if (device?.approval?.id === approvalId)
        devices.set(userId, { ...device, approval: null });
    },
    loadPin: async (userId) => {
      const pin = pins.get(userId)?.pin;
      return pin ? copyPin(pin) : null;
    },
    savePin: async (userId, list, options = {}) => {
      const next = pinUpdate(userId, list, options);
      pins.set(userId, acceptPin(storedPin(pins.get(userId)), next));
    },
    forgetErasedIdentity: async (userId, expected) => {
      pins.set(userId, retireIdentity(storedPin(pins.get(userId)), expected));
    }
  };
}

export const E2EE_DATABASE = 'openzcad-e2ee';
const DEVICES = 'devices';
const PINS = 'pins';

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

let opening: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(E2EE_DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICES)) {
        db.createObjectStore(DEVICES, { keyPath: 'userId' });
      }
      if (!db.objectStoreNames.contains(PINS)) {
        db.createObjectStore(PINS);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading must not be blocked by this one.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error('IndexedDB did not open'));
    };
  });
  return opening;
}

async function inStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (objects: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDatabase();
  const transaction = db.transaction(store, mode);
  const result = promised(run(transaction.objectStore(store)));
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    const failed = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onerror = failed;
    transaction.onabort = failed;
  });
  return result;
}

export function indexedDbDeviceStore(): DeviceKeyStore {
  return {
    loadDevice: async (userId) =>
      ((await inStore(DEVICES, 'readonly', (s) => s.get(userId))) as
        StoredDevice | undefined) ?? null,
    saveDevice: async (device) => {
      await inStore(DEVICES, 'readwrite', (s) => s.put(device));
    },
    getOrCreateDevice: async (candidate) => {
      const db = await openDatabase();
      return new Promise<StoredDevice>((resolve, reject) => {
        const tx = db.transaction(DEVICES, 'readwrite');
        const objects = tx.objectStore(DEVICES);
        let device: StoredDevice;
        tx.oncomplete = () => resolve(device);
        tx.onabort = tx.onerror = () =>
          reject(tx.error ?? new Error('IndexedDB device transaction failed'));
        const read = objects.get(candidate.userId);
        read.onsuccess = () => {
          device = (read.result as StoredDevice | undefined) ?? candidate;
          if (!read.result) objects.add(device);
        };
      });
    },
    withDeviceLock: async (userId, run) => {
      if (typeof navigator === 'undefined' || !navigator.locks)
        throw new Error(
          'This browser cannot safely coordinate device approvals.'
        );
      return navigator.locks.request(
        `openzcad-e2ee-device:${userId}`,
        { mode: 'exclusive' },
        async () => run()
      );
    },
    replaceDeviceIfCurrent: async (expected, candidate) => {
      const snapshot = expected ? structuredClone(expected) : null;
      const value = structuredClone(candidate);
      const db = await openDatabase();
      return new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(DEVICES, 'readwrite');
        const objects = tx.objectStore(DEVICES);
        let replaced = false;
        tx.oncomplete = () => resolve(replaced);
        tx.onabort = tx.onerror = () =>
          reject(tx.error ?? new Error('IndexedDB device update failed'));
        const read = objects.get(value.userId);
        read.onsuccess = () => {
          if (
            sameDeviceState(
              (read.result as StoredDevice | undefined) ?? null,
              snapshot
            )
          ) {
            objects.put(value);
            replaced = true;
          }
        };
      });
    },
    deleteDevice: async (userId) => {
      await inStore(DEVICES, 'readwrite', (s) => s.delete(userId));
    },
    discardCandidate: async () => {},
    clearApprovalIfCurrent: async (userId, approvalId) => {
      const db = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DEVICES, 'readwrite');
        const objects = tx.objectStore(DEVICES);
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () =>
          reject(tx.error ?? new Error('IndexedDB approval update failed'));
        const read = objects.get(userId);
        read.onsuccess = () => {
          const device = read.result as StoredDevice | undefined;
          if (device?.approval?.id === approvalId)
            objects.put({ ...device, approval: null });
        };
      });
    },
    loadPin: async (userId) => {
      const value: unknown = await inStore(PINS, 'readonly', (s) =>
        s.get(userId)
      );
      const pin = storedPin(value as StoredPin | DeviceListPin | undefined).pin;
      return pin ? copyPin(pin) : null;
    },
    forgetErasedIdentity: async (userId, expected) => {
      const snapshot = expected ? copyPin(expected) : null;
      const db = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PINS, 'readwrite');
        const objects = tx.objectStore(PINS);
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () =>
          reject(tx.error ?? new Error('IndexedDB pin erasure failed'));
        const read = objects.get(userId);
        read.onsuccess = () =>
          objects.put(
            retireIdentity(
              storedPin(read.result as StoredPin | DeviceListPin | undefined),
              snapshot
            ),
            userId
          );
      });
    },
    savePin: async (userId, list, options = {}) => {
      const next = pinUpdate(userId, list, options);
      const db = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PINS, 'readwrite');
        const objects = tx.objectStore(PINS);
        let conflict: Error | undefined;
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () =>
          reject(
            conflict ??
              tx.error ??
              new Error('IndexedDB pin transaction failed')
          );
        const read = objects.get(userId);
        read.onsuccess = () => {
          try {
            // IndexedDB serializes readwrite transactions across connections
            // and tabs. Check the actual pin and write in this one transaction;
            // crypto verification has already finished outside it.
            objects.put(
              acceptPin(
                storedPin(read.result as StoredPin | DeviceListPin | undefined),
                next
              ),
              userId
            );
          } catch (error) {
            conflict =
              error instanceof Error
                ? error
                : new Error('Invalid device-list pin update');
            tx.abort();
          }
        };
      });
    }
  };
}

/**
 * Whether this browser holds device keys for the account, without opening
 * (and so creating) the database when it has never been used.
 */
export async function hasStoredDevice(userId: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  if (typeof indexedDB.databases === 'function') {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === E2EE_DATABASE)) {
      return false;
    }
  }
  return (await indexedDbDeviceStore().loadDevice(userId)) !== null;
}
