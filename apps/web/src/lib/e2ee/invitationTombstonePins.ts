/**
 * The sequence pin of the account's sealed invitation tombstones
 * (`invitationTombstones.ts`): the highest this device opened or wrote, so
 * the server cannot hand it an older record. Free of crypto, so account
 * erasure can forget it without loading the invitation code.
 */
import { realmStorageName } from '../deploymentRealm';

/** The highest sequence of the record this device opened or wrote. */
export interface TombstoneSequencePins {
  read(): number;
  write(sequence: number): void;
}

const PIN_PREFIX = realmStorageName(
  'openzcad.invitationTombstones.sealed.sequence.v1'
);
/** Holds even where persistent storage refuses the pin. */
const pinFloors = new Map<string, number>();

export function localStorageTombstonePins(
  userId: string
): TombstoneSequencePins {
  const key = `${PIN_PREFIX}:${userId}`;
  const remember = (value: number) => {
    const floor = Math.max(
      pinFloors.get(userId) ?? 0,
      Number.isSafeInteger(value) && value > 0 ? value : 0
    );
    pinFloors.set(userId, floor);
    return floor;
  };
  const read = () => {
    try {
      return remember(Number(globalThis.localStorage?.getItem(key) ?? 0));
    } catch {
      return remember(0);
    }
  };
  return {
    read,
    write(sequence) {
      const floor = remember(Math.max(read(), sequence));
      try {
        globalThis.localStorage?.setItem(key, String(floor));
      } catch {
        // The memory floor still holds for this visit.
      }
    }
  };
}

/** Account erasure: this device forgets the record's pin. */
export function forgetInvitationTombstones(userId: string): void {
  pinFloors.delete(userId);
  try {
    globalThis.localStorage?.removeItem(`${PIN_PREFIX}:${userId}`);
  } catch {
    // Nothing kept.
  }
}
