import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync
} from 'node:zlib';

const MIB = 1024 * 1024;
const WASM_HEADER = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00
]);

export const KERNEL_WASM_ASSET_PATTERN =
  /^assets\/(?:remus|brepkit)_wasm_bg-.*\.wasm$/;

/**
 * The file-format translator module (STEP, IGES, STL, 3MF, OBJ, PLY, glTF),
 * fetched only around an import or export. It is outside the kernel policy
 * above by construction; `report-bundle-sizes.mjs` holds its lazy-asset
 * budget.
 */
export const TRANSLATOR_WASM_ASSET_PATTERN =
  /^assets\/remus_wasm_io_bg-.*\.wasm$/;

/**
 * Assets that must never be referenced by the launcher HTML.
 *
 * These are the workspace chunks and runtime assets that exist only behind a
 * gesture — a workspace, a thumbnail, an import, a PDF. A `<script>` or
 * `<link rel="modulepreload">` for any of them in `index.html` means first
 * paint now pays for them, whether through a new static import or through a
 * shared chunk rolldown hoisted out of the entry. `src-*` is the anonymous
 * chunk name: an unnamed shared chunk in first paint cannot be told apart
 * from app code leaking into it, so a deliberate shared dependency gets a
 * name in the Vite config's `manualChunks` instead.
 *
 * Every disposable worker belongs here: a worker is reached through
 * `new Worker(new URL(...))`, so nothing but this list notices the day one of
 * them also becomes statically reachable.
 */
export const LAZY_ENTRY_PATTERNS = [
  /^assets\/(?:three|three-addons)-.*\.js$/,
  /^assets\/(?:ViewerShell|partThumbnail|pdf|exact|src)-.*\.js$/,
  KERNEL_WASM_ASSET_PATTERN,
  TRANSLATOR_WASM_ASSET_PATTERN,
  /^assets\/sqlite3-.*\.wasm$/,
  /^assets\/shaprImportWorker-.*\.js$/,
  /^assets\/meshImportWorker-.*\.js$/
];

/**
 * Kernel byte thresholds. Ceiling step 1 (2026-10) raised them from
 * 9 / 10 / 3.5 / 2.5 MiB; the evidence record is in
 * `docs/kernel-wasm-size-policy.md`. Remus mirrors these values in its
 * `scripts/wasm-size-policy.mjs`; change both together.
 */
export const KERNEL_WASM_POLICY = Object.freeze({
  rawReviewBytes: 11 * MIB,
  rawHardBytes: 12 * MIB,
  gzipHardBytes: 4.5 * MIB,
  brotliReviewBytes: 3 * MIB,
  brotliQuality: 11,
  pinRawGrowthReviewBytes: 256 * 1024,
  pinRawGrowthReviewRatio: 0.03
});

export function measureKernelWasm(contents) {
  if (
    contents.byteLength < WASM_HEADER.byteLength ||
    WASM_HEADER.some((byte, index) => contents[index] !== byte)
  ) {
    throw new Error('Kernel size input is not a version 1 WebAssembly module');
  }

  return {
    rawBytes: contents.byteLength,
    gzipBytes: gzipSync(contents).byteLength,
    brotliBytes: brotliCompressSync(contents, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: KERNEL_WASM_POLICY.brotliQuality
      }
    }).byteLength
  };
}

export function evaluateKernelWasm(metrics) {
  const warnings = [];
  const failures = [];

  if (metrics.rawBytes >= KERNEL_WASM_POLICY.rawReviewBytes) {
    warnings.push({
      code: 'kernel-raw-review',
      metric: 'raw bytes',
      bytes: metrics.rawBytes,
      budgetBytes: KERNEL_WASM_POLICY.rawReviewBytes,
      reason: 'Exact geometry kernel requires a size review'
    });
  }
  if (metrics.brotliBytes > KERNEL_WASM_POLICY.brotliReviewBytes) {
    warnings.push({
      code: 'kernel-brotli-review',
      metric: `Brotli q${KERNEL_WASM_POLICY.brotliQuality} bytes`,
      bytes: metrics.brotliBytes,
      budgetBytes: KERNEL_WASM_POLICY.brotliReviewBytes,
      reason: 'Exact geometry kernel requires a compressed-size review'
    });
  }
  if (metrics.rawBytes > KERNEL_WASM_POLICY.rawHardBytes) {
    failures.push({
      code: 'kernel-raw-hard',
      metric: 'raw bytes',
      bytes: metrics.rawBytes,
      budgetBytes: KERNEL_WASM_POLICY.rawHardBytes,
      reason: 'Exact geometry kernel exceeds its raw hard limit'
    });
  }
  if (metrics.gzipBytes > KERNEL_WASM_POLICY.gzipHardBytes) {
    failures.push({
      code: 'kernel-gzip-hard',
      metric: 'gzip bytes',
      bytes: metrics.gzipBytes,
      budgetBytes: KERNEL_WASM_POLICY.gzipHardBytes,
      reason: 'Exact geometry kernel exceeds its gzip hard limit'
    });
  }

  return { warnings, failures };
}

function delta(before, after) {
  return after - before;
}

function percent(deltaBytes, baselineBytes) {
  return baselineBytes > 0 ? deltaBytes / baselineBytes : null;
}

export function evaluateKernelPinGrowth(before, after) {
  const rawDeltaBytes = delta(before.rawBytes, after.rawBytes);
  const rawDeltaRatio = percent(rawDeltaBytes, before.rawBytes);
  const gzipDeltaBytes = delta(before.gzipBytes, after.gzipBytes);
  const gzipDeltaRatio = percent(gzipDeltaBytes, before.gzipBytes);
  const brotliDeltaBytes = delta(before.brotliBytes, after.brotliBytes);
  const brotliDeltaRatio = percent(brotliDeltaBytes, before.brotliBytes);
  const triggers = [];

  if (rawDeltaBytes > KERNEL_WASM_POLICY.pinRawGrowthReviewBytes) {
    triggers.push('raw growth exceeds 256 KiB');
  }
  if (
    rawDeltaRatio !== null &&
    rawDeltaRatio > KERNEL_WASM_POLICY.pinRawGrowthReviewRatio
  ) {
    triggers.push('raw growth exceeds 3%');
  }

  return {
    requiresReview: triggers.length > 0,
    triggers,
    rawDeltaBytes,
    rawDeltaRatio,
    gzipDeltaBytes,
    gzipDeltaRatio,
    brotliDeltaBytes,
    brotliDeltaRatio
  };
}

export function kernelPolicyToolchain() {
  return {
    node: process.versions.node,
    zlib: process.versions.zlib,
    brotli: process.versions.brotli ?? null,
    brotliQuality: KERNEL_WASM_POLICY.brotliQuality
  };
}

/**
 * Kernel load-time review budgets: p95 of kernel-ready in milliseconds over
 * at least `minimumRuns` samples of `scripts/measure-remus-wasm-load.mjs`.
 * Each budget is the worst p95 measured for remus-wasm 2026.1.53 and
 * 2026.1.56 on the reference host plus max(25 ms, 5%), rounded up, and never
 * above the proposed 2 s / 5 s / 0.5 s targets. `regression` is the allowed
 * median growth over the current pin, measured on one host with alternating
 * samples. Evidence: `docs/kernel-wasm-size-policy.md`.
 */
export const KERNEL_LOAD_POLICY = Object.freeze({
  minimumRuns: 20,
  profiles: Object.freeze({
    desktop: Object.freeze({
      coldReadyP95Ms: 110,
      warmReadyP95Ms: 110
    }),
    mobile: Object.freeze({
      coldReadyP95Ms: 3800,
      warmReadyP95Ms: 150
    })
  }),
  regression: Object.freeze({
    desktop: Object.freeze({ ratio: 0.05, floorMs: 10 }),
    mobile: Object.freeze({ ratio: 0.05, floorMs: 10 })
  })
});

/**
 * First-operation review budgets: p95 milliseconds of the first call of the
 * harness's representative solid edit and sketch solve after kernel-ready
 * (`--first-operation`), which carries V8's lazy WebAssembly compilation,
 * taken from the samples in which that workload ran first. Each is the worst
 * p95 measured for remus-wasm 2026.1.53 and 2026.1.57 on the reference host
 * plus max(25 ms, 5%), rounded up to 10 ms. Evidence:
 * `docs/kernel-wasm-size-policy.md`.
 */
export const KERNEL_FIRST_OPERATION_POLICY = Object.freeze({
  desktop: Object.freeze({
    coldSolidP95Ms: 130,
    warmSolidP95Ms: 40,
    coldSketchP95Ms: 30,
    warmSketchP95Ms: 30
  }),
  mobile: Object.freeze({
    coldSolidP95Ms: 630,
    warmSolidP95Ms: 80,
    coldSketchP95Ms: 60,
    warmSketchP95Ms: 30
  })
});

export function evaluateKernelFirstOperation(profile, metrics) {
  const budgets = KERNEL_FIRST_OPERATION_POLICY[profile];
  if (!budgets) {
    throw new Error(`No first-operation budget for profile ${profile}`);
  }
  const results = [
    ['cold', 'Solid', 'solid'],
    ['warm', 'Solid', 'solid'],
    ['cold', 'Sketch', 'sketch'],
    ['warm', 'Sketch', 'sketch']
  ].map(([phase, kind, slug]) => {
    const key = `${phase}${kind}P95Ms`;
    const p95Ms = metrics[key];
    if (!Number.isFinite(p95Ms)) {
      throw new Error(`${key} has no p95 measurement`);
    }
    return {
      code: `kernel-first-op-${profile}-${phase}-${slug}-review`,
      p95Ms,
      budgetMs: budgets[key],
      reason: `First ${slug} operation after a ${phase} load (${profile}) requires a load-time review`,
      withinBudget: p95Ms <= budgets[key]
    };
  });
  return {
    profile,
    results,
    warnings: results.filter((result) => !result.withinBudget)
  };
}

export function evaluateKernelLoad(profile, metrics) {
  const budgets = KERNEL_LOAD_POLICY.profiles[profile];
  if (!budgets) {
    throw new Error(`No kernel load budget for profile ${profile}`);
  }
  const results = [
    {
      code: `kernel-load-${profile}-cold-review`,
      p95Ms: metrics.coldReadyP95Ms,
      budgetMs: budgets.coldReadyP95Ms,
      reason: `Cold kernel-ready (${profile}) requires a load-time review`
    },
    {
      code: `kernel-load-${profile}-warm-review`,
      p95Ms: metrics.warmReadyP95Ms,
      budgetMs: budgets.warmReadyP95Ms,
      reason: `Warm kernel-ready (${profile}) requires a load-time review`
    }
  ].map((result) => {
    if (!Number.isFinite(result.p95Ms)) {
      throw new Error(`${result.code} has no p95 measurement`);
    }
    return { ...result, withinBudget: result.p95Ms <= result.budgetMs };
  });
  return {
    profile,
    results,
    warnings: results.filter((result) => !result.withinBudget)
  };
}

/**
 * Candidate-versus-baseline review for a kernel change measured on one host
 * with alternating samples (`--baseline-package`). It compares medians: on a
 * shared or hosted runner a p95 of 20–30 samples moves by tens of
 * milliseconds between identical kernels, while medians agree within a few.
 * Absolute p95 budgets are calibrated on reference hardware; this relative
 * check is what stays meaningful on a noisier or slower CI runner.
 */
export function evaluateKernelLoadRegression(profile, baseline, candidate) {
  const allowance = KERNEL_LOAD_POLICY.regression[profile];
  if (!allowance) {
    throw new Error(`No kernel load regression allowance for ${profile}`);
  }
  const results = ['cold', 'warm'].map((phase) => {
    const key = `${phase}ReadyP50Ms`;
    const baselineP50Ms = baseline[key];
    const candidateP50Ms = candidate[key];
    if (!Number.isFinite(baselineP50Ms) || !Number.isFinite(candidateP50Ms)) {
      throw new Error(`${phase} kernel-ready has no median measurement`);
    }
    const allowedP50Ms = Math.max(
      baselineP50Ms * (1 + allowance.ratio),
      baselineP50Ms + allowance.floorMs
    );
    return {
      code: `kernel-load-${profile}-${phase}-regression`,
      reason: `${phase === 'cold' ? 'Cold' : 'Warm'} kernel-ready (${profile}) is slower than the current pin`,
      baselineP50Ms,
      candidateP50Ms,
      allowedP50Ms,
      withinBudget: candidateP50Ms <= allowedP50Ms
    };
  });
  return {
    profile,
    results,
    warnings: results.filter((result) => !result.withinBudget)
  };
}
