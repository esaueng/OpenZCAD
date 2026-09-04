export interface KernelWasmMetrics {
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
}

export interface KernelSizeNotice {
  code: string;
  metric: string;
  bytes: number;
  budgetBytes: number;
  reason: string;
}

export interface KernelPinGrowth {
  requiresReview: boolean;
  triggers: string[];
  rawDeltaBytes: number;
  rawDeltaRatio: number | null;
  gzipDeltaBytes: number;
  gzipDeltaRatio: number | null;
  brotliDeltaBytes: number;
  brotliDeltaRatio: number | null;
}

export const KERNEL_WASM_ASSET_PATTERN: RegExp;

export const TRANSLATOR_WASM_ASSET_PATTERN: RegExp;

export const KERNEL_WASM_POLICY: Readonly<{
  rawReviewBytes: number;
  rawHardBytes: number;
  gzipHardBytes: number;
  brotliReviewBytes: number;
  brotliQuality: number;
  pinRawGrowthReviewBytes: number;
  pinRawGrowthReviewRatio: number;
}>;

export function measureKernelWasm(contents: Uint8Array): KernelWasmMetrics;

export function evaluateKernelWasm(metrics: KernelWasmMetrics): {
  warnings: KernelSizeNotice[];
  failures: KernelSizeNotice[];
};

export function evaluateKernelPinGrowth(
  before: KernelWasmMetrics,
  after: KernelWasmMetrics
): KernelPinGrowth;

export function kernelPolicyToolchain(): {
  node: string;
  zlib: string;
  brotli: string | null;
  brotliQuality: number;
};
