export const SPEC_DIR: string;
export const WEIGHTS_PATH: string;
export const SPEC_PATTERN: RegExp;
export const DEFAULT_WEIGHT_SECONDS: number;

export interface ShardPlan {
  files: string[];
  seconds: number;
}

export function listSpecs(dir?: string): string[];

export function parseShard(value: string): { shard: number; total: number };

export function partitionSpecs(
  specs: string[],
  weights: Record<string, number>,
  total: number
): ShardPlan[];

export function shardFilters(
  shard: number,
  total: number,
  specs: string[],
  weights: Record<string, number>
): string[];

export function weightsFromReports(reports: unknown[]): Record<string, number>;

export function mergeWeights(
  current: Record<string, number>,
  measured: Record<string, number>,
  specs: string[]
): Record<string, number>;

export function readWeights(path?: string): Record<string, number>;
