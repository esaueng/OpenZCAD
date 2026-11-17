import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_APPROVAL_SESSION_KEY,
  captureDeviceApprovalLink,
  clearPendingDeviceApproval,
  deviceApprovalCodeFromHash,
  deviceApprovalCodeFromLink,
  deviceApprovalLink,
  pendingDeviceApproval,
  subscribePendingDeviceApproval
} from './deviceApprovalLink';
import { encodeQr } from './qrCode';

/** A 52-symbol Crockford base32 code, as `deviceScanCode` writes it. */
const CODE = '0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJK';

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  };
}

describe('the #approve-device= link a new device shows as its QR code', () => {
  it('builds a link from the scan code on this origin', () => {
    expect(deviceApprovalLink(`OZD1:${CODE}`, 'https://cad.example')).toBe(
      `https://cad.example/#approve-device=${CODE}`
    );
  });

  it('fits a QR code a phone camera can read on a realistic origin', () => {
    const link = deviceApprovalLink(
      `OZD1:${CODE}`,
      'https://beta.openzcad.example.com'
    );
    expect(() => encodeQr(link)).not.toThrow();
  });

  it('reads exactly one well-formed code', () => {
    expect(deviceApprovalCodeFromHash(`#approve-device=${CODE}`)).toBe(CODE);
    expect(
      deviceApprovalCodeFromHash(`#approve-device=${CODE.toLowerCase()}`)
    ).toBe(CODE);
    for (const hash of [
      `#share=${CODE}`,
      '#approve-device=short',
      `#approve-device=${CODE}&approve-device=${CODE}`,
      `#approve-device=${CODE}&share=x`,
      // I, L, O and U are not Crockford symbols.
      `#approve-device=${CODE.slice(0, 51)}U`
    ]) {
      expect(deviceApprovalCodeFromHash(hash)).toBeNull();
    }
  });

  it('reads the code out of a full link, whatever its origin', () => {
    expect(
      deviceApprovalCodeFromLink(
        ` https://cad.example/#approve-device=${CODE} `
      )
    ).toBe(CODE);
    expect(deviceApprovalCodeFromLink(`OZD1:${CODE}`)).toBeNull();
    expect(
      deviceApprovalCodeFromLink('not a link#approve-device=x')
    ).toBeNull();
  });

  it('scrubs the fragment, keeps the code for this tab and tells listeners', () => {
    const store = storage();
    const replaceState = vi.fn();
    const listener = vi.fn();
    const stop = subscribePendingDeviceApproval(listener);
    expect(
      captureDeviceApprovalLink(
        { hash: `#approve-device=${CODE}`, pathname: '/', search: '' },
        { replaceState, state: null },
        store
      )
    ).toBe(CODE);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(store.values.get(DEVICE_APPROVAL_SESSION_KEY)).toBe(CODE);
    expect(pendingDeviceApproval(store)).toBe(CODE);
    expect(listener).toHaveBeenCalledOnce();
    clearPendingDeviceApproval(store);
    expect(pendingDeviceApproval(store)).toBeNull();
    stop();
  });

  it('scrubs a malformed link without keeping anything', () => {
    const store = storage();
    const replaceState = vi.fn();
    expect(
      captureDeviceApprovalLink(
        { hash: '#approve-device=nope', pathname: '/', search: '' },
        { replaceState, state: null },
        store
      )
    ).toBeNull();
    expect(replaceState).toHaveBeenCalledOnce();
    expect(store.values.size).toBe(0);
  });
});
