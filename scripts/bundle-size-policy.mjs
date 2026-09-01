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

export const KERNEL_WASM_POLICY = Object.freeze({
  rawReviewBytes: 9 * MIB,
  rawHardBytes: 10 * MIB,
  gzipHardBytes: 3.5 * MIB,
  brotliReviewBytes: 2.5 * MIB,
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
