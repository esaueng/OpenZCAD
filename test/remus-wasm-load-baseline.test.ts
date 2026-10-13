import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KERNEL_LOAD_POLICY } from '../scripts/bundle-size-policy.mjs';
import {
  assertCacheProtocol,
  assertFirstOperationResults,
  firstOperationGatesApply,
  firstOperationOrder,
  LOAD_PROFILES,
  markdownSection,
  parseArgs,
  percentile,
  resolveKernelArtifact,
  resolveKernelGlue,
  resolvePackageArtifact,
  runBenchmark,
  summarize,
  summarizeFirstOperations
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

describe('Remus WASM first-operation phase', () => {
  const solid = { volume: 3867.86, triangles: 208 };
  const points: Array<[number, number]> = [
    [0, 0],
    [12, 0],
    [12, 8],
    [0, 8]
  ];
  const sketch = { converged: true, points, radius: 3 };
  const withPoint = (index: number, value: [number, number]) => ({
    ...sketch,
    points: points.map((point, i) => (i === index ? value : point))
  });
  const result = (overrides = {}) => ({
    order: 'solid-first' as const,
    solidFirstMs: 60,
    solidSecondMs: 5,
    sketchFirstMs: 4,
    sketchSecondMs: 0.1,
    solid: [solid, solid],
    sketch: [sketch, sketch],
    ...overrides
  });

  it('is off by default and enabled by --first-operation', () => {
    expect(parseArgs([]).firstOperations).toBe(false);
    expect(parseArgs(['--first-operation']).firstOperations).toBe(true);
  });

  it('accepts the reference solid and sketch results', () => {
    expect(() => assertFirstOperationResults(result())).not.toThrow();
  });

  it('refuses a refused fillet or an unconverged sketch', () => {
    expect(() =>
      assertFirstOperationResults(
        result({ solid: [solid, { volume: 3870.04, triangles: 78 }] })
      )
    ).toThrow('expected 3867.86');
    expect(() =>
      assertFirstOperationResults(
        result({ solid: [{ volume: Number.NaN, triangles: 0 }, solid] })
      )
    ).toThrow('First-operation solid workload');
    expect(() =>
      assertFirstOperationResults(
        result({ sketch: [sketch, { ...sketch, converged: false }] })
      )
    ).toThrow('did not solve to the 12 x 8 rectangle');
  });

  it('refuses an ignored radius or rectangle constraint and non-finite values', () => {
    const bad = [
      { ...sketch, radius: 2 },
      { ...sketch, radius: Number.NaN },
      // The last two edges unconstrained: p[2] still lands on (12, 8).
      withPoint(3, [-1, 6]),
      withPoint(1, [12, 0.5]),
      withPoint(2, [Number.NaN, 8]),
      withPoint(0, [0, Number.NaN]),
      { ...sketch, points: points.slice(0, 3) }
    ];
    for (const sample of bad) {
      expect(() =>
        assertFirstOperationResults(result({ sketch: [sketch, sample] }))
      ).toThrow('did not solve to the 12 x 8 rectangle with radius 3');
    }
  });
});

describe('Remus WASM first-operation gate sample minimum', () => {
  it('evaluates the gates only when each workload order has a full p95 sample', () => {
    const minimum = 2 * KERNEL_LOAD_POLICY.minimumRuns;
    expect([1, 2, 3, minimum - 1].map(firstOperationGatesApply)).toEqual([
      false,
      false,
      false,
      false
    ]);
    expect(firstOperationGatesApply(minimum)).toBe(true);
    expect(firstOperationGatesApply(minimum + 1)).toBe(true);
  });
});

describe('Remus WASM first-operation order', () => {
  it('alternates the workload order every two samples', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(firstOperationOrder)).toEqual([
      'solid-first',
      'solid-first',
      'sketch-first',
      'sketch-first',
      'solid-first',
      'solid-first',
      'sketch-first',
      'sketch-first'
    ]);
  });

  it('reads each first call only from samples where it ran first', () => {
    const run = (
      order: 'solid-first' | 'sketch-first',
      solid: number,
      sketch: number
    ) => ({
      order,
      solidFirstMs: solid,
      solidSecondMs: 5,
      sketchFirstMs: sketch,
      sketchSecondMs: 1,
      solid: [],
      sketch: []
    });
    const sample = (first: ReturnType<typeof run>) => ({
      kernelReady: {
        cold: { firstOperations: first },
        warm: { firstOperations: first }
      }
    });
    const summary = summarizeFirstOperations(
      [sample(run('solid-first', 60, 4)), sample(run('sketch-first', 55, 20))],
      'cold'
    );

    expect(summary).toMatchObject({
      solidFirstSamples: 1,
      sketchFirstSamples: 1,
      solidFirstMs: { median: 60 },
      solidAfterSketchMs: { median: 55 },
      sketchFirstMs: { median: 20 },
      sketchAfterSolidMs: { median: 4 },
      solidOverheadMs: { median: 55 },
      sketchOverheadMs: { median: 19 }
    });
  });

  it('needs twenty samples per order before it checks budgets', () => {
    expect(() =>
      parseArgs(['--first-operation', '--check', '--runs', '20'])
    ).toThrow('at least 40 runs');
    expect(
      parseArgs(['--first-operation', '--check', '--runs', '40']).runs
    ).toBe(40);
  });
});

describe('Remus WASM first-operation Markdown', () => {
  const ready = (median: number, p95: number) => ({ readyMs: { median, p95 } });
  const measured = (median: number, p95: number) => ({ median, p95 });

  it('reports an over-budget first operation and never passes an unevaluated gate', () => {
    const section = markdownSection({
      protocol: { profile: 'mobile', runs: 40 },
      provenance: { remusVersion: '2026.1.57' },
      summary: {
        kernelReady: { cold: ready(3300, 3460), warm: ready(100, 187) },
        firstOperation: {
          cold: {
            solidFirstMs: measured(300, 700),
            sketchFirstMs: measured(20, 42)
          },
          warm: {
            solidFirstMs: measured(27, 51),
            sketchFirstMs: measured(0.9, 3.1)
          }
        }
      },
      gates: null,
      firstOperationGates: {
        results: [
          {
            code: 'kernel-first-op-mobile-cold-solid-review',
            budgetMs: 630,
            withinBudget: false
          },
          {
            code: 'kernel-first-op-mobile-warm-solid-review',
            budgetMs: 80,
            withinBudget: true
          },
          {
            code: 'kernel-first-op-mobile-cold-sketch-review',
            budgetMs: 70,
            withinBudget: true
          },
          {
            code: 'kernel-first-op-mobile-warm-sketch-review',
            budgetMs: 30,
            withinBudget: true
          }
        ]
      },
      baseline: null,
      regression: null
    });

    expect(section).toContain(
      '| cold | 3300 ms | 3460 ms | — | not evaluated |'
    );
    expect(section).not.toMatch(
      /\| (?:cold|warm) \| \d+ ms \| \d+ ms \| — \| ok \|/
    );
    expect(section).toContain(
      '| cold | Solid edit | 300 ms | 700 ms | 630 ms | **review: over budget** |'
    );
    expect(section).toContain(
      '| warm | Solid edit | 27 ms | 51 ms | 80 ms | ok |'
    );
    expect(section).toContain(
      '| cold | Sketch solve | 20 ms | 42 ms | 70 ms | ok |'
    );
  });

  it('marks first operations without gates as not evaluated', () => {
    const section = markdownSection({
      protocol: { profile: 'desktop', runs: 4 },
      provenance: { remusVersion: '2026.1.57' },
      summary: {
        kernelReady: { cold: ready(34, 42), warm: ready(40, 47) },
        firstOperation: {
          cold: {
            solidFirstMs: measured(65, 68),
            sketchFirstMs: measured(4, 4)
          },
          warm: {
            solidFirstMs: measured(6, 6),
            sketchFirstMs: measured(0.2, 0.2)
          }
        }
      },
      gates: null,
      firstOperationGates: null,
      baseline: null,
      regression: null
    });

    expect(section).toContain(
      '| cold | Solid edit | 65 ms | 68 ms | — | not evaluated |'
    );
    expect(section).not.toContain('| ok |');
  });
});
