import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_PROJECT_PIN_PREFIX,
  ENCRYPTED_PROJECT_PIN_FAILED_KEY,
  ENCRYPTED_PROJECT_PIN_RESERVE_KEY,
  ENCRYPTED_PROJECT_PINS_RESET_KEY,
  ENCRYPTED_PROJECT_RESET_PREFIX,
  ENCRYPTED_PROJECT_UNRESOLVED_PREFIX,
  ENCRYPTION_REQUIRED_PREFIX,
  NO_RESET,
  encryptionRequiredKey,
  encryptCutoverUnresolvedKey,
  encryptedProjectPinKey,
  localStorageEncryptedProjectPins,
  type EncryptedProjectPinStore
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

  it('treats a stored value that names no reset generation as a pin and ignores invalid ids', () => {
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
      storage.values.has(encryptCutoverUnresolvedKey('proj_switching'))
    ).toBe(true);
    // Its own key beside the pin: no shared list is read and rewritten.
    expect(storage.values.has(encryptedProjectPinKey('proj_switching'))).toBe(
      false
    );

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

  it('keeps a carried encryption requirement across a reload, apart from the pin', () => {
    const storage = memoryStorage();
    const pins = localStorageEncryptedProjectPins(storage);
    expect(pins.requireEncryption('proj_device_copy')).toBe(true);
    const reloaded = localStorageEncryptedProjectPins(storage);
    expect(reloaded.encryptionRequired('proj_device_copy')).toBe(true);
    // Not a statement of how the account stores it.
    expect(reloaded.has('proj_device_copy')).toBe(false);
    expect(reloaded.encryptionRequired('proj_other')).toBe(false);
    expect([...storage.values.keys()]).toContain(
      encryptionRequiredKey('proj_device_copy', NO_RESET)
    );
  });

  it('drops a requirement only with the owner’s confirmed reset of that project', () => {
    const storage = memoryStorage();
    const pins = localStorageEncryptedProjectPins(storage);
    pins.requireEncryption('proj_required');
    pins.requireEncryption('proj_required_kept');
    pins.resetProject('proj_required');
    const reloaded = localStorageEncryptedProjectPins(storage);
    expect(reloaded.encryptionRequired('proj_required')).toBe(false);
    expect(reloaded.encryptionRequired('proj_required_kept')).toBe(true);
  });

  it('holds a requirement another tab reset elsewhere, and makes none for it', () => {
    const storage = memoryStorage();
    const tab = localStorageEncryptedProjectPins(storage);
    expect(tab.encryptionRequired('proj_reset_race')).toBe(false);
    localStorageEncryptedProjectPins(storage).resetProject('proj_reset_race');
    expect(tab.encryptionRequired('proj_reset_race')).toBe(true);
    expect(tab.requireEncryption('proj_reset_race')).toBe(false);
  });

  it('degrades when a requirement cannot be saved', () => {
    const storage = memoryStorage();
    const pins = localStorageEncryptedProjectPins(storage);
    const setItem = storage.setItem;
    storage.setItem = (key: string, value: string) => {
      if (key.startsWith(ENCRYPTION_REQUIRED_PREFIX)) {
        throw new Error('QuotaExceededError');
      }
      setItem(key, value);
    };
    expect(pins.requireEncryption('proj_unsaved_requirement')).toBe(false);
    expect(pins.degraded).toBe(true);
    // Every project is held as encrypted, here and after a reload.
    expect(localStorageEncryptedProjectPins(storage).degraded).toBe(true);
    expect(pins.encryptionRequired('proj_anything')).toBe(true);
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

    /**
     * A tab whose writes run `interleave` (another tab's step) after its
     * own checks and just before its write lands in storage.
     */
    function interleavedTab(storage: ReturnType<typeof memoryStorage>) {
      const tab = {
        interleave: null as (() => void) | null,
        pins: localStorageEncryptedProjectPins({
          getItem: (key) => storage.getItem(key),
          removeItem: (key) => storage.removeItem(key),
          setItem: (key, value) => {
            const step = tab.interleave;
            tab.interleave = null;
            step?.();
            storage.setItem(key, value);
          }
        })
      };
      return tab;
    }

    it.each([
      [
        'pin',
        encryptedProjectPinKey,
        (pins: EncryptedProjectPinStore) => pins.pin('proj_race')
      ],
      [
        'unresolved record',
        encryptCutoverUnresolvedKey,
        (pins: EncryptedProjectPinStore) =>
          pins.markCutoverUnresolved('proj_race')
      ]
    ])(
      'keeps a reset made between another tab’s check and its %s write',
      (_name, keyOf, write) => {
        const storage = memoryStorage();
        const owner = localStorageEncryptedProjectPins(storage);
        owner.pin('proj_race');
        owner.markCutoverUnresolved('proj_race');
        const other = interleavedTab(storage);
        // The other tab has checked the generation it started with.
        expect(other.pins.has('proj_race')).toBe(true);
        expect(other.pins.resetElsewhere('proj_race')).toBe(false);
        // The owner's confirmed reset lands after that check and before
        // the other tab's write.
        other.interleave = () => owner.resetProject('proj_race');
        expect(write(other.pins)).toBe(false);
        expect(other.interleave).toBeNull();
        // The write landed, under the generation before the reset.
        expect(storage.values.has(keyOf('proj_race', NO_RESET))).toBe(true);

        const fresh = localStorageEncryptedProjectPins(storage);
        expect(fresh.has('proj_race')).toBe(false);
        expect(fresh.cutoverUnresolved('proj_race')).toBe(false);
        expect(fresh.degraded).toBe(false);
        expect(owner.has('proj_race')).toBe(false);
        expect(owner.cutoverUnresolved('proj_race')).toBe(false);
        // The writing tab went stale rather than degrading the store.
        expect(other.pins.resetElsewhere('proj_race')).toBe(true);
        expect(other.pins.degraded).toBe(false);
      }
    );

    it('keeps a reset whichever of the two writes lands last', () => {
      const storage = memoryStorage();
      const owner = localStorageEncryptedProjectPins(storage);
      owner.pin('proj_order');
      owner.markCutoverUnresolved('proj_order');
      const other = localStorageEncryptedProjectPins(storage);
      expect(other.has('proj_order')).toBe(true);
      const pinKey = encryptedProjectPinKey('proj_order');
      const recordKey = encryptCutoverUnresolvedKey('proj_order');
      const stalePin = storage.getItem(pinKey);
      const staleRecord = storage.getItem(recordKey);
      expect(stalePin).not.toBeNull();
      expect(staleRecord).not.toBeNull();
      owner.resetProject('proj_order');
      expect(storage.values.has(pinKey)).toBe(false);
      expect(storage.values.has(recordKey)).toBe(false);
      // The other tab's writes, as it made them under the old generation,
      // land after the reset removed them.
      storage.setItem(pinKey, stalePin!);
      storage.setItem(recordKey, staleRecord!);
      const fresh = localStorageEncryptedProjectPins(storage);
      expect(fresh.has('proj_order')).toBe(false);
      expect(fresh.cutoverUnresolved('proj_order')).toBe(false);
      // A pin made after the reset, in a tab that saw it, holds.
      expect(fresh.pin('proj_order')).toBe(true);
      expect(localStorageEncryptedProjectPins(storage).has('proj_order')).toBe(
        true
      );
    });

    it.each([
      [
        'pin',
        (pins: EncryptedProjectPinStore) => pins.pin('proj_again'),
        (pins: EncryptedProjectPinStore) => pins.has('proj_again')
      ],
      [
        'unresolved record',
        (pins: EncryptedProjectPinStore) =>
          pins.markCutoverUnresolved('proj_again'),
        (pins: EncryptedProjectPinStore) => pins.cutoverUnresolved('proj_again')
      ]
    ])(
      'never lets a write checked before a reset overwrite the %s made after it',
      (_name, write, holds) => {
        const storage = memoryStorage();
        localStorageEncryptedProjectPins(storage).pin('proj_again');
        // Tab A checks generation G0 ...
        const stale = interleavedTab(storage);
        expect(stale.pins.has('proj_again')).toBe(true);
        // ... tab B resets the project to G1, and a tab that saw G1 pins
        // it again (or begins another cutover) ...
        const owner = localStorageEncryptedProjectPins(storage);
        expect(owner.has('proj_again')).toBe(true);
        stale.interleave = () => {
          owner.resetProject('proj_again');
          const fresh = localStorageEncryptedProjectPins(storage);
          expect(fresh.pin('proj_again')).toBe(true);
          expect(write(fresh)).toBe(true);
        };
        // ... then A's G0 write lands.
        expect(write(stale.pins)).toBe(false);
        expect(stale.interleave).toBeNull();

        const reloaded = localStorageEncryptedProjectPins(storage);
        expect(reloaded.degraded).toBe(false);
        expect(reloaded.has('proj_again')).toBe(true);
        expect(holds(reloaded)).toBe(true);
        expect(stale.pins.resetElsewhere('proj_again')).toBe(true);
      }
    );

    it('removes only records of the generations a reset replaced', () => {
      const storage = memoryStorage();
      const owner = localStorageEncryptedProjectPins(storage);
      owner.pin('proj_cleanup');
      owner.markCutoverUnresolved('proj_cleanup');
      // Between the reset saving its new generation and removing the old
      // records, a tab that loads now pins the project and begins another
      // cutover under that new generation.
      let pinnedAgain = false;
      const resetting = localStorageEncryptedProjectPins({
        getItem: (key) => storage.getItem(key),
        setItem: (key, value) => storage.setItem(key, value),
        removeItem: (key) => {
          if (!pinnedAgain) {
            pinnedAgain = true;
            const fresh = localStorageEncryptedProjectPins(storage);
            expect(fresh.pin('proj_cleanup')).toBe(true);
            expect(fresh.markCutoverUnresolved('proj_cleanup')).toBe(true);
          }
          storage.removeItem(key);
        }
      });
      expect(resetting.has('proj_cleanup')).toBe(true);
      resetting.resetProject('proj_cleanup');
      expect(pinnedAgain).toBe(true);

      const reloaded = localStorageEncryptedProjectPins(storage);
      expect(reloaded.has('proj_cleanup')).toBe(true);
      expect(reloaded.cutoverUnresolved('proj_cleanup')).toBe(true);
      // The replaced generation's records are gone.
      expect(storage.values.has(encryptedProjectPinKey('proj_cleanup'))).toBe(
        false
      );
      expect(
        storage.values.has(encryptCutoverUnresolvedKey('proj_cleanup'))
      ).toBe(false);
    });

    it('sweeps records a stale tab left under older generations, never a newer one', () => {
      const values = new Map<string, string>();
      const storage = {
        values,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
        removeItem: (key: string) => {
          values.delete(key);
        },
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() {
          return values.size;
        }
      };
      const projectId = 'proj_sweep';
      const generation = (offsetMs: number) =>
        `${(Date.now() + offsetMs).toString(36)}.tab`;
      const older = generation(-60_000);
      const newer = generation(3_600_000);
      // Left by tabs that wrote under generations no reset of this tab saw.
      for (const tag of [NO_RESET, older]) {
        storage.setItem(encryptedProjectPinKey(projectId, tag), tag);
        storage.setItem(encryptCutoverUnresolvedKey(projectId, tag), tag);
      }
      // One another tab wrote after a reset this tab has not seen yet, and
      // one whose generation cannot be dated.
      storage.setItem(encryptedProjectPinKey(projectId, newer), newer);
      storage.setItem(`${ENCRYPTED_PROJECT_PIN_PREFIX}${projectId}:odd`, 'x');
      // Another project's old record is not this reset's.
      storage.setItem(encryptedProjectPinKey('proj_other', older), older);

      localStorageEncryptedProjectPins(storage).resetProject(projectId);

      const saved = storage.getItem(ENCRYPTED_PROJECT_RESET_PREFIX + projectId);
      expect(saved).not.toBeNull();
      expect(
        [...values.keys()]
          .filter((key) => key.includes(projectId))
          .filter((key) => !key.startsWith(ENCRYPTED_PROJECT_RESET_PREFIX))
          .sort()
      ).toEqual(
        [
          encryptedProjectPinKey(projectId, newer),
          `${ENCRYPTED_PROJECT_PIN_PREFIX}${projectId}:odd`
        ].sort()
      );
      expect(values.has(encryptedProjectPinKey('proj_other', older))).toBe(
        true
      );
    });

    it('resolves only the unresolved record it wrote, never a newer one', () => {
      const storage = memoryStorage();
      const first = localStorageEncryptedProjectPins(storage);
      first.pin('proj_resolve');
      expect(first.markCutoverUnresolved('proj_resolve')).toBe(true);
      // Another tab resets the project and begins its own cutover.
      const second = localStorageEncryptedProjectPins(storage);
      expect(second.has('proj_resolve')).toBe(true);
      second.resetProject('proj_resolve');
      expect(second.pin('proj_resolve')).toBe(true);
      expect(second.markCutoverUnresolved('proj_resolve')).toBe(true);
      // The first tab's own (older) cutover call answers.
      first.resolveCutover('proj_resolve');
      expect(
        localStorageEncryptedProjectPins(storage).cutoverUnresolved(
          'proj_resolve'
        )
      ).toBe(true);
    });

    it('still counts a bare record written before generation keys', () => {
      const storage = memoryStorage();
      storage.setItem(ENCRYPTED_PROJECT_PIN_PREFIX + 'proj_legacy', NO_RESET);
      storage.setItem(
        ENCRYPTED_PROJECT_UNRESOLVED_PREFIX + 'proj_legacy',
        NO_RESET
      );
      const pins = localStorageEncryptedProjectPins(storage);
      expect(pins.has('proj_legacy')).toBe(true);
      expect(pins.cutoverUnresolved('proj_legacy')).toBe(true);
      pins.resetProject('proj_legacy');
      expect(
        storage.values.has(ENCRYPTED_PROJECT_PIN_PREFIX + 'proj_legacy')
      ).toBe(false);
      const reloaded = localStorageEncryptedProjectPins(storage);
      expect(reloaded.has('proj_legacy')).toBe(false);
      expect(reloaded.cutoverUnresolved('proj_legacy')).toBe(false);
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
