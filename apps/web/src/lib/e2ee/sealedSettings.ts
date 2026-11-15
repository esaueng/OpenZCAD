import {
  ACCOUNT_SETTINGS_RECORD,
  accountKeyCommitment,
  accountKeySequences,
  fromBase64Url,
  isE2eeError,
  openRecord,
  readSealedRecordHeader,
  sealRecord,
  toBase64Url,
  toHex
} from '@openzcad/crypto';
import type { AppSettings } from '@openzcad/shared';
import { normalizeAppSettings } from '../appSettings';

/**
 * Account settings sealed under the account key (ADR-024 amendment
 * 2026-11-14), for an account whose library is encrypted. Loaded only by
 * such an account, so the crypto stays out of the settings chunk.
 */
export interface SettingsSequencePins {
  read(): number;
  write(sequence: number): void;
}

const SEQUENCE_PREFIX = 'openzcad.settings.sealed.sequence.v1';
/** Shared across reads even when persistent storage refuses a pin. */
const sequenceFloors = new Map<string, number>();

/** The highest sealed-settings sequence this device opened or wrote. */
export function localStorageSettingsSequencePins(
  userId: string
): SettingsSequencePins {
  const key = `${SEQUENCE_PREFIX}:${userId}`;
  const remember = (value: number) => {
    const floor = Math.max(
      sequenceFloors.get(userId) ?? 0,
      Number.isSafeInteger(value) && value > 0 ? value : 0
    );
    sequenceFloors.set(userId, floor);
    return floor;
  };
  const read = (): number => {
    try {
      return remember(Number(globalThis.localStorage?.getItem(key) ?? 0));
    } catch {
      return remember(0);
    }
  };
  return {
    read,
    write(sequence: number) {
      const floor = remember(Math.max(read(), sequence));
      try {
        globalThis.localStorage?.setItem(key, String(floor));
      } catch {
        // The memory floor still protects this visit.
      }
    }
  };
}

export interface SealedSettingsKeys {
  accountKey: Uint8Array;
  userId: string;
  pins: SettingsSequencePins;
  /** An older account key by its commitment (`olderAccountKey`). */
  olderKey?: (commitment: Uint8Array) => Promise<Uint8Array | null>;
}

/**
 * The sequence a sealed record carries, readable without the key, or null
 * for a record that is not one. A write moves past it even when this device
 * cannot open the record, so no device ever reuses or lowers a sequence.
 */
export function sealedSettingsSequence(record: string): number | null {
  try {
    return readSealedRecordHeader(
      ACCOUNT_SETTINGS_RECORD,
      fromBase64Url(record)
    ).sequence;
  } catch {
    return null;
  }
}

/**
 * Seals the whole settings at a sequence above both this device's pin and
 * `floor` (the record the account holds now). `commit` pins it once the
 * Worker stored it, so a refused write does not raise the pin.
 */
export async function sealSettings(
  keys: SealedSettingsKeys,
  settings: AppSettings,
  floor = 0
): Promise<{ record: string; commit(): void }> {
  const sequence = Math.max(keys.pins.read(), floor) + 1;
  const sealed = await sealRecord(
    ACCOUNT_SETTINGS_RECORD,
    keys.accountKey,
    keys.userId,
    sequence,
    new TextEncoder().encode(JSON.stringify(normalizeAppSettings(settings)))
  );
  return {
    record: toBase64Url(sealed),
    commit: () => {
      if (keys.pins.read() < sequence) keys.pins.write(sequence);
    }
  };
}

/**
 * The settings in a sealed record, or null when this device cannot use it:
 * another account key sealed it (a device removal rotated the key), it is
 * older than a record this device already opened or wrote (a rollback), or
 * it fails authentication. The caller then keeps this device's own values.
 */
export async function openSettings(
  keys: SealedSettingsKeys,
  record: string
): Promise<AppSettings | null> {
  let older: Uint8Array | null = null;
  try {
    let sealed: Uint8Array;
    let sequence: number;
    let accountKey: Uint8Array = keys.accountKey;
    try {
      sealed = fromBase64Url(record);
      const header = readSealedRecordHeader(ACCOUNT_SETTINGS_RECORD, sealed);
      if (
        toHex(header.commitment) !==
        toHex(await accountKeyCommitment(keys.accountKey))
      ) {
        // Sealed before an account-key rotation: open it with that older
        // key, through the account-key history.
        older = (await keys.olderKey?.(header.commitment)) ?? null;
        if (!older) return null;
        accountKey = older;
      }
      if (header.sequence < keys.pins.read()) return null;
      sequence = header.sequence;
    } catch (error) {
      if (isE2eeError(error) || error instanceof Error) return null;
      throw error;
    }
    let plaintext: Uint8Array;
    try {
      ({ plaintext } = await openRecord(
        ACCOUNT_SETTINGS_RECORD,
        accountKey,
        keys.userId,
        sealed
      ));
    } catch (error) {
      if (isE2eeError(error)) return null;
      throw error;
    }
    let settings: AppSettings;
    try {
      settings = normalizeAppSettings(
        JSON.parse(new TextDecoder().decode(plaintext))
      );
    } catch {
      return null;
    }
    keys.pins.write(sequence);
    return settings;
  } finally {
    // Every exit, a rolled-back record included, wipes the older key.
    older?.fill(0);
  }
}

/**
 * The account key, older than the current one, whose commitment is
 * `commitment`, opened through the account-key history (each replaced key
 * is wrapped under its successor), or null when this device cannot: keys
 * locked, another identity generation, or a history the server withholds.
 * The caller zeroes the copy.
 */
export async function olderAccountKey(
  userId: string,
  commitment: Uint8Array
): Promise<Uint8Array | null> {
  try {
    const [accountKeys, { createE2eeApi }, { deviceKeyStore }, keySession] =
      await Promise.all([
        import('./accountKeys'),
        import('./e2eeApi'),
        import('./keychainDeviceKeys'),
        import('./keySession')
      ]);
    const revision = keySession.getKeySessionRevision();
    const ctx = {
      userId,
      api: createE2eeApi(),
      store: deviceKeyStore(),
      isCurrent: () => keySession.getKeySessionRevision() === revision
    };
    const state = await accountKeys.loadEncryption(ctx);
    if (state.kind !== 'ready' || !state.account.unlocked) return null;
    const target = toHex(commitment);
    const keySequence = accountKeySequences(state.account.list).find(
      (sequence) =>
        state.account.list.entries.some(
          ({ entry }) =>
            entry.sequence === sequence &&
            toHex(entry.accountKeyCommitment) === target
        )
    );
    if (keySequence === undefined) return null;
    return await accountKeys.openAccountKeyChain(
      ctx,
      state.account,
      keySequence
    );
  } catch {
    return null;
  }
}
