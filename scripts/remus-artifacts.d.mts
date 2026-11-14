export const MANIFEST: string;
export const UPSTREAM_REPOSITORY: string;
export const REMUS_PACKAGES: readonly (readonly [string, string])[];
export const ALLOW_LOCAL_REMUS_ENV: string;

export interface RemusManifest {
  commit: string;
  files: Record<string, string>;
  sha256: Record<string, string>;
}

export function gitBlobId(bytes: Uint8Array): string;
export function sha256(bytes: Uint8Array): string;
export function remusPin(lockText: string): string;
export function installedPackageDirs(repoRoot: string): Record<string, string>;
export function packageFiles(root: string, prefix?: string): string[];
export function entryPoints(
  packageJson: Record<string, unknown>,
  files: string[]
): string[];
export function packedFiles(
  upstreamFiles: string[],
  packageJson: Record<string, unknown>
): string[];
export function verifyRemusPackages(options: {
  manifest: unknown;
  commit: string;
  packageDirs: Record<string, string>;
}): number;
export function githubApi(
  path: string,
  run?: (file: string, args: string[], options: object) => string
): unknown;
export function upstreamBlobs(
  commit: string,
  upstreamPath: string,
  api?: (path: string) => unknown,
  prefix?: string
): Map<string, string>;
export function recordRemusManifest(options: {
  commit: string;
  packageDirs: Record<string, string>;
  upstream?: (upstreamPath: string) => Map<string, string>;
  previous?: Partial<RemusManifest> | null;
  allowShrink?: boolean;
}): RemusManifest;
export function verifyRemusArtifacts(options?: {
  repoRoot?: string;
  packageDirs?: Record<string, string>;
}): { commit: string; files: number; manifestSha256: string };
