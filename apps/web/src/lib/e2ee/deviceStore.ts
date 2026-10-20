import type { Bytes, DeviceListPin } from '@openzcad/crypto';

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
  deleteDevice(userId: string): Promise<void>;
  /** The newest device-list entry this browser accepted for the account. */
  loadPin(userId: string): Promise<DeviceListPin | null>;
  savePin(userId: string, pin: DeviceListPin): Promise<void>;
}

export function memoryDeviceStore(): DeviceKeyStore {
  const devices = new Map<string, StoredDevice>();
  const pins = new Map<string, DeviceListPin>();
  return {
    loadDevice: async (userId) => devices.get(userId) ?? null,
    saveDevice: async (device) => {
      devices.set(device.userId, device);
    },
    deleteDevice: async (userId) => {
      devices.delete(userId);
    },
    loadPin: async (userId) => pins.get(userId) ?? null,
    savePin: async (userId, pin) => {
      pins.set(userId, pin);
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
        | StoredDevice
        | undefined) ?? null,
    saveDevice: async (device) => {
      await inStore(DEVICES, 'readwrite', (s) => s.put(device));
    },
    deleteDevice: async (userId) => {
      await inStore(DEVICES, 'readwrite', (s) => s.delete(userId));
    },
    loadPin: async (userId) =>
      ((await inStore(PINS, 'readonly', (s) => s.get(userId))) as
        | DeviceListPin
        | undefined) ?? null,
    savePin: async (userId, pin) => {
      await inStore(PINS, 'readwrite', (s) => s.put(pin, userId));
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
