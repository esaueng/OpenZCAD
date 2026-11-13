import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_PROJECT_PINS_KEY,
  MAX_ENCRYPTED_PROJECT_PINS,
  localStorageEncryptedProjectPins
} from './encryptedProjectPins';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    }
  };
}

function storageEvents() {
  const listeners: ((event: { key: string | null }) => void)[] = [];
  return {
    addEventListener: (
      _type: 'storage',
      listener: (event: { key: string | null }) => void
    ) => {
      listeners.push(listener);
    },
    fire: (key: string | null) => {
      for (const listener of listeners) listener({ key });
    }
  };
}

describe('encrypted project pins', () => {
  it('keeps a pin across a reload until it is forgotten', () => {
    const storage = memoryStorage();
    localStorageEncryptedProjectPins(storage, null).pin('proj_a');

    const reloaded = localStorageEncryptedProjectPins(storage, null);
    expect(reloaded.has('proj_a')).toBe(true);
    expect(reloaded.has('proj_b')).toBe(false);

    reloaded.forget('proj_a');
    expect(reloaded.has('proj_a')).toBe(false);
    expect(localStorageEncryptedProjectPins(storage, null).has('proj_a')).toBe(
      false
    );
  });

  it('learns another tab’s pins without restoring one it forgot', () => {
    const storage = memoryStorage();
    const events = storageEvents();
    const here = localStorageEncryptedProjectPins(storage, events);
    const other = localStorageEncryptedProjectPins(storage, null);
    here.pin('proj_both');

    other.pin('proj_other');
    events.fire(ENCRYPTED_PROJECT_PINS_KEY);
    expect(here.has('proj_other')).toBe(true);

    // The other tab's decrypt run forgets one; this tab's next pin writes
    // storage as it is, not its own mirror.
    other.forget('proj_both');
    here.pin('proj_new');
    expect(
      localStorageEncryptedProjectPins(storage, null).has('proj_both')
    ).toBe(false);
  });

  it('ignores invalid ids and unreadable storage', () => {
    const storage = memoryStorage();
    storage.setItem(
      ENCRYPTED_PROJECT_PINS_KEY,
      JSON.stringify(['proj_ok', 7, '', 'has space'])
    );
    const pins = localStorageEncryptedProjectPins(storage, null);
    expect(pins.has('proj_ok')).toBe(true);
    pins.pin('');
    expect(pins.has('')).toBe(false);

    storage.setItem(ENCRYPTED_PROJECT_PINS_KEY, '{not json');
    expect(localStorageEncryptedProjectPins(storage, null).has('proj_ok')).toBe(
      false
    );
  });

  it('still holds a pin in memory when storage refuses writes', () => {
    const pins = localStorageEncryptedProjectPins(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        }
      },
      null
    );
    pins.pin('proj_unsaved');
    expect(pins.has('proj_unsaved')).toBe(true);
    expect(localStorageEncryptedProjectPins(null, null).has('proj_x')).toBe(
      false
    );
  });

  it('keeps the newest pins past the limit', () => {
    const storage = memoryStorage();
    storage.setItem(
      ENCRYPTED_PROJECT_PINS_KEY,
      JSON.stringify(
        Array.from(
          { length: MAX_ENCRYPTED_PROJECT_PINS },
          (_, i) => `proj_${i}`
        )
      )
    );
    localStorageEncryptedProjectPins(storage, null).pin('proj_newest');
    const reloaded = localStorageEncryptedProjectPins(storage, null);
    expect(reloaded.has('proj_newest')).toBe(true);
    expect(reloaded.has('proj_0')).toBe(false);
    expect(reloaded.has('proj_1')).toBe(true);
  });
});
