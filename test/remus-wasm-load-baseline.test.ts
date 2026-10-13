import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCacheProtocol,
  LOAD_PROFILES,
  markdownSection,
  parseArgs,
  percentile,
  resolveKernelArtifact,
  resolveKernelGlue,
  resolvePackageArtifact,
  runBenchmark,
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

function remusPackage(version = '2026.1.55') {
  const directory = mkdtempSync(join(tmpdir(), 'openzcad-wasm-package-'));
  temporaryDirectories.push(directory);
  const bytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  writeFileSync(join(directory, 'remus_wasm_bg.wasm'), bytes);
  writeFileSync(join(directory, 'remus_wasm_bg.js'), 'export {};\n');
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'remus-wasm', version })
  );
  return { directory, bytes };
}

describe('Remus WASM load packages and glue', () => {
  it('measures a remus-wasm package directory without a build', () => {
    const fixture = remusPackage();

    const artifact = resolvePackageArtifact(fixture.directory);

    expect(artifact.source).toBe('package');
    expect(artifact.remusVersion).toBe('2026.1.55');
    expect(artifact.bytes).toEqual(fixture.bytes);
    expect(
      resolveKernelGlue(fixture.directory, artifact.sha256).toString()
    ).toBe('export {};\n');
  });

  it('refuses glue from a package whose WASM differs from the asset', () => {
    const fixture = remusPackage();

    expect(() => resolveKernelGlue(fixture.directory, '0'.repeat(64))).toThrow(
      'does not match the measured kernel asset'
    );
  });

  it('refuses a directory that is not the remus-wasm package', () => {
    const fixture = remusPackage();
    writeFileSync(
      join(fixture.directory, 'package.json'),
      JSON.stringify({ name: 'remus-wasm-io', version: '1' })
    );

    expect(() => resolvePackageArtifact(fixture.directory)).toThrow(
      'not a remus-wasm package directory'
    );
  });
});

describe('Remus WASM load arguments and protocol', () => {
  it('defaults to the desktop profile, gzip transfer and module phases', () => {
    const args = parseArgs([]);

    expect(args.profile).toBe('desktop');
    expect(args.encoding).toBe('gzip');
    expect(args.modulePhases).toBe(true);
    expect(args.runs).toBe(20);
    expect(LOAD_PROFILES.desktop).toEqual({
      cpuThrottlingRate: 1,
      network: null
    });
    expect(LOAD_PROFILES.mobile).toEqual({
      cpuThrottlingRate: 4,
      network: {
        latencyMs: 150,
        downloadBitsPerSecond: 9_000_000,
        uploadBitsPerSecond: 1_500_000
      }
    });
  });

  it('rejects unknown profiles and under-sampled gate runs', () => {
    expect(() => parseArgs(['--profile', 'tablet'])).toThrow('--profile');
    expect(() => parseArgs(['--encoding', 'br'])).toThrow('--encoding');
    expect(() => parseArgs(['--check', '--runs', '5'])).toThrow(
      'at least 20 runs'
    );
    expect(() =>
      parseArgs(['--baseline-package', '.', '--runs', '19'])
    ).toThrow('at least 20 runs');
    expect(parseArgs(['--check', '--kernel-ready-only']).modulePhases).toBe(
      false
    );
  });

  it('refuses samples whose cache state contradicts cold or warm', () => {
    const sample = (cold: number, warm: number) => ({
      kernelReady: {
        cold: { networkRequests: cold },
        warm: { networkRequests: warm }
      }
    });

    expect(() => assertCacheProtocol([sample(1, 0)])).not.toThrow();
    expect(() => assertCacheProtocol([sample(0, 0)])).toThrow(
      'cold kernel-ready'
    );
    expect(() => assertCacheProtocol([sample(1, 1)])).toThrow(
      'warm kernel-ready'
    );
  });
});

describe('Remus WASM load pull-request section', () => {
  const ready = (median: number, p95: number) => ({
    readyMs: { median, p95 }
  });

  it('flags a candidate over budget and slower than the pin', () => {
    const section = markdownSection({
      protocol: { profile: 'mobile', runs: 20 },
      provenance: { remusVersion: '2026.1.56' },
      summary: {
        kernelReady: { cold: ready(3600, 3900), warm: ready(80, 90) }
      },
      gates: {
        results: [
          {
            code: 'kernel-load-mobile-cold-review',
            budgetMs: 3700,
            withinBudget: false
          },
          {
            code: 'kernel-load-mobile-warm-review',
            budgetMs: 150,
            withinBudget: true
          }
        ]
      },
      baseline: {
        provenance: { remusVersion: '2026.1.53' },
        summary: {
          kernelReady: { cold: ready(3450, 3500), warm: ready(80, 95) }
        }
      },
      regression: {
        results: [
          {
            code: 'kernel-load-mobile-cold-regression',
            allowedP50Ms: 3850,
            withinBudget: false
          },
          {
            code: 'kernel-load-mobile-warm-regression',
            allowedP50Ms: 110,
            withinBudget: true
          }
        ]
      }
    });

    expect(section).toContain('### Kernel load time: mobile profile');
    expect(section).toContain(
      '`remus-wasm` 2026.1.53 (current pin) against 2026.1.56'
    );
    expect(section).toContain(
      '| cold | 3450 ms | 3600 ms | 3500 ms | 3900 ms | 3850 ms | 3700 ms | **review: over budget, slower than pin** |'
    );
    expect(section).toContain(
      '| warm | 80 ms | 80 ms | 95 ms | 90 ms | 110 ms | 150 ms | ok |'
    );
    expect(section).toContain('| --- | ---: |');
  });
});

describe('Remus WASM load benchmark setup failures', () => {
  const listeningServers = () =>
    process
      .getActiveResourcesInfo()
      .filter((resource) => resource === 'TCPServerWrap').length;

  it.each([
    ['missing', () => join(remusPackage().directory, 'absent')],
    [
      'not a WebAssembly module',
      () => {
        const fixture = remusPackage();
        writeFileSync(join(fixture.directory, 'remus_wasm_bg.wasm'), 'text');
        return fixture.directory;
      }
    ],
    [
      'not the remus-wasm package',
      () => {
        const fixture = remusPackage();
        writeFileSync(
          join(fixture.directory, 'package.json'),
          JSON.stringify({ name: 'remus-wasm-io', version: '1' })
        );
        return fixture.directory;
      }
    ]
  ])(
    'rejects a %s baseline and closes the candidate server',
    async (_label, baselineDirectory) => {
      const candidate = remusPackage();
      const args = parseArgs([
        '--package',
        candidate.directory,
        '--baseline-package',
        baselineDirectory(),
        '--runs',
        '20',
        '--kernel-ready-only'
      ]);
      const before = listeningServers();

      // Before the fix the candidate server stayed open and kept the
      // process alive; the rejection must come promptly and leave nothing
      // listening.
      await expect(runBenchmark(args)).rejects.toThrow();
      // libuv releases a closed server handle a few loop turns later; an
      // unclosed one never goes away.
      const deadline = Date.now() + 1_000;
      while (listeningServers() > before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(listeningServers()).toBe(before);
    },
    5_000
  );
});
