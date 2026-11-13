import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_PROJECT_PIN_PREFIX,
  localStorageEncryptedProjectPins
} from './encryptedProjectPins';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    }
  };
}

describe('encrypted project pins', () => {
  it('keeps a pin across a reload until it is forgotten', () => {
    const storage = memoryStorage();
    localStorageEncryptedProjectPins(storage).pin('proj_a');

    const reloaded = localStorageEncryptedProjectPins(storage);
    expect(reloaded.degraded).toBe(false);
    expect(reloaded.has('proj_a')).toBe(true);
    expect(reloaded.has('proj_b')).toBe(false);

    reloaded.forget('proj_a');
    expect(reloaded.has('proj_a')).toBe(false);
    expect(localStorageEncryptedProjectPins(storage).has('proj_a')).toBe(false);
  });

  it('keeps both tabs’ pins when they pin at the same time', () => {
    const storage = memoryStorage();
    const first = localStorageEncryptedProjectPins(storage);
    const second = localStorageEncryptedProjectPins(storage);
    first.pin('proj_first');
    second.pin('proj_second');

    const reloaded = localStorageEncryptedProjectPins(storage);
    expect(reloaded.has('proj_first')).toBe(true);
    expect(reloaded.has('proj_second')).toBe(true);
    // Each tab also sees the other's pin without a reload.
    expect(first.has('proj_second')).toBe(true);
  });

  it('never drops a pin however many others are added', () => {
    const storage = memoryStorage();
    localStorageEncryptedProjectPins(storage).pin('proj_target');
    const pins = localStorageEncryptedProjectPins(storage);
    for (let i = 0; i < 25_000; i += 1) pins.pin(`proj_${i}`);
    expect(localStorageEncryptedProjectPins(storage).has('proj_target')).toBe(
      true
    );
  });

  it('treats any stored value as a pin and ignores invalid ids', () => {
    const storage = memoryStorage();
    storage.setItem(`${ENCRYPTED_PROJECT_PIN_PREFIX}proj_odd`, '{not json');
    const pins = localStorageEncryptedProjectPins(storage);
    expect(pins.has('proj_odd')).toBe(true);
    pins.pin('');
    pins.pin('has space');
    expect(pins.has('')).toBe(false);
    expect(pins.has('has space')).toBe(false);
  });

  it('holds every project as encrypted when storage is blocked', () => {
    const blocked = localStorageEncryptedProjectPins(null);
    expect(blocked.degraded).toBe(true);
    expect(blocked.has('proj_never_seen')).toBe(true);
  });

  it('holds every project as encrypted when storage cannot be read', () => {
    const storage = memoryStorage();
    const pins = localStorageEncryptedProjectPins({
      ...storage,
      getItem: () => {
        throw new Error('SecurityError');
      }
    });
    expect(pins.has('proj_never_seen')).toBe(true);
    expect(pins.degraded).toBe(true);
  });

  it('holds every project as encrypted when storage refuses writes', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined
    };
    const pins = localStorageEncryptedProjectPins(refusing);
    expect(pins.degraded).toBe(true);
    expect(pins.has('proj_other')).toBe(true);
  });

  it('degrades when a pin cannot be saved after the page loaded', () => {
    const storage = memoryStorage();
    let full = false;
    const pins = localStorageEncryptedProjectPins({
      ...storage,
      setItem: (key: string, value: string) => {
        if (full) throw new Error('QuotaExceededError');
        storage.setItem(key, value);
      }
    });
    expect(pins.degraded).toBe(false);
    expect(pins.has('proj_plain')).toBe(false);

    full = true;
    pins.pin('proj_unsaved');
    expect(pins.degraded).toBe(true);
    expect(pins.has('proj_unsaved')).toBe(true);
    expect(pins.has('proj_plain')).toBe(true);
  });
});
