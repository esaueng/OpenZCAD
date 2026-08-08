export const CLOUD_FUNCTIONS_STORAGE_KEY =
  'openzcad-cloud-functions-enabled:v1';

function readStoredCloudFunctionsEnabled(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(CLOUD_FUNCTIONS_STORAGE_KEY) !== 'false'
    );
  } catch {
    return true;
  }
}

let enabled = readStoredCloudFunctionsEnabled();
let requestController = new AbortController();

if (!enabled) {
  requestController.abort();
}

export class CloudFunctionsDisabledError extends Error {
  constructor() {
    super('Cloud features are disabled on this device.');
    this.name = 'CloudFunctionsDisabledError';
  }
}

/**
 * Device-local master switch for every network-backed OpenZCAD function.
 *
 * This deliberately does not live in account-synced AppSettings: persisting an
 * offline choice must never depend on contacting the cloud it disables.
 */
export function cloudFunctionsAreEnabled(): boolean {
  return enabled;
}

export function setCloudFunctionsEnabled(next: boolean): void {
  if (next === enabled) {
    return;
  }
  enabled = next;
  try {
    globalThis.localStorage?.setItem(CLOUD_FUNCTIONS_STORAGE_KEY, String(next));
  } catch {
    // The runtime gate still applies for this session when storage is blocked.
  }
  if (!next) {
    requestController.abort();
  } else {
    requestController = new AbortController();
  }
}

export function assertCloudFunctionsEnabled(): void {
  if (!enabled) {
    throw new CloudFunctionsDisabledError();
  }
}

/**
 * Combines a caller-owned cancellation signal with the master offline switch.
 * Disabling cloud features therefore cancels active browser fetches as well as
 * preventing new ones.
 */
export function cloudRequestSignal(signal?: AbortSignal | null): AbortSignal {
  assertCloudFunctionsEnabled();
  return signal
    ? AbortSignal.any([signal, requestController.signal])
    : requestController.signal;
}
