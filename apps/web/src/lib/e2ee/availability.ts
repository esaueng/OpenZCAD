import { desktopFetch } from '../desktopBridge';

/**
 * Whether the server has opened end-to-end encryption keys to this account
 * (ADR-024 Phase 3, behind `E2EE_KEYS_ENABLED`). Anything but a clear yes,
 * including an older Worker or a static host, reads as no.
 */
export async function fetchEncryptionAvailability(): Promise<boolean> {
  try {
    const response = await desktopFetch('/api/e2ee/config', {
      credentials: 'same-origin'
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { enabled?: unknown };
    return body.enabled === true;
  } catch {
    return false;
  }
}
