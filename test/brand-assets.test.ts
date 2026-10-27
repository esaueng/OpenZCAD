import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
});
