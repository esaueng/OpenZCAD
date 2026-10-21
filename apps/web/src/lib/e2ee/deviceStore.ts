import type {
  Bytes,
  DeviceListPin,
  VerifiedDeviceList
} from '@openzcad/crypto';

/**
 * This device's key material for one account, and the device-list pin.
 *
 * The private halves are non-extractable `CryptoKey`s: IndexedDB stores them
 * by structured clone, and script can never read their bytes (ADR-024,
 * Unlock and devices). The desktop app will keep them in the macOS Keychain
 * instead; `DeviceKeyStore` is the seam for that (a follow-up).
 */
export interface StoredDevice {
  readonly userId: string;
  readonly deviceId: string;
  readonly label: string;
  /** ECDSA P-256; signs versions once certified. */
  readonly signing: CryptoKeyPair;
  /** ECDH P-256; the account key is sealed to its public half. */
  readonly unlock: CryptoKeyPair;
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

export interface DeviceKeyStore {
  loadDevice(userId: string): Promise<StoredDevice | null>;
  saveDevice(device: StoredDevice): Promise<void>;
  /** Keep the existing private keys when setup races or a response is lost. */
  getOrCreateDevice(candidate: StoredDevice): Promise<StoredDevice>;
  deleteDevice(userId: string): Promise<void>;
  /** The newest device-list entry this browser accepted for the account. */
  loadPin(userId: string): Promise<DeviceListPin | null>;
  /** Atomically accept only a verified descendant of the currently stored pin. */
  savePin(
    userId: string,
    list: VerifiedDeviceList,
    options?: PinUpdateOptions
  ): Promise<void>;
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
  const pins = new Map<string, DeviceListPin>();
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
    deleteDevice: async (userId) => {
      devices.delete(userId);
    },
    loadPin: async (userId) => {
      const pin = pins.get(userId);
      return pin ? copyPin(pin) : null;
    },
    savePin: async (userId, list, options = {}) => {
      const next = pinUpdate(userId, list, options);
      checkPinUpdate(pins.get(userId) ?? null, next);
      pins.set(userId, next.pin);
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
    deleteDevice: async (userId) => {
      await inStore(DEVICES, 'readwrite', (s) => s.delete(userId));
    },
    loadPin: async (userId) =>
      ((await inStore(PINS, 'readonly', (s) => s.get(userId))) as
        DeviceListPin | undefined) ?? null,
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
            checkPinUpdate(
              (read.result as DeviceListPin | undefined) ?? null,
              next
            );
            objects.put(next.pin, userId);
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
