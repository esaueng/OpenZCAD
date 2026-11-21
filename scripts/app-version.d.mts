export interface AppVersionFile {
  path: string;
  kind: 'json' | 'cargo-manifest' | 'cargo-lock';
}

export interface AppVersionParts {
  year: number;
  release: number;
  patch: number;
}

export const APP_VERSION_FILES: readonly AppVersionFile[];
export function parseAppVersion(value: unknown): AppVersionParts;
export function isAppVersion(value: unknown): boolean;
export function nextAppVersion(
  current: string,
  part: 'patch' | 'release'
): string;
export function readAppVersions(
  repoRoot: string
): { path: string; version: string }[];
export function checkAppVersion(repoRoot: string): string;
export function setAppVersion(repoRoot: string, version: string): string[];
export function isUserFacingSubject(subject: string): boolean;

export interface AppBuildVersion {
  /** What the build reports: base + one patch per user-facing merge. */
  version: string;
  /** The version in package.json. */
  base: string;
  /** User-facing first-parent merges since the commit that set the base. */
  merges: number;
  /** False when the history was unavailable and `version` is the bare base. */
  exact: boolean;
  reason?: string;
}

export function buildAppVersion(
  repoRoot: string,
  options?: { fetch?: boolean; required?: boolean }
): AppBuildVersion;
export function assertNewAppBase(
  currentBase: string,
  reported: string,
  next: string
): void;
