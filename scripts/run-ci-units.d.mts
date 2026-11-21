export const UNIT_ROOT_WEIGHTS_PATH: string;
export const DEFAULT_UNIT_WEIGHT_SECONDS: number;
export function relatedFiles(
  project: 'root' | 'web',
  data: unknown,
  cwd: string
): string[];
export function selectedFiles(
  project: 'root' | 'web',
  related: string[],
  env?: Record<string, string | undefined>
): string[];
export function parseUnitShard(value: string): { shard: number; total: number };
export function extractShardArg(args: string[]): {
  shard: { shard: number; total: number } | null;
  rest: string[];
};
export function validateUnitWeights(weights: unknown): Record<string, number>;
export function readUnitWeights(path?: string): Record<string, number>;
export function partitionUnitFiles(
  files: string[],
  weights: Record<string, number>,
  total: number
): { files: string[]; seconds: number }[];
export function weightsFromVitestReports(
  reports: unknown[],
  rootDir?: string
): Record<string, number>;
export function mergeUnitWeights(
  current: Record<string, number>,
  measured: Record<string, number>,
  files: string[]
): Record<string, number>;
export function discoverRelatedFiles(
  cwd: string,
  changedAbsolutePaths: string[]
): Promise<string[]>;
export function listProjectFiles(
  cwd: string,
  config?: string
): Promise<string[]>;
export function runUnits(
  args: string[],
  env: Record<string, string | undefined>,
  execute?: (
    file: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      stdio: string;
    }
  ) => { status: number | null; error?: Error }
): number;
