export const SPEC_DIR: string;
export const WEIGHTS_PATH: string;
export const SMOKE_WEIGHTS_PATH: string;
export const SMOKE_TAG: string;
export const SPEC_PATTERN: RegExp;
export const DEFAULT_WEIGHT_SECONDS: number;

export interface ShardPlan {
  files: string[];
  seconds: number;
}

export function listSpecs(dir?: string): string[];
export type E2eSuite = 'smoke' | 'full';
export function resolveSuite(
  env?: Record<string, string | undefined>
): E2eSuite;
export function suiteSpecs(suite: E2eSuite, dir?: string): string[];

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

export function specFilter(spec: string): string;

export function weightsFromReports(reports: unknown[]): Record<string, number>;

export function mergeWeights(
  current: Record<string, number>,
  measured: Record<string, number>,
  specs: string[]
): Record<string, number>;

export function readWeights(path?: string): Record<string, number>;
