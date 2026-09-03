import { afterEach, describe, expect, it } from 'vitest';
import {
  WHEEL_DEVICE_STORAGE_KEY,
  readWheelDeviceMemory,
  writeWheelDeviceMemory
} from './wheelDeviceMemory';

afterEach(() => {
  window.localStorage.removeItem(WHEEL_DEVICE_STORAGE_KEY);
});

describe('wheel device memory', () => {
  it('round-trips a proved device', () => {
    expect(readWheelDeviceMemory()).toBeNull();
    writeWheelDeviceMemory('trackpad');
    expect(readWheelDeviceMemory()).toBe('trackpad');
    writeWheelDeviceMemory('mouse');
    expect(readWheelDeviceMemory()).toBe('mouse');
  });

  it('ignores anything that is not a device name', () => {
    window.localStorage.setItem(WHEEL_DEVICE_STORAGE_KEY, 'keyboard');
    expect(readWheelDeviceMemory()).toBeNull();
  });
});
