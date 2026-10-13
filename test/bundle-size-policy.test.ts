import { describe, expect, it } from 'vitest';
import {
  evaluateKernelFirstOperation,
  evaluateKernelLoad,
  evaluateKernelLoadRegression,
  evaluateKernelPinGrowth,
  evaluateKernelWasm,
  KERNEL_FIRST_OPERATION_POLICY,
  KERNEL_LOAD_POLICY,
  KERNEL_WASM_POLICY,
  LAZY_ENTRY_PATTERNS,
  measureKernelWasm
} from '../scripts/bundle-size-policy.mjs';

function metrics(
  overrides: Partial<ReturnType<typeof measureKernelWasm>> = {}
) {
  return {
    rawBytes: 8 * 1024 * 1024,
    gzipBytes: 2_750_000,
    brotliBytes: 2_000_000,
    ...overrides
  };
}

describe('kernel WASM size policy', () => {
  it('holds the approved ceiling step 1 thresholds', () => {
    const MIB = 1024 * 1024;
    expect(KERNEL_WASM_POLICY).toEqual({
      rawReviewBytes: 11 * MIB,
      rawHardBytes: 12 * MIB,
      gzipHardBytes: 4.5 * MIB,
      brotliReviewBytes: 3 * MIB,
      brotliQuality: 11,
      pinRawGrowthReviewBytes: 256 * 1024,
      pinRawGrowthReviewRatio: 0.03
    });
    expect(Object.isFrozen(KERNEL_WASM_POLICY)).toBe(true);
  });

  it('warns at the raw review threshold without failing', () => {
    const below = evaluateKernelWasm(
      metrics({ rawBytes: KERNEL_WASM_POLICY.rawReviewBytes - 1 })
    );
    const at = evaluateKernelWasm(
      metrics({ rawBytes: KERNEL_WASM_POLICY.rawReviewBytes })
    );

    expect(below.warnings).toEqual([]);
    expect(at.warnings.map(({ code }) => code)).toContain('kernel-raw-review');
    expect(at.failures).toEqual([]);
  });

  it('allows the exact raw hard limit and refuses one byte more', () => {
    expect(
      evaluateKernelWasm(metrics({ rawBytes: KERNEL_WASM_POLICY.rawHardBytes }))
        .failures
    ).toEqual([]);
    expect(
      evaluateKernelWasm(
        metrics({ rawBytes: KERNEL_WASM_POLICY.rawHardBytes + 1 })
      ).failures.map(({ code }) => code)
    ).toContain('kernel-raw-hard');
  });

  it('allows the exact gzip hard limit and refuses one byte more', () => {
    expect(
      evaluateKernelWasm(
        metrics({ gzipBytes: KERNEL_WASM_POLICY.gzipHardBytes })
      ).failures
    ).toEqual([]);
    expect(
      evaluateKernelWasm(
        metrics({ gzipBytes: KERNEL_WASM_POLICY.gzipHardBytes + 1 })
      ).failures.map(({ code }) => code)
    ).toContain('kernel-gzip-hard');
  });

  it('keeps the Brotli threshold advisory', () => {
    const result = evaluateKernelWasm(
      metrics({ brotliBytes: KERNEL_WASM_POLICY.brotliReviewBytes + 1 })
    );

    expect(result.warnings.map(({ code }) => code)).toContain(
      'kernel-brotli-review'
    );
    expect(result.failures).toEqual([]);
  });

  it('measures compression deterministically for fixed bytes', () => {
    const input = Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      Buffer.from('openzcad-remus-wasm-policy'.repeat(100))
    ]);

    expect(measureKernelWasm(input)).toEqual(measureKernelWasm(input));
  });

  it('refuses non-WASM input', () => {
    expect(() =>
      measureKernelWasm(Buffer.from('{"message":"Not Found"}'))
    ).toThrow('not a version 1 WebAssembly module');
  });
});

describe('kernel pin growth policy', () => {
  it('reviews an absolute increase over 256 KiB', () => {
    const before = metrics({ rawBytes: 10 * 1024 * 1024 });
    const after = metrics({
      rawBytes: before.rawBytes + KERNEL_WASM_POLICY.pinRawGrowthReviewBytes + 1
    });
    const result = evaluateKernelPinGrowth(before, after);

    expect(result.requiresReview).toBe(true);
    expect(result.triggers).toContain('raw growth exceeds 256 KiB');
    expect(result.triggers).not.toContain('raw growth exceeds 3%');
  });

  it('reviews a percentage increase over 3%', () => {
    const before = metrics({ rawBytes: 1024 * 1024 });
    const after = metrics({
      rawBytes:
        before.rawBytes +
        Math.floor(
          before.rawBytes * KERNEL_WASM_POLICY.pinRawGrowthReviewRatio
        ) +
        1
    });
    const result = evaluateKernelPinGrowth(before, after);

    expect(result.requiresReview).toBe(true);
    expect(result.triggers).toContain('raw growth exceeds 3%');
    expect(result.triggers).not.toContain('raw growth exceeds 256 KiB');
  });

  it('does not review exact threshold values', () => {
    const before = metrics({ rawBytes: 20 * 1024 * 1024 });
    const after = metrics({
      rawBytes: before.rawBytes + KERNEL_WASM_POLICY.pinRawGrowthReviewBytes
    });

    expect(evaluateKernelPinGrowth(before, after).requiresReview).toBe(false);
  });
});

/**
 * The launcher HTML must never reference these.
 *
 * `report-bundle-sizes.mjs --check` fails the build when `index.html` carries
 * a `<script>` or `modulepreload` for one of them, which is the only thing
 * standing between a gesture-loaded asset and first paint. A disposable worker
 * is reached through `new Worker(new URL(...))`, so nothing else would notice
 * the day one became statically reachable — the entry has to be listed.
 */
describe('lazy entry patterns', () => {
  it.each([
    'assets/meshImportWorker-nqCWfpSW.js',
    'assets/shaprImportWorker-CCF_vbm3.js'
  ])('covers the disposable import worker %s', (file) => {
    expect(LAZY_ENTRY_PATTERNS.some((pattern) => pattern.test(file))).toBe(
      true
    );
  });

  it('covers an anonymous shared workspace chunk', () => {
    // `src-*` is what rolldown names a shared chunk nobody routed in
    // `manualChunks`. One of those in first paint cannot be told apart from
    // app code leaking into it, so it is refused and given a name instead.
    expect(
      LAZY_ENTRY_PATTERNS.some((pattern) =>
        pattern.test('assets/src-Ct489S1b.js')
      )
    ).toBe(true);
  });

  it('leaves the launcher entry and its named shared chunks alone', () => {
    for (const file of [
      'assets/index-CIzyUy_T.js',
      'assets/model-hjLE45zS.js',
      'assets/geometry-JS2c2obt.js',
      'assets/react-Cki3SpjL.js'
    ]) {
      expect(LAZY_ENTRY_PATTERNS.some((pattern) => pattern.test(file))).toBe(
        false
      );
    }
  });
});

describe('kernel load-time review budgets', () => {
  for (const profile of ['desktop', 'mobile'] as const) {
    it(`accepts the exact ${profile} budgets and reviews above them`, () => {
      const budgets = KERNEL_LOAD_POLICY.profiles[profile];
      const at = evaluateKernelLoad(profile, {
        coldReadyP95Ms: budgets.coldReadyP95Ms,
        warmReadyP95Ms: budgets.warmReadyP95Ms
      });
      const above = evaluateKernelLoad(profile, {
        coldReadyP95Ms: budgets.coldReadyP95Ms + 0.01,
        warmReadyP95Ms: budgets.warmReadyP95Ms + 0.01
      });

      expect(at.warnings).toEqual([]);
      expect(above.warnings.map(({ code }) => code)).toEqual([
        `kernel-load-${profile}-cold-review`,
        `kernel-load-${profile}-warm-review`
      ]);
    });
  }

  it('never loosens the proposed load targets', () => {
    expect(KERNEL_LOAD_POLICY.minimumRuns).toBeGreaterThanOrEqual(20);
    expect(
      KERNEL_LOAD_POLICY.profiles.desktop.coldReadyP95Ms
    ).toBeLessThanOrEqual(2000);
    expect(
      KERNEL_LOAD_POLICY.profiles.mobile.coldReadyP95Ms
    ).toBeLessThanOrEqual(5000);
    expect(
      KERNEL_LOAD_POLICY.profiles.desktop.warmReadyP95Ms
    ).toBeLessThanOrEqual(500);
    expect(
      KERNEL_LOAD_POLICY.profiles.mobile.warmReadyP95Ms
    ).toBeLessThanOrEqual(500);
  });

  it('refuses a missing measurement or an unknown profile', () => {
    expect(() =>
      evaluateKernelLoad('desktop', { coldReadyP95Ms: null, warmReadyP95Ms: 1 })
    ).toThrow('no p95 measurement');
    expect(() =>
      evaluateKernelLoad('tablet', { coldReadyP95Ms: 1, warmReadyP95Ms: 1 })
    ).toThrow('No kernel load budget');
  });
});

describe('kernel load regression review', () => {
  it('allows the larger of the ratio and the floor over the baseline', () => {
    const { ratio, floorMs } = KERNEL_LOAD_POLICY.regression.mobile;
    const slow = 10_000;
    const fast = floorMs / ratio / 2;
    const result = evaluateKernelLoadRegression(
      'mobile',
      { coldReadyP50Ms: slow, warmReadyP50Ms: fast },
      { coldReadyP50Ms: slow * (1 + ratio), warmReadyP50Ms: fast + floorMs }
    );

    expect(result.results.map(({ allowedP50Ms }) => allowedP50Ms)).toEqual([
      slow * (1 + ratio),
      fast + floorMs
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('reviews a candidate beyond the allowance', () => {
    const { ratio, floorMs } = KERNEL_LOAD_POLICY.regression.desktop;
    const baseline = { coldReadyP50Ms: 1000, warmReadyP50Ms: 40 };
    const result = evaluateKernelLoadRegression('desktop', baseline, {
      coldReadyP50Ms: Math.max(1000 * (1 + ratio), 1000 + floorMs) + 1,
      warmReadyP50Ms: 40
    });

    expect(result.warnings.map(({ code }) => code)).toEqual([
      'kernel-load-desktop-cold-regression'
    ]);
  });
});

describe('kernel first-operation review budgets', () => {
  for (const profile of ['desktop', 'mobile'] as const) {
    it(`accepts the exact ${profile} budgets and reviews above them`, () => {
      const budgets = KERNEL_FIRST_OPERATION_POLICY[profile];
      const at = evaluateKernelFirstOperation(profile, budgets);
      const above = evaluateKernelFirstOperation(profile, {
        coldSolidP95Ms: budgets.coldSolidP95Ms + 0.01,
        warmSolidP95Ms: budgets.warmSolidP95Ms,
        coldSketchP95Ms: budgets.coldSketchP95Ms,
        warmSketchP95Ms: budgets.warmSketchP95Ms + 0.01
      });

      expect(at.warnings).toEqual([]);
      expect(above.warnings.map(({ code }) => code)).toEqual([
        `kernel-first-op-${profile}-cold-solid-review`,
        `kernel-first-op-${profile}-warm-sketch-review`
      ]);
    });
  }

  it('refuses a missing measurement or an unknown profile', () => {
    expect(() =>
      evaluateKernelFirstOperation('desktop', {
        coldSolidP95Ms: 1,
        warmSolidP95Ms: null,
        coldSketchP95Ms: 1,
        warmSketchP95Ms: 1
      })
    ).toThrow('warmSolidP95Ms has no p95 measurement');
    expect(() =>
      evaluateKernelFirstOperation('tablet', {
        coldSolidP95Ms: 1,
        warmSolidP95Ms: 1,
        coldSketchP95Ms: 1,
        warmSketchP95Ms: 1
      })
    ).toThrow('No first-operation budget');
  });
});
