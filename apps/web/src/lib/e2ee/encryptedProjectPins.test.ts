import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_PROJECT_PIN_PREFIX,
  ENCRYPTED_PROJECT_PIN_FAILED_KEY,
  ENCRYPTED_PROJECT_PIN_RESERVE_KEY,
  ENCRYPTED_PROJECT_PINS_RESET_KEY,
  ENCRYPTED_PROJECT_RESET_PREFIX,
  ENCRYPTED_PROJECT_UNRESOLVED_PREFIX,
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

  it('stays degraded in other tabs and after a reload once a pin could not be saved', () => {
    const storage = memoryStorage();
    // Full storage: nothing larger fits, but removing the reserve frees
    // room for the failure key.
    let full = false;
    const nearlyFull = {
      ...storage,
      setItem: (key: string, value: string) => {
        if (full && storage.values.has(ENCRYPTED_PROJECT_PIN_RESERVE_KEY)) {
          throw new Error('QuotaExceededError');
        }
        if (full && key.startsWith(ENCRYPTED_PROJECT_PIN_PREFIX)) {
          throw new Error('QuotaExceededError');
        }
        storage.setItem(key, value);
      }
    };
    const pins = localStorageEncryptedProjectPins(nearlyFull);
    const otherTab = localStorageEncryptedProjectPins(nearlyFull);
    expect(storage.values.has(ENCRYPTED_PROJECT_PIN_RESERVE_KEY)).toBe(true);
    expect(pins.degraded).toBe(false);
    expect(pins.has('proj_plain')).toBe(false);

    full = true;
    expect(pins.pin('proj_unsaved')).toBe(false);
    expect(storage.values.has(ENCRYPTED_PROJECT_PIN_FAILED_KEY)).toBe(true);
    expect(pins.degraded).toBe(true);
    expect(pins.has('proj_unsaved')).toBe(true);
    expect(pins.has('proj_plain')).toBe(true);
    expect(otherTab.has('proj_unsaved')).toBe(true);

    full = false;
    const reloaded = localStorageEncryptedProjectPins(nearlyFull);
    expect(reloaded.degraded).toBe(true);
    expect(reloaded.has('proj_unsaved')).toBe(true);
    // A degraded store saves no new pins: it cannot tell which are real.
    expect(reloaded.pinDurably('proj_plain')).toBe(false);
  });

  it('never clears the failure key when another tab starts up', () => {
    const storage = memoryStorage();
    const starting = localStorageEncryptedProjectPins(storage);
    storage.setItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY, '1');
    storage.removeItem(ENCRYPTED_PROJECT_PIN_RESERVE_KEY);
    const late = localStorageEncryptedProjectPins(storage);
    expect(storage.values.has(ENCRYPTED_PROJECT_PIN_FAILED_KEY)).toBe(true);
    expect(late.degraded).toBe(true);
    expect(starting.degraded).toBe(true);
  });

  it('reports a pin as unsaved when storage refuses every write', () => {
    const storage = memoryStorage();
    let refusing = false;
    const pins = localStorageEncryptedProjectPins({
      ...storage,
      setItem: (key: string, value: string) => {
        if (refusing) throw new Error('SecurityError');
        storage.setItem(key, value);
      }
    });
    expect(pins.pinDurably('proj_saved')).toBe(true);
    refusing = true;
    expect(pins.pinDurably('proj_new')).toBe(false);
    // Neither the pin nor the failure key could be saved; the pin saved
    // earlier still counts.
    expect(storage.values.has(ENCRYPTED_PROJECT_PIN_FAILED_KEY)).toBe(false);
    expect(pins.pinDurably('proj_saved')).toBe(true);
  });

  it('keeps an unresolved cutover across a reload until this device sees it done', () => {
    const storage = memoryStorage();
    const pins = localStorageEncryptedProjectPins(storage);
    expect(pins.markCutoverUnresolved('proj_switching')).toBe(true);
    expect(
      storage.values.has(ENCRYPTED_PROJECT_UNRESOLVED_PREFIX + 'proj_switching')
    ).toBe(true);
    // Its own key beside the pin: no shared list is read and rewritten.
    expect(
      storage.values.has(ENCRYPTED_PROJECT_PIN_PREFIX + 'proj_switching')
    ).toBe(false);

    const reloaded = localStorageEncryptedProjectPins(storage);
    expect(reloaded.cutoverUnresolved('proj_switching')).toBe(true);
    expect(reloaded.cutoverUnresolved('proj_other')).toBe(false);
    reloaded.resolveCutover('proj_switching');
    expect(
      localStorageEncryptedProjectPins(storage).cutoverUnresolved(
        'proj_switching'
      )
    ).toBe(false);
  });

  it('degrades when an unresolved cutover cannot be saved', () => {
    const storage = memoryStorage();
    let refusing = false;
    const pins = localStorageEncryptedProjectPins({
      ...storage,
      setItem: (key: string, value: string) => {
        if (refusing && key.startsWith(ENCRYPTED_PROJECT_UNRESOLVED_PREFIX)) {
          throw new Error('QuotaExceededError');
        }
        storage.setItem(key, value);
      }
    });
    refusing = true;
    expect(pins.markCutoverUnresolved('proj_switching')).toBe(false);
    expect(pins.degraded).toBe(true);
    expect(storage.values.has(ENCRYPTED_PROJECT_PIN_FAILED_KEY)).toBe(true);
    // This page still knows it.
    expect(pins.cutoverUnresolved('proj_switching')).toBe(true);
  });

  it('resets one project: its pin and its unresolved cutover', () => {
    const storage = memoryStorage();
    const pins = localStorageEncryptedProjectPins(storage);
    pins.pin('proj_stuck');
    pins.markCutoverUnresolved('proj_stuck');
    pins.pin('proj_kept');
    pins.resetProject('proj_stuck');
    const reloaded = localStorageEncryptedProjectPins(storage);
    expect(reloaded.has('proj_stuck')).toBe(false);
    expect(reloaded.cutoverUnresolved('proj_stuck')).toBe(false);
    expect(reloaded.has('proj_kept')).toBe(true);
  });

  it('resets a degraded store without dropping a saved pin', () => {
    const storage = memoryStorage();
    let full = false;
    const nearlyFull = {
      ...storage,
      setItem: (key: string, value: string) => {
        if (full && key.startsWith(ENCRYPTED_PROJECT_PIN_PREFIX)) {
          throw new Error('QuotaExceededError');
        }
        storage.setItem(key, value);
      }
    };
    const pins = localStorageEncryptedProjectPins(nearlyFull);
    pins.pin('proj_saved');
    full = true;
    expect(pins.pin('proj_lost')).toBe(false);
    expect(pins.degraded).toBe(true);
    expect(storage.values.has(ENCRYPTED_PROJECT_PIN_RESERVE_KEY)).toBe(false);

    full = false;
    const reloaded = localStorageEncryptedProjectPins(nearlyFull);
    expect(reloaded.degraded).toBe(true);
    expect(reloaded.resetDegraded()).toBe(true);
    expect(reloaded.degraded).toBe(false);
    expect(storage.values.has(ENCRYPTED_PROJECT_PIN_FAILED_KEY)).toBe(false);
    // Reserved again, so a later failure still finds room to be recorded.
    expect(storage.values.has(ENCRYPTED_PROJECT_PIN_RESERVE_KEY)).toBe(true);
    expect(reloaded.has('proj_saved')).toBe(true);
    // The pin that was never saved is gone: the next listing decides.
    expect(reloaded.has('proj_lost')).toBe(false);
    expect(reloaded.pinDurably('proj_lost')).toBe(true);
    expect(localStorageEncryptedProjectPins(storage).degraded).toBe(false);
  });

  it('stays degraded when the reset finds storage still refusing', () => {
    const storage = memoryStorage();
    storage.setItem(ENCRYPTED_PROJECT_PIN_PREFIX + 'proj_saved', '1');
    storage.setItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY, '1');
    const pins = localStorageEncryptedProjectPins({
      ...storage,
      setItem: () => {
        throw new Error('QuotaExceededError');
      }
    });
    expect(pins.degraded).toBe(true);
    // The failure key goes, but the reserve cannot be saved again.
    expect(pins.resetDegraded()).toBe(false);
    expect(pins.degraded).toBe(true);
    expect(pins.has('proj_saved')).toBe(true);
    expect(localStorageEncryptedProjectPins(null).resetDegraded()).toBe(false);
  });

  describe('resets made in another tab', () => {
    it('keeps a tab that opened with a saved pin encrypted and stops it once another tab resets it', () => {
      const storage = memoryStorage();
      localStorageEncryptedProjectPins(storage).pin('proj_open');
      // A tab opened later, with the pin already saved.
      const editor = localStorageEncryptedProjectPins(storage);
      expect(editor.has('proj_open')).toBe(true);
      expect(editor.resetElsewhere('proj_open')).toBe(false);

      localStorageEncryptedProjectPins(storage).resetProject('proj_open');
      expect(
        storage.values.has(ENCRYPTED_PROJECT_RESET_PREFIX + 'proj_open')
      ).toBe(true);

      // Still encrypted here, never plaintext, and reported for a reload.
      expect(editor.has('proj_open')).toBe(true);
      expect(editor.resetElsewhere('proj_open')).toBe(true);
      expect(editor.staleTab).toBe(true);
      // Nothing is pinned again from this tab.
      expect(editor.pinDurably('proj_open')).toBe(false);
      expect(
        storage.values.has(ENCRYPTED_PROJECT_PIN_PREFIX + 'proj_open')
      ).toBe(false);
      // Other projects are unaffected.
      expect(editor.resetElsewhere('proj_other')).toBe(false);
      expect(editor.pin('proj_other')).toBe(true);
    });

    it('never recreates a pin another tab reset, from a pin it made itself', () => {
      const storage = memoryStorage();
      const shelf = localStorageEncryptedProjectPins(storage);
      // Pinned from this tab's listing.
      expect(shelf.pin('proj_listed')).toBe(true);
      localStorageEncryptedProjectPins(storage).resetProject('proj_listed');

      expect(shelf.pinDurably('proj_listed')).toBe(false);
      expect(shelf.pin('proj_listed')).toBe(false);
      expect(shelf.markCutoverUnresolved('proj_listed')).toBe(false);
      expect(
        storage.values.has(ENCRYPTED_PROJECT_PIN_PREFIX + 'proj_listed')
      ).toBe(false);
      expect(shelf.has('proj_listed')).toBe(true);
      expect(shelf.resetElsewhere('proj_listed')).toBe(true);
      // Not a pin failure: nothing degrades.
      expect(shelf.degraded).toBe(false);

      // A reload starts from what storage holds: the next listing decides.
      const reloaded = localStorageEncryptedProjectPins(storage);
      expect(reloaded.resetElsewhere('proj_listed')).toBe(false);
      expect(reloaded.has('proj_listed')).toBe(false);
      expect(reloaded.pin('proj_listed')).toBe(true);
    });

    it('holds a seen pin even when its key goes without a reset', () => {
      const storage = memoryStorage();
      const tab = localStorageEncryptedProjectPins(storage);
      storage.setItem(ENCRYPTED_PROJECT_PIN_PREFIX + 'proj_seen', '1');
      expect(tab.has('proj_seen')).toBe(true);
      storage.values.delete(ENCRYPTED_PROJECT_PIN_PREFIX + 'proj_seen');
      expect(tab.has('proj_seen')).toBe(true);
    });

    it('treats this device’s decrypt run in another tab as a reset there', () => {
      const storage = memoryStorage();
      const editor = localStorageEncryptedProjectPins(storage);
      editor.pin('proj_decrypted');
      localStorageEncryptedProjectPins(storage).forget('proj_decrypted');
      expect(editor.resetElsewhere('proj_decrypted')).toBe(true);
      expect(editor.has('proj_decrypted')).toBe(true);
    });

    it('is not stale in the tab that made the reset', () => {
      const storage = memoryStorage();
      const tab = localStorageEncryptedProjectPins(storage);
      tab.pin('proj_mine');
      tab.markCutoverUnresolved('proj_mine');
      tab.resetProject('proj_mine');
      expect(tab.resetElsewhere('proj_mine')).toBe(false);
      expect(tab.staleTab).toBe(false);
      expect(tab.has('proj_mine')).toBe(false);
      expect(tab.cutoverUnresolved('proj_mine')).toBe(false);
      expect(tab.pin('proj_mine')).toBe(true);
    });

    it('stops every project in other tabs when the store is reset', () => {
      const storage = memoryStorage();
      storage.setItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY, '1');
      const other = localStorageEncryptedProjectPins(storage);
      const resetting = localStorageEncryptedProjectPins(storage);
      expect(other.degraded).toBe(true);
      expect(resetting.resetDegraded()).toBe(true);
      expect(storage.values.has(ENCRYPTED_PROJECT_PINS_RESET_KEY)).toBe(true);

      expect(resetting.staleTab).toBe(false);
      expect(resetting.resetElsewhere('proj_any')).toBe(false);
      expect(other.staleTab).toBe(true);
      expect(other.resetElsewhere('proj_any')).toBe(true);
      expect(other.has('proj_any')).toBe(true);
      expect(other.pinDurably('proj_any')).toBe(false);
    });

    it('leaves the resetting tab holding what a reload would', () => {
      const storage = memoryStorage();
      let full = false;
      const nearlyFull = {
        ...storage,
        setItem: (key: string, value: string) => {
          if (
            full &&
            (key.startsWith(ENCRYPTED_PROJECT_PIN_PREFIX) ||
              key.startsWith(ENCRYPTED_PROJECT_UNRESOLVED_PREFIX))
          ) {
            throw new Error('QuotaExceededError');
          }
          storage.setItem(key, value);
        }
      };
      const pins = localStorageEncryptedProjectPins(nearlyFull);
      pins.pin('proj_saved');
      full = true;
      expect(pins.pin('proj_unsaved')).toBe(false);
      expect(pins.markCutoverUnresolved('proj_unsaved_switch')).toBe(false);
      full = false;

      expect(pins.resetDegraded()).toBe(true);
      const reloaded = localStorageEncryptedProjectPins(storage);
      for (const projectId of [
        'proj_saved',
        'proj_unsaved',
        'proj_unsaved_switch'
      ]) {
        expect(pins.has(projectId)).toBe(reloaded.has(projectId));
        expect(pins.cutoverUnresolved(projectId)).toBe(
          reloaded.cutoverUnresolved(projectId)
        );
      }
      expect(pins.has('proj_saved')).toBe(true);
      expect(pins.has('proj_unsaved')).toBe(false);
      expect(pins.cutoverUnresolved('proj_unsaved_switch')).toBe(false);
    });
  });
});
