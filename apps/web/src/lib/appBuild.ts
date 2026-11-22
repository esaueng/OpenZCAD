import { shortCommit } from './kernelBuild';

/**
 * The identity of the OpenZCAD app this bundle was built from: the
 * `YYYY.RELEASE.PATCH` version (the root `package.json` base plus one patch
 * per user-facing merge since it was set, see `scripts/app-version.mjs`) and
 * the source commit. Vite defines both as `OZ_APP_VERSION` and
 * `OZ_BUILD_COMMIT`. Merges that do not count share a version, so the commit
 * names the exact build.
 */

/** Shown when the constants are absent, which is any non-Vite runtime. */
const UNKNOWN = 'unknown';

const APP_LABEL = 'OpenZCAD';
const APP_REPOSITORY = 'esaueng/OpenZCAD';

export interface AppBuild {
  /** `YYYY.RELEASE.PATCH`: the package.json base plus user-facing merges. */
  version: string;
  /** OpenZCAD commit the bundle was built from. */
  sourceCommit: string;
}

export interface AppBuildEnv {
  OZ_APP_VERSION?: string;
  OZ_BUILD_COMMIT?: string;
}

/** Separated from the constant so the fallback is testable outside Vite. */
export function resolveAppBuild(env: AppBuildEnv): AppBuild {
  return {
    version: env.OZ_APP_VERSION || UNKNOWN,
    sourceCommit: env.OZ_BUILD_COMMIT || UNKNOWN
  };
}

export const APP_BUILD: AppBuild = resolveAppBuild(import.meta.env);

/** One line, short enough for a settings row: `OpenZCAD 2026.1.0 · fdbb664`. */
export function appBuildLabel(build: AppBuild): string {
  return `${APP_LABEL} ${build.version} · ${shortCommit(build.sourceCommit)}`;
}

/** The unabbreviated form, for the row's tooltip and defect reports. */
export function appBuildDetail(build: AppBuild): string {
  return `${APP_LABEL} ${build.version} — ${APP_REPOSITORY}@${build.sourceCommit}`;
}
