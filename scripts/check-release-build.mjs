/**
 * Refuses to deploy a web build that did not pass the Remus package gate.
 *
 * `wrangler.jsonc` runs this as its custom build step, so `wrangler deploy`
 * and `wrangler versions upload` check the output they upload, and the deploy
 * scripts run it too. It requires `build-meta.json` to carry the stamp the
 * Vite gate (`apps/web/build/remusArtifactGate.ts`) writes only after
 * verifying the installed packages; that stamp must name the current
 * `remus-checksums.json` and lockfile pin; the build must not come from local
 * (`+local`) Remus packages; the installed packages must still verify; and
 * both pinned WebAssembly modules must be in the output byte for byte.
 *
 * Usage: node scripts/check-release-build.mjs [--dist apps/web/dist]
 * (`pnpm -w run check:release-build` from any workspace directory). `--dist`
 * is relative to the repository root.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MANIFEST, sha256, verifyRemusArtifacts } from './remus-artifacts.mjs';

function wasmHashes(dir) {
  const hashes = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      for (const hash of wasmHashes(path)) hashes.add(hash);
    else if (entry.isFile() && entry.name.endsWith('.wasm'))
      hashes.add(sha256(readFileSync(path)));
  }
  return hashes;
}

/** Throws unless `dist` is a deployable build of the verified Remus pin. */
export function checkReleaseBuild({
  repoRoot = fileURLToPath(new URL('..', import.meta.url)),
  dist = 'apps/web/dist'
} = {}) {
  const root = resolve(repoRoot);
  const output = resolve(root, dist);
  let metadata;
  try {
    metadata = JSON.parse(
      readFileSync(join(output, 'build-meta.json'), 'utf8')
    );
  } catch {
    throw new Error(`${dist} has no build metadata; run pnpm build first.`);
  }
  if (metadata?.format !== 'openzcad-build-metadata')
    throw new Error(`${dist}/build-meta.json is not OpenZCAD build metadata.`);
  const remus = metadata.remus ?? {};
  if (remus.local === true || String(remus.version ?? '').includes('+local'))
    throw new Error(
      `${dist} was built from local Remus packages (+local) and cannot be deployed.`
    );
  const expected = verifyRemusArtifacts({ repoRoot: root });
  const stamp = remus.artifacts;
  if (
    !stamp ||
    stamp.commit !== expected.commit ||
    stamp.files !== expected.files ||
    stamp.manifestSha256 !== expected.manifestSha256 ||
    remus.commit !== expected.commit
  )
    throw new Error(
      `${dist} was not built from the verified Remus packages at ${expected.commit}; rebuild with pnpm build.`
    );
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
  const shipped = wasmHashes(output);
  for (const [key, hash] of Object.entries(manifest.sha256))
    if (key.endsWith('.wasm') && !shipped.has(hash))
      throw new Error(
        `${dist} does not ship the pinned ${key}; rebuild with pnpm build.`
      );
  return expected;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const distIndex = args.indexOf('--dist');
  if (
    (distIndex !== -1 && !args[distIndex + 1]) ||
    args.some((arg, index) => arg !== '--dist' && index !== distIndex + 1)
  )
    throw new Error(
      'Usage: node scripts/check-release-build.mjs [--dist <dir>]'
    );
  const dist = distIndex === -1 ? 'apps/web/dist' : args[distIndex + 1];
  const { commit, files } = checkReleaseBuild({ dist });
  console.log(
    `${dist} is a release build of the verified Remus packages (${files} files at ${commit}).`
  );
}
