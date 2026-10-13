export interface KernelArtifact {
  source: 'build' | 'package';
  assetPath: string;
  absolutePath: string;
  bytes: Buffer;
  sha256: string;
  sizes: {
    rawBytes: number;
    gzipBytes: number;
    brotliBytes: number;
  };
  openzcadCommit: string | null;
  remusCommit: string | null;
  remusVersion: string;
}

export interface LoadProfile {
  cpuThrottlingRate: number;
  network: {
    latencyMs: number;
    downloadBitsPerSecond: number;
    uploadBitsPerSecond: number;
  } | null;
}

export interface LoadBenchmarkArgs {
  dist: string;
  packageDirectory: string | null;
  glueDirectory: string | null;
  runs: number;
  out: string | null;
  executablePath: string | null;
  profile: 'desktop' | 'mobile';
  encoding: 'gzip' | 'identity';
  warmSettleMs: number;
  check: boolean;
  baselinePackageDirectory: string | null;
  modulePhases: boolean;
  firstOperations: boolean;
  markdown: string | null;
}

export type FirstOperationOrder = 'solid-first' | 'sketch-first';

export interface FirstOperationResult {
  order: FirstOperationOrder;
  solidFirstMs: number;
  solidSecondMs: number;
  sketchFirstMs: number;
  sketchSecondMs: number;
  solid: Array<{ volume: number; triangles: number }>;
  sketch: Array<{
    converged: boolean;
    points: Array<[number, number]>;
    radius: number;
  }>;
}

export const LOAD_PROFILES: Readonly<{
  desktop: Readonly<LoadProfile>;
  mobile: Readonly<LoadProfile>;
}>;
export const CONTENT_ENCODINGS: readonly ['gzip', 'identity'];

export function percentile(values: number[], fraction: number): number | null;
export function summarize(values: Array<number | null>): {
  median: number | null;
  p95: number | null;
};
export function resolveKernelArtifact(distDirectory: string): KernelArtifact;
export function resolvePackageArtifact(
  packageDirectory: string
): KernelArtifact;
export function resolveKernelGlue(
  packageDirectory: string,
  expectedSha256: string
): Buffer;
export function parseArgs(argv: string[]): LoadBenchmarkArgs;
export function assertCacheProtocol(
  samples: Array<{
    kernelReady: {
      cold: { networkRequests: number };
      warm: { networkRequests: number };
    };
  }>
): void;
export function assertFirstOperationResults(result: FirstOperationResult): void;
export function firstOperationOrder(index: number): FirstOperationOrder;
export function firstOperationGatesApply(runs: number): boolean;
export function summarizeFirstOperations(
  samples: Array<{
    kernelReady: Record<
      'cold' | 'warm',
      { firstOperations: FirstOperationResult }
    >;
  }>,
  phase: 'cold' | 'warm'
): Record<string, unknown>;
export function markdownSection(report: unknown): string;
export function runBenchmark(args: LoadBenchmarkArgs): Promise<unknown>;
