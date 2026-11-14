import {
  ACCOUNT_SETTINGS_RECORD,
  accountKeyCommitment,
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
  let sealed: Uint8Array;
  let sequence: number;
  try {
    sealed = fromBase64Url(record);
    const header = readSealedRecordHeader(ACCOUNT_SETTINGS_RECORD, sealed);
    if (
      toHex(header.commitment) !==
      toHex(await accountKeyCommitment(keys.accountKey))
    )
      return null;
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
      keys.accountKey,
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
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeValue(base: unknown, ours: unknown, theirs: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(ours) && isPlainObject(theirs)) {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)]))
      merged[key] = mergeValue(base[key], ours[key], theirs[key]);
    return merged;
  }
  // A field this device left as it was takes the account's value; one it
  // changed keeps the change.
  return sameValue(ours, base) ? theirs : ours;
}

/**
 * Settings a device edited while it could not open the account's sealed
 * record, merged onto that record: each field this device changed from
 * `base` (what it showed when it read the record locked) keeps its value,
 * every other field takes the account's. Without it the first save after
 * unlocking would replace the account's settings with this device's
 * defaults.
 */
export function mergeSettingsOntoAccount(
  base: AppSettings,
  ours: AppSettings,
  theirs: AppSettings
): AppSettings {
  return normalizeAppSettings(mergeValue(base, ours, theirs));
}
