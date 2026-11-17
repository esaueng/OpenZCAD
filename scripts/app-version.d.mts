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
