export interface KernelArtifact {
  assetPath: string;
  absolutePath: string;
  bytes: Buffer;
  sha256: string;
  sizes: {
    rawBytes: number;
    gzipBytes: number;
    brotliBytes: number;
  };
  openzcadCommit: string;
  remusCommit: string;
  remusVersion: string;
}

export function percentile(values: number[], fraction: number): number | null;
export function summarize(values: Array<number | null>): {
  median: number | null;
  p95: number | null;
};
export function resolveKernelArtifact(distDirectory: string): KernelArtifact;
