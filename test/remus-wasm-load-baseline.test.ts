import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  percentile,
  resolveKernelArtifact,
  summarize
} from '../scripts/measure-remus-wasm-load.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function distribution() {
  const directory = mkdtempSync(join(tmpdir(), 'openzcad-wasm-load-'));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, 'assets'));
  const assetPath = 'assets/remus_wasm_bg-test.wasm';
  const bytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  writeFileSync(join(directory, assetPath), bytes);
  writeFileSync(
    join(directory, 'build-meta.json'),
    JSON.stringify({
      format: 'openzcad-build-metadata',
      formatVersion: 2,
      commit: '1'.repeat(40),
      remus: { commit: '2'.repeat(40), version: '2.130.1' },
      assets: [assetPath]
    })
  );
  return { directory, assetPath, bytes };
}

describe('Remus WASM load baseline statistics', () => {
  it('uses a midpoint median and nearest-rank p95', () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);

    expect(percentile(values, 0.5)).toBe(10);
    expect(percentile(values, 0.95)).toBe(19);
    expect(summarize(values).median).toBe(10.5);
    expect(summarize([3, null, 1, 2])).toEqual({ median: 2, p95: 3 });
  });

  it('rejects invalid percentile fractions', () => {
    expect(() => percentile([1], 0)).toThrow('Percentile fraction');
    expect(() => percentile([1], 1.01)).toThrow('Percentile fraction');
  });
});

describe('Remus WASM load baseline provenance', () => {
  it('selects the one emitted kernel asset through build metadata', () => {
    const fixture = distribution();

    const artifact = resolveKernelArtifact(fixture.directory);

    expect(artifact.assetPath).toBe(fixture.assetPath);
    expect(artifact.bytes).toEqual(fixture.bytes);
    expect(artifact.openzcadCommit).toBe('1'.repeat(40));
    expect(artifact.remusCommit).toBe('2'.repeat(40));
    expect(artifact.remusVersion).toBe('2.130.1');
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses ambiguous emitted kernel assets', () => {
    const fixture = distribution();
    const metadataPath = join(fixture.directory, 'build-meta.json');
    writeFileSync(
      metadataPath,
      JSON.stringify({
        format: 'openzcad-build-metadata',
        formatVersion: 2,
        commit: '1'.repeat(40),
        remus: { commit: '2'.repeat(40), version: '2.130.1' },
        assets: [fixture.assetPath, 'assets/remus_wasm_bg-second.wasm']
      })
    );

    expect(() => resolveKernelArtifact(fixture.directory)).toThrow(
      'exactly one emitted Remus kernel WASM asset'
    );
  });
});
