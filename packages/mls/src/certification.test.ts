/**
 * The leaf certification payload (version 2) is a wire format: devices sign
 * it and every member re-derives it to verify, so its bytes are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { toHex } from './hex';
import { inProcessMls } from './test-support';

const leafKey = new Uint8Array(65).map((_, i) => (i === 0 ? 0x04 : i));

// MLS encoding: opaque<V> label, project id, user id, device id; u16 cipher
// suite 0x0002; opaque<V> leaf key; u64 certified epoch.
const VECTOR =
  '22' +
  toHex(new TextEncoder().encode('openzcad mls leaf certification v2')) +
  '09' +
  toHex(new TextEncoder().encode('project-1')) +
  '06' +
  toHex(new TextEncoder().encode('user-1')) +
  '08' +
  toHex(new TextEncoder().encode('device-1')) +
  '0002' +
  '4041' +
  toHex(leafKey) +
  '0000000102030405';

describe('leaf certification payload v2', () => {
  const mls = inProcessMls();

  it('matches the pinned vector, epoch included', async () => {
    const payload = await mls.leafCertificationPayload(
      'project-1',
      'user-1',
      'device-1',
      leafKey,
      0x0102030405
    );
    expect(toHex(payload)).toBe(VECTOR);
    expect(VECTOR).toBe(
      '226f70656e7a636164206d6c73206c6561662063657274696669636174696f6e2076320970726f6a6563742d3106757365722d31086465766963652d3100024041040102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f400000000102030405'
    );
  });

  it('differs for every epoch, so a signature counts for one epoch only', async () => {
    const at = (epoch: number) =>
      mls.leafCertificationPayload('p', 'u', 'd', leafKey, epoch).then(toHex);
    const payloads = await Promise.all(
      [0, 1, 2, Number.MAX_SAFE_INTEGER].map(at)
    );
    expect(new Set(payloads).size).toBe(4);
    expect(payloads[3]!.endsWith('001fffffffffffff')).toBe(true);
  });

  it('refuses an epoch that is not a non-negative safe integer', async () => {
    for (const epoch of [-1, 1.5, 2 ** 53, Number.NaN])
      await expect(
        mls.leafCertificationPayload('p', 'u', 'd', leafKey, epoch)
      ).rejects.toMatchObject({ kind: 'input' });
  });
});
