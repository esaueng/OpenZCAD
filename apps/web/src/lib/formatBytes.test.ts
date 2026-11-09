import { describe, expect, it, vi } from 'vitest';
import { formatBytes } from './formatBytes';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [512, '512 B'],
    [1023, '1,023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [1024 ** 2, '1 MB'],
    [24 * 1024 ** 2, '24 MB'],
    [1.25 * 1024 ** 2, '1.3 MB'],
    [1024 ** 3, '1 GB'],
    [1.5 * 1024 ** 3, '1.5 GB'],
    [102_400 * 1024 ** 2, '100 GB'],
    [1024 ** 4, '1 TB'],
    [1024 ** 5, '1 PB'],
    [1024 ** 2 - 1, '1 MB']
  ])('formats %s bytes as %s', (bytes, label) => {
    expect(formatBytes(bytes)).toBe(label);
  });

  it('shares binary scaling and precision with explicit IEC labels', () => {
    expect(formatBytes(1536, 'iec')).toBe('1.5 KiB');
    expect(formatBytes(24 * 1024 ** 2, 'iec')).toBe('24 MiB');
    expect(formatBytes(100 * 1024 ** 3, 'iec')).toBe('100 GiB');
    expect(formatBytes(1024 ** 4, 'iec')).toBe('1 TiB');
  });

  it('uses locale separators for both byte counts and fractional sizes', () => {
    const locale = vi
      .spyOn(Number.prototype, 'toLocaleString')
      .mockImplementation(function (this: number, _locales, options) {
        return new Intl.NumberFormat('de-DE', options).format(this.valueOf());
      });
    try {
      expect(formatBytes(1023)).toBe('1.023 B');
      expect(formatBytes(1.5 * 1024 ** 3)).toBe('1,5 GB');
    } finally {
      locale.mockRestore();
    }
  });
});
