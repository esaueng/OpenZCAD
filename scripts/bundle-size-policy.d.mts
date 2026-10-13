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

export const LAZY_ENTRY_PATTERNS: RegExp[];

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

export interface KernelLoadMetrics {
  coldReadyP95Ms: number | null;
  warmReadyP95Ms: number | null;
}

export interface KernelLoadMedians {
  coldReadyP50Ms: number | null;
  warmReadyP50Ms: number | null;
}

export interface KernelLoadResult {
  code: string;
  p95Ms: number;
  budgetMs: number;
  reason: string;
  withinBudget: boolean;
}

export interface KernelLoadRegressionResult {
  code: string;
  reason: string;
  baselineP50Ms: number;
  candidateP50Ms: number;
  allowedP50Ms: number;
  withinBudget: boolean;
}

export const KERNEL_LOAD_POLICY: Readonly<{
  minimumRuns: number;
  profiles: Readonly<
    Record<
      'desktop' | 'mobile',
      Readonly<{ coldReadyP95Ms: number; warmReadyP95Ms: number }>
    >
  >;
  regression: Readonly<
    Record<'desktop' | 'mobile', Readonly<{ ratio: number; floorMs: number }>>
  >;
}>;

export function evaluateKernelLoad(
  profile: string,
  metrics: KernelLoadMetrics
): {
  profile: string;
  results: KernelLoadResult[];
  warnings: KernelLoadResult[];
};

export function evaluateKernelLoadRegression(
  profile: string,
  baseline: KernelLoadMedians,
  candidate: KernelLoadMedians
): {
  profile: string;
  results: KernelLoadRegressionResult[];
  warnings: KernelLoadRegressionResult[];
};

export interface KernelFirstOperationMetrics {
  coldSolidP95Ms: number | null;
  warmSolidP95Ms: number | null;
  coldSketchP95Ms: number | null;
  warmSketchP95Ms: number | null;
}

export const KERNEL_FIRST_OPERATION_POLICY: Readonly<
  Record<
    'desktop' | 'mobile',
    Readonly<{
      coldSolidP95Ms: number;
      warmSolidP95Ms: number;
      coldSketchP95Ms: number;
      warmSketchP95Ms: number;
    }>
  >
>;

export function evaluateKernelFirstOperation(
  profile: string,
  metrics: KernelFirstOperationMetrics
): {
  profile: string;
  results: KernelLoadResult[];
  warnings: KernelLoadResult[];
};
