import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

/** Explicit paired development packages; published pins remain unchanged. */
export async function localRemusPackages(env: NodeJS.ProcessEnv) {
  const kernel = env.REMUS_WASM_PKG;
  const io = env.REMUS_WASM_IO_PKG;
  if (!kernel && !io) return null;
  if (!kernel || !io)
    throw new Error('Set both REMUS_WASM_PKG and REMUS_WASM_IO_PKG.');
  const paths = await Promise.all([realpath(kernel), realpath(io)]);
  const manifests = await Promise.all(
    paths.map(
      async (path) =>
        JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
          remusSourceCommit?: string;
        }
    )
  );
  if (
    manifests[0]!.name !== 'remus-wasm' ||
    manifests[1]!.name !== 'remus-wasm-io' ||
    typeof manifests[0]!.version !== 'string' ||
    !manifests[0]!.version ||
    manifests[0]!.version !== manifests[1]!.version
  )
    throw new Error(
      'Local Remus kernel and translator package names/versions must match.'
    );
  const git = (path: string, args: string[]) =>
    execFileSync('git', ['-C', path, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  const stamps = manifests.map((manifest) => manifest.remusSourceCommit);
  let commit: string;
  let dirty = false;
  let sourceContext: 'checkout' | 'ci-artifact' = 'checkout';
  try {
    const roots = paths.map((path) =>
      git(path, ['rev-parse', '--show-toplevel'])
    );
    if (roots[0] !== roots[1]) throw new Error('Different source checkouts.');
    await readFile(join(roots[0]!, 'crates/wasm/Cargo.toml'));
    commit = git(paths[0], ['rev-parse', 'HEAD']);
    dirty =
      git(paths[0], ['status', '--porcelain', '--untracked-files=no']) !== '';
  } catch {
    if (stamps[0] !== stamps[1] || !/^[a-f0-9]{40}$/.test(stamps[0] ?? ''))
      throw new Error(
        'Local Remus packages need shared Git provenance or matching remusSourceCommit stamps.'
      );
    commit = stamps[0]!;
    sourceContext = 'ci-artifact';
  }
  const wasmSha256 = await Promise.all(
    paths.map(async (path, index) =>
      createHash('sha256')
        .update(
          await readFile(
            join(
              path,
              index === 0 ? 'remus_wasm_bg.wasm' : 'remus_wasm_io_bg.wasm'
            )
          )
        )
        .digest('hex')
    )
  );
  return {
    aliases: { 'remus-wasm': paths[0], 'remus-wasm-io': paths[1] },
    build: {
      version: `${manifests[0]!.version}+local`,
      commit,
      local: true,
      dirty,
      sourceContext,
      wasmSha256
    }
  };
}
