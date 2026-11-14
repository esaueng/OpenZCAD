import {
  ALLOW_LOCAL_REMUS_ENV,
  installedPackageDirs,
  verifyRemusArtifacts
} from '../../../scripts/remus-artifacts.mjs';

/** What `build-meta.json` records about the verified Remus inputs. */
export interface RemusArtifactStamp {
  commit: string;
  files: number;
  manifestSha256: string;
}

export interface RemusArtifactGateOptions {
  command: 'build' | 'serve';
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  /** The `REMUS_WASM_PKG` / `REMUS_WASM_IO_PKG` directories, when set. */
  overlay: Record<string, string> | null;
  warn?: (message: string) => void;
  verify?: typeof verifyRemusArtifacts;
}

/**
 * Checks the Remus package directories Vite will actually bundle against
 * `remus-checksums.json`, before any build (web and desktop alike).
 *
 * - `vite build` fails on any mismatch. A build from local overlay packages
 *   is refused unless `OZ_ALLOW_LOCAL_REMUS=1` opts in; its output is labelled
 *   `+local` and carries no stamp, so `scripts/check-release-build.mjs`
 *   refuses to deploy it.
 * - The dev server and `vite preview` only warn, so local workflows (including
 *   overlay QA) keep working.
 *
 * Returns the stamp for `build-meta.json`, or null when nothing was verified.
 */
export function remusArtifactGate({
  command,
  repoRoot,
  env,
  overlay,
  warn = (message) => console.warn(message),
  verify = verifyRemusArtifacts
}: RemusArtifactGateOptions): RemusArtifactStamp | null {
  const building = command === 'build';
  const allowOverlay = env[ALLOW_LOCAL_REMUS_ENV] === '1';
  if (overlay && building && !allowOverlay)
    throw new Error(
      `Refusing to build with local Remus packages (REMUS_WASM_PKG / REMUS_WASM_IO_PKG). Set ${ALLOW_LOCAL_REMUS_ENV}=1 for a development or QA build; its +local output cannot be deployed.`
    );
  try {
    return verify({
      repoRoot,
      packageDirs: overlay ?? installedPackageDirs(repoRoot)
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (overlay) {
      warn(
        `OpenZCAD: building with unverified local Remus packages (${reason}). This output is labelled +local and cannot be deployed.`
      );
      return null;
    }
    if (building)
      throw new Error(`Remus package verification failed: ${reason}`, {
        cause: error
      });
    warn(
      `OpenZCAD: Remus package verification failed (${reason}). Builds will refuse these packages; run pnpm install --frozen-lockfile.`
    );
    return null;
  }
}
