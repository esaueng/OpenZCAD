import { parseRecoveryKey, type Bytes } from '@openzcad/crypto';
import {
  EncryptionFlowError,
  type E2eeContext,
  type EncryptionState
} from '../../lib/e2ee/accountKeys';
import { DeviceListPinConflict } from '../../lib/e2ee/deviceStore';
import { E2eeApiError } from '../../lib/e2ee/e2eeApi';
import { PasskeyError } from '../../lib/e2ee/passkeys';

export interface RunOptions {
  /** A reload that announces a state change only when it found one. */
  readOnly?: boolean;
  /**
   * Where a failure is said. Without it the page's alert says it; a dialog
   * passes its own, so the message appears next to what was tried.
   */
  onError?(message: string): void;
}

/** What every encryption flow shares with the page that hosts it. */
export interface Shared {
  ctx: E2eeContext;
  busy: boolean;
  run(
    work: () => Promise<EncryptionState | void>,
    options?: RunOptions
  ): Promise<boolean>;
}

export function messageFor(error: unknown): string {
  if (
    error instanceof EncryptionFlowError ||
    error instanceof E2eeApiError ||
    error instanceof PasskeyError ||
    error instanceof DeviceListPinConflict
  ) {
    return error.message;
  }
  if (error instanceof Error && error.name === 'E2eeError') {
    return `The keys did not verify: ${error.message}`;
  }
  if (
    error instanceof Error &&
    (error.name === 'DeviceRemovalError' || error.name === 'ProjectGroupError')
  ) {
    return error.message;
  }
  return 'Encryption keys are unavailable right now. Check your connection and try again.';
}

export const NOT_A_RECOVERY_KEY =
  'That is not a recovery key. Check it for typos: it is 56 letters and digits in groups of four.';

export async function readRecoveryKey(text: string): Promise<Bytes> {
  try {
    return await parseRecoveryKey(text);
  } catch {
    throw new EncryptionFlowError('wrong-recovery-key', NOT_A_RECOVERY_KEY);
  }
}

export function isWrongRecoveryKey(
  error: unknown
): error is EncryptionFlowError {
  return (
    error instanceof EncryptionFlowError && error.code === 'wrong-recovery-key'
  );
}

export function formatDate(value: number | string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/** Saves a recovery key as a text file the user keeps offline. */
export function downloadRecoveryKey(formatted: string): void {
  const blob = new Blob(
    [
      `OpenZCAD recovery key\n\n${formatted}\n\nKeep this somewhere safe and offline. It opens your encryption keys on any device. OpenZCAD cannot recover it for you.\n`
    ],
    { type: 'text/plain' }
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'openzcad-recovery-key.txt';
  link.click();
  URL.revokeObjectURL(url);
}
