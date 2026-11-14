import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import {
  ALLOW_LOCAL_REMUS_ENV,
  BUILD_METADATA,
  installedPackageDirs,
  remusOutputStamp,
  verifyRemusArtifacts
} from '../../../scripts/remus-artifacts.mjs';

/** What `build-meta.json` records about the verified Remus inputs. */
export interface RemusArtifactStamp {
  commit: string;
  files: number;
  manifestSha256: string;
  /** Emitted output path(s) of each pinned WebAssembly module. */
  modules?: Record<string, string[]>;
  /** Digest of every output file except `build-meta.json`. */
  output?: { files: number; sha256: string };
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

/**
 * Completes the `build-meta.json` stamp once the build output is on disk: it
 * adds the path each pinned Remus WebAssembly module was emitted to and the
 * digest of the whole output (`remusOutputStamp`), so
 * `scripts/check-release-build.mjs` can tie the stamp to exactly this output.
 * It runs after every other plugin has written its files. Builds without a
 * stamp (local overlays) are left alone and stay undeployable.
 */
export function remusOutputStampPlugin({
  repoRoot,
  stamped
}: {
  repoRoot: string;
  stamped: boolean;
}): Plugin {
  return {
    name: 'openzcad-remus-output-stamp',
    apply: 'build',
    writeBundle: {
      order: 'post',
      sequential: true,
      handler(options) {
        if (!stamped) return;
        if (!options.dir)
          throw new Error('The Remus output stamp needs an output directory.');
        stampRemusOutput({ repoRoot, dist: options.dir });
      }
    }
  };
}

/** Adds the output stamp to `dist/build-meta.json` (see the plugin above). */
export function stampRemusOutput({
  repoRoot,
  dist
}: {
  repoRoot: string;
  dist: string;
}): void {
  const path = join(dist, BUILD_METADATA);
  const metadata = JSON.parse(readFileSync(path, 'utf8')) as {
    remus?: { artifacts?: RemusArtifactStamp };
  };
  const artifacts = metadata.remus?.artifacts;
  if (!artifacts)
    throw new Error(`${BUILD_METADATA} has no Remus stamp to complete.`);
  Object.assign(artifacts, remusOutputStamp({ repoRoot, dist }));
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
}
