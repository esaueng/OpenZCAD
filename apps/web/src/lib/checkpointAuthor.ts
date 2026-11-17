import type { AuthSession, ProjectCheckpointAuthor } from '@openzcad/shared';
import { defaultDeviceLabel } from './deviceLabel';

/**
 * Who is making a save point, as the versions list shows it (L03): the
 * signed-in account and its display name, and this device. Signed out, only
 * the device is known. It is written into the document, which an encrypted
 * project keeps encrypted (ADR-024), so the server learns nothing new.
 */
export function currentCheckpointAuthor(
  session: Pick<AuthSession, 'userId' | 'displayName'> | null,
  userAgent: string = typeof navigator === 'undefined'
    ? ''
    : navigator.userAgent
): ProjectCheckpointAuthor {
  return {
    ...(session ? { userId: session.userId } : {}),
    ...(session?.displayName.trim() ? { name: session.displayName } : {}),
    device: defaultDeviceLabel(userAgent)
  };
}
