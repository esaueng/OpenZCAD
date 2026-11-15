import { useSyncExternalStore } from 'react';
import {
  encryptedPinsRevision,
  subscribeEncryptedPins,
  type EncryptedPinProblem
} from '../lib/api';

/**
 * What the shelf and the editor need of this device's encrypted-project
 * pins on every render, kept apart from the confirmed reset itself
 * (`EncryptedPinReset.tsx`), which loads only when a stuck project is met.
 */

/** Re-renders when this device's encrypted-project pins change. */
export function useEncryptedPins(): number {
  return useSyncExternalStore(
    subscribeEncryptedPins,
    encryptedPinsRevision,
    encryptedPinsRevision
  );
}

export type PinResetTarget =
  | {
      readonly kind: 'project';
      readonly projectId: string;
      readonly name: string | null;
      readonly reason: EncryptedPinProblem;
    }
  /** The whole store, after a pin could not be saved. */
  | { readonly kind: 'device' };

/** Plain words for what a stuck project's problem is. */
export function pinProblemText(reason: EncryptedPinProblem): string {
  return reason === 'unresolved'
    ? 'The switch to end-to-end encryption didn’t finish on this device.'
    : 'Your account lists it as not encrypted, but this device keeps it encrypted.';
}
