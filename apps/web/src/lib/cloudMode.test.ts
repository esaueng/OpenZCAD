import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOUD_FUNCTIONS_STORAGE_KEY,
  CloudFunctionsDisabledError,
  assertCloudFunctionsEnabled,
  cloudFunctionsAreEnabled,
  cloudRequestSignal,
  setCloudFunctionsEnabled
} from './cloudMode';

afterEach(() => {
  setCloudFunctionsEnabled(true);
  globalThis.localStorage?.removeItem(CLOUD_FUNCTIONS_STORAGE_KEY);
});

describe('cloud functions master switch', () => {
  it('persists the device-local choice and blocks new requests', () => {
    setCloudFunctionsEnabled(false);

    expect(cloudFunctionsAreEnabled()).toBe(false);
    expect(globalThis.localStorage?.getItem(CLOUD_FUNCTIONS_STORAGE_KEY)).toBe(
      'false'
    );
    expect(() => assertCloudFunctionsEnabled()).toThrow(
      CloudFunctionsDisabledError
    );
    expect(() => cloudRequestSignal()).toThrow(
      'Cloud features are disabled on this device.'
    );
  });

  it('aborts active cloud requests when switched off', () => {
    const signal = cloudRequestSignal();
    expect(signal.aborted).toBe(false);

    setCloudFunctionsEnabled(false);

    expect(signal.aborted).toBe(true);
  });

  it('starts a fresh request lifetime after cloud features are restored', () => {
    const previous = cloudRequestSignal();
    setCloudFunctionsEnabled(false);
    setCloudFunctionsEnabled(true);

    const restored = cloudRequestSignal();
    expect(previous.aborted).toBe(true);
    expect(restored.aborted).toBe(false);
  });
});
