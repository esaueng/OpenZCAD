/**
 * The identity of the geometry kernel this bundle was built against.
 *
 * `brepkit-wasm` is pinned to a git commit rather than to a registry version,
 * so "which kernel am I running" has two halves: the version the pinned package
 * declares, and the brepkit commit that package was built from. Vite resolves
 * both at build time — the version out of the installed package, the commit out
 * of the lockfile — and defines them as `OZ_BREPKIT_VERSION` and
 * `OZ_BREPKIT_COMMIT`. Nothing here reads the network or asks the worker, so
 * what this reports is the kernel the bundle actually carries.
 */

/** Shown when the constants are absent, which is any non-Vite runtime. */
const UNKNOWN = 'unknown';

/** Human-facing name for the one adapter the app builds geometry through. */
const ADAPTER_LABEL = 'BrepKit';

export interface KernelBuild {
  /** Adapter identifier, as the diagnostic bundle records it. */
  adapter: 'brepkit';
  /** Version declared by the pinned `brepkit-wasm` package. */
  packageVersion: string;
  /** Brepkit commit the pinned package was built from. */
  sourceCommit: string;
}

export interface KernelBuildEnv {
  OZ_BREPKIT_VERSION?: string;
  OZ_BREPKIT_COMMIT?: string;
}

/**
 * Separated from the constant below so the fallback is testable without a Vite
 * build: under Vitest neither define is applied, and a settings row reading
 * `undefined` would be worse than one saying so.
 */
export function resolveKernelBuild(env: KernelBuildEnv): KernelBuild {
  return {
    adapter: 'brepkit',
    packageVersion: env.OZ_BREPKIT_VERSION || UNKNOWN,
    sourceCommit: env.OZ_BREPKIT_COMMIT || UNKNOWN
  };
}

export const KERNEL_BUILD: KernelBuild = resolveKernelBuild(import.meta.env);

/**
 * Abbreviates a full commit the way git does. Anything that is not a 40-hex
 * sha — `unknown`, or an already-short sha — is passed through untouched
 * rather than blindly sliced.
 */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 7) : commit;
}

/** One line, short enough for a settings row: `BrepKit 0.4.2 · c4edaeb`. */
export function kernelBuildLabel(build: KernelBuild): string {
  return `${ADAPTER_LABEL} ${build.packageVersion} · ${shortCommit(build.sourceCommit)}`;
}

/**
 * The unabbreviated form, for the row's tooltip and for anyone pasting the
 * kernel identity into a defect report. A short sha is ambiguous across two
 * repositories; this one is not.
 */
export function kernelBuildDetail(build: KernelBuild): string {
  return `${ADAPTER_LABEL} ${build.packageVersion} — esaueng/brepkit@${build.sourceCommit}`;
}
