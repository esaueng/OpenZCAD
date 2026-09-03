import type { WheelDevice } from '@openzcad/viewport';

/**
 * Where scroll-wheel auto-detection remembers the device it proved. Kept
 * beside the app settings rather than inside them: it is a browser fact, not
 * a preference, and must not sync or show up as a user choice.
 */
export const WHEEL_DEVICE_STORAGE_KEY = 'openzcad-wheel-device:v1';

export function readWheelDeviceMemory(): WheelDevice | null {
  try {
    const raw = window.localStorage.getItem(WHEEL_DEVICE_STORAGE_KEY);
    return raw === 'mouse' || raw === 'trackpad' ? raw : null;
  } catch {
    return null;
  }
}

export function writeWheelDeviceMemory(device: WheelDevice): void {
  try {
    window.localStorage.setItem(WHEEL_DEVICE_STORAGE_KEY, device);
  } catch {
    // Private mode or a blocked store: detection still works for the visit.
  }
}
