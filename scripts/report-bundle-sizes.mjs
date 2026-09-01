import { gzipSync } from 'node:zlib';
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateKernelWasm,
  KERNEL_WASM_ASSET_PATTERN,
  KERNEL_WASM_POLICY,
  kernelPolicyToolchain,
  measureKernelWasm
} from './bundle-size-policy.mjs';

const DIST = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const REPORTED_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.wasm']);
const CHECK = process.argv.includes('--check');
// 2026-08-19: raised from 500 KiB with the index entry chunk at 511,809
// bytes — 99.96% of the old budget — so that a one-line fix no longer trips
// the gate. The tripwire against runaway growth stays; the next raise should
// come with an actual split of the entry chunk, not another bump.
//
// 2026-08-22: that split happened — settings, the sharing and export dialogs,
// the inspector forms and the demo builders now load on the gesture that needs
// them — taking the entry chunk from 517,965 bytes to 395,469. The 12 KiB of
// slack borrowed above is given back rather than banked as new room to grow
// into: a budget only reports something when its edge is somewhere the code
// can actually reach.
const DEFAULT_RAW_BUDGET = 500 * 1024;
const APPROVED_LAZY_ASSETS = [
  {
    pattern: /^assets\/three-.*\.js$/,
    maxBytes: 600 * 1024,
    reason: '3D engine, loaded only for a workspace or non-empty thumbnail'
  },
  {
    pattern: /^assets\/pdf\.worker\.min-.*\.js$/,
    maxBytes: 1_300 * 1024,
    reason: 'PDF parsing worker, loaded only for PDF attachments'
  },
  {
    pattern: KERNEL_WASM_ASSET_PATTERN,
    reviewBytes: KERNEL_WASM_POLICY.rawReviewBytes,
    maxBytes: KERNEL_WASM_POLICY.rawHardBytes,
    maxGzipBytes: KERNEL_WASM_POLICY.gzipHardBytes,
    reviewBrotliBytes: KERNEL_WASM_POLICY.brotliReviewBytes,
    reason: 'Exact geometry kernel, loaded only for non-empty geometry'
  },
  {
    pattern: /^assets\/sqlite3-.*\.wasm$/,
    maxBytes: 1024 * 1024,
    reason: 'SQLite parser, loaded only in a one-shot Shapr3D import worker'
  }
];
const LAZY_ENTRY_PATTERNS = [
  /^assets\/(?:three|three-addons)-.*\.js$/,
  /^assets\/(?:ViewerShell|partThumbnail|pdf|exact|src)-.*\.js$/,
  KERNEL_WASM_ASSET_PATTERN,
  /^assets\/sqlite3-.*\.wasm$/,
  /^assets\/shaprImportWorker-.*\.js$/
];

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collect(path);
    }
    return REPORTED_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

const rows = collect(DIST)
  .map((path) => {
    const contents = readFileSync(path);
    const file = relative(DIST, path).replaceAll('\\', '/');
    if (KERNEL_WASM_ASSET_PATTERN.test(file)) {
      const measurement = measureKernelWasm(contents);
      return {
        file,
        bytes: measurement.rawBytes,
        gzipBytes: measurement.gzipBytes,
        brotliBytes: measurement.brotliBytes
      };
    }
    return {
      file,
      bytes: contents.byteLength,
      gzipBytes: gzipSync(contents).byteLength
    };
  })
  .sort(
    (left, right) =>
      right.bytes - left.bytes || left.file.localeCompare(right.file)
  );

const totals = rows.reduce(
  (sum, row) => ({
    bytes: sum.bytes + row.bytes,
    gzipBytes: sum.gzipBytes + row.gzipBytes
  }),
  { bytes: 0, gzipBytes: 0 }
);

const failures = rows.flatMap((row) => {
  if (KERNEL_WASM_ASSET_PATTERN.test(row.file)) {
    return evaluateKernelWasm({
      rawBytes: row.bytes,
      gzipBytes: row.gzipBytes,
      brotliBytes: row.brotliBytes
    }).failures.map((failure) => ({ file: row.file, ...failure }));
  }
  if (row.bytes <= DEFAULT_RAW_BUDGET) {
    return [];
  }
  const exception = APPROVED_LAZY_ASSETS.find(({ pattern }) =>
    pattern.test(row.file)
  );
  if (exception && row.bytes <= exception.maxBytes) {
    return [];
  }
  return [
    {
      file: row.file,
      bytes: row.bytes,
      budgetBytes: exception?.maxBytes ?? DEFAULT_RAW_BUDGET,
      reason: exception?.reason ?? 'No approved large-asset exception'
    }
  ];
});

const warnings = rows.flatMap((row) => {
  if (!KERNEL_WASM_ASSET_PATTERN.test(row.file)) {
    return [];
  }
  return evaluateKernelWasm({
    rawBytes: row.bytes,
    gzipBytes: row.gzipBytes,
    brotliBytes: row.brotliBytes
  }).warnings.map((warning) => ({ file: row.file, ...warning }));
});

const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8');
const initialAssets = Array.from(
  indexHtml.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g),
  (match) => match[1]
);
for (const file of initialAssets) {
  if (LAZY_ENTRY_PATTERNS.some((pattern) => pattern.test(file))) {
    failures.push({
      file,
      reason: 'Lazy workspace asset is referenced by the launcher HTML'
    });
  }
}

const metadata = JSON.parse(
  readFileSync(join(DIST, 'build-meta.json'), 'utf8')
);
if (
  metadata.format !== 'openzcad-build-metadata' ||
  metadata.formatVersion !== 2 ||
  !/^[0-9a-f]{40}$/i.test(metadata.commit) ||
  !/^[0-9a-f]{40}$/i.test(metadata.remus?.commit)
) {
  failures.push({
    file: 'build-meta.json',
    reason: 'Build provenance is missing or malformed'
  });
}

/**
 * How close each approved large asset is to its own ceiling.
 *
 * This REPORTS and does not gate — the pass/fail decision above is untouched.
 * It exists because a budget with a hard edge and no visible approach tells
 * you nothing until the day it fails, and that day lands on whoever happens
 * to push next rather than on whoever spent the headroom. The kernel has a
 * lower review threshold so approaching the hard edge is visible first.
 *
 * Growth is NOT uniform, which is why the raw number is more useful than any
 * rate: measured across one day of pin bumps, defect-fix kernel PRs cost
 * roughly 2 KB each while feature PRs cost two orders of magnitude more. An
 * extrapolated "days remaining" from a mixed sample is misleading in both
 * directions, so none is computed here.
 *
 * An asset over its ceiling already appears in `failures`; this array is
 * about the ones that are fine today.
 */
const headroom = rows.flatMap((row) => {
  const exception = APPROVED_LAZY_ASSETS.find(({ pattern }) =>
    pattern.test(row.file)
  );
  if (!exception) {
    return [];
  }
  return [
    {
      file: row.file,
      bytes: row.bytes,
      gzipBytes: row.gzipBytes,
      ...(row.brotliBytes === undefined
        ? {}
        : { brotliBytes: row.brotliBytes }),
      ...(exception.reviewBytes === undefined
        ? {}
        : {
            reviewBytes: exception.reviewBytes,
            reviewRemainingBytes: exception.reviewBytes - row.bytes
          }),
      maxBytes: exception.maxBytes,
      remainingBytes: exception.maxBytes - row.bytes,
      usedPercent: Number(((row.bytes / exception.maxBytes) * 100).toFixed(2)),
      ...(exception.maxGzipBytes === undefined
        ? {}
        : {
            maxGzipBytes: exception.maxGzipBytes,
            gzipRemainingBytes: exception.maxGzipBytes - row.gzipBytes
          }),
      ...(exception.reviewBrotliBytes === undefined
        ? {}
        : {
            reviewBrotliBytes: exception.reviewBrotliBytes,
            brotliReviewRemainingBytes:
              exception.reviewBrotliBytes - row.brotliBytes
          })
    }
  ];
});

const report = {
  budgets: {
    defaultRawBytes: DEFAULT_RAW_BUDGET,
    approvedLazyAssets: APPROVED_LAZY_ASSETS.map(
      ({
        pattern,
        reviewBytes,
        maxBytes,
        maxGzipBytes,
        reviewBrotliBytes,
        reason
      }) => ({
        pattern: pattern.source,
        ...(reviewBytes === undefined ? {} : { reviewBytes }),
        maxBytes,
        ...(maxGzipBytes === undefined ? {} : { maxGzipBytes }),
        ...(reviewBrotliBytes === undefined ? {} : { reviewBrotliBytes }),
        reason
      })
    )
  },
  kernelMeasurementToolchain: kernelPolicyToolchain(),
  headroom,
  initialAssets,
  provenance: {
    commit: metadata.commit,
    remus: metadata.remus
  },
  rows,
  totals,
  warnings,
  failures
};
const reportJson = `${JSON.stringify(report, null, 2)}\n`;

process.stdout.write(reportJson);

if (process.env.OPENZCAD_BUNDLE_REPORT_PATH) {
  writeFileSync(process.env.OPENZCAD_BUNDLE_REPORT_PATH, reportJson);
}

function annotationEscape(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

if (process.env.GITHUB_ACTIONS === 'true') {
  for (const warning of warnings) {
    process.stderr.write(
      `::warning title=Kernel WASM size review::${annotationEscape(`${warning.file}: ${warning.metric} ${warning.bytes} reached review threshold ${warning.budgetBytes}`)}\n`
    );
  }
  for (const failure of failures) {
    process.stderr.write(
      `::error title=Bundle size budget exceeded::${annotationEscape(`${failure.file}: ${failure.metric ?? 'raw bytes'} ${failure.bytes ?? 'unknown'} exceeded ${failure.budgetBytes ?? 'its policy'}`)}\n`
    );
  }
}

if (
  process.env.OPENZCAD_BUNDLE_GITHUB_SUMMARY === '1' &&
  process.env.GITHUB_STEP_SUMMARY
) {
  const kernel = headroom.find(({ file }) =>
    KERNEL_WASM_ASSET_PATTERN.test(file)
  );
  if (kernel) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Kernel WASM size\n\n| Raw | Gzip | Brotli q${KERNEL_WASM_POLICY.brotliQuality} | Raw review | Raw hard | Gzip hard |\n| ---: | ---: | ---: | ---: | ---: | ---: |\n| ${kernel.bytes} B | ${kernel.gzipBytes} B | ${kernel.brotliBytes} B | ${kernel.reviewBytes} B | ${kernel.maxBytes} B | ${kernel.maxGzipBytes} B |\n\nWarnings: ${warnings.length}; failures: ${failures.length}.\n\n`
    );
  }
}

if (CHECK && failures.length > 0) {
  process.exitCode = 1;
}
