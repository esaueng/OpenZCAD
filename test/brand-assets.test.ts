import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pngColorType, removePngAlpha } from '../scripts/opaque-png.mjs';

describe('shipped brand assets', () => {
  it('keeps exported SVGs and the outlined wordmark in sync with the canonical mark', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ['scripts/generate-brand-assets.mjs', '--check'],
        {
          stdio: 'pipe'
        }
      )
    ).not.toThrow();
  });

  it.each([
    ['favicon-16.png', 16],
    ['favicon-32.png', 32],
    ['apple-touch-icon.png', 180]
  ] as const)('ships %s at its declared browser size', (name, size) => {
    const png = readFileSync(`apps/web/public/${name}`);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    const html = readFileSync('apps/web/index.html', 'utf8');
    expect(html).toContain(`sizes="${size}x${size}" href="/${name}"`);
  });

  // App Store Connect rejects an icon with an alpha channel (ITMS-90717).
  it('ships the iPhone and iPad icon without an alpha channel', () => {
    const png = readFileSync(
      'apps/ipad/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png'
    );
    expect(pngColorType(png)).toBe(2);
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
  });
});

function rgbaPng(width: number, pixels: number[][], filter = 1): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const height = pixels.length / width;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = pixels.slice(y * width, (y + 1) * width).flat();
    rows.push(filter);
    // Sub filter: each byte minus the byte one pixel to its left.
    row.forEach((value, x) =>
      rows.push(
        filter === 1 ? (value - (x >= 4 ? row[x - 4]! : 0)) & 0xff : value
      )
    );
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

describe('removePngAlpha', () => {
  it('rewrites an opaque RGBA image as RGB with the same pixels', async () => {
    const { inflateSync } = await import('node:zlib');
    const source = rgbaPng(2, [
      [10, 20, 30, 255],
      [40, 50, 60, 255],
      [70, 80, 90, 255],
      [100, 110, 120, 255]
    ]);
    const rgb = removePngAlpha(source);
    expect(pngColorType(rgb)).toBe(2);
    const idat = rgb.subarray(rgb.indexOf('IDAT') + 4, rgb.indexOf('IEND') - 8);
    expect([...inflateSync(idat)]).toEqual([
      0, 10, 20, 30, 40, 50, 60, 0, 70, 80, 90, 100, 110, 120
    ]);
  });

  it('refuses an image with any transparent pixel', () => {
    const source = rgbaPng(2, [
      [10, 20, 30, 255],
      [40, 50, 60, 0]
    ]);
    expect(() => removePngAlpha(source)).toThrow(/not fully opaque/);
  });
});
