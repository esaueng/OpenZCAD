import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function remappedRustFlags({
  root = repositoryRoot,
  home = homedir(),
  temporaryDirectory = tmpdir(),
  existing = ''
} = {}) {
  const flags = existing ? existing.split('\x1f').filter(Boolean) : [];
  const mappings = new Map([
    [root, '/source/OpenZCAD'],
    [home, '/home/build'],
    [temporaryDirectory, '/tmp/build']
  ]);
  for (const [from, to] of mappings) {
    if (from) flags.push(`--remap-path-prefix=${from}=${to}`);
  }
  return flags.join('\x1f');
}

if (process.argv[1]?.endsWith('run-tauri-build.mjs')) {
  if (process.env.RUSTFLAGS && !process.env.CARGO_ENCODED_RUSTFLAGS) {
    console.error(
      'RUSTFLAGS is set. Move custom flags to CARGO_ENCODED_RUSTFLAGS so the release path-remapping flags can be composed safely.'
    );
    process.exit(2);
  }

  const result = spawnSync(
    'pnpm',
    ['exec', 'tauri', 'build', ...process.argv.slice(2)],
    {
      cwd: resolve(repositoryRoot, 'apps/desktop'),
      env: {
        ...process.env,
        CARGO_ENCODED_RUSTFLAGS: remappedRustFlags({
          existing: process.env.CARGO_ENCODED_RUSTFLAGS
        })
      },
      stdio: 'inherit'
    }
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
