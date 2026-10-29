import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Exercise the build boundary without a compiler or dependency download.
it.skipIf(process.platform === 'win32').each([
  ['wasm-bindgen 0.2.126', true],
  ['wasm-bindgen 0.2.126 (21ac804a9)', false],
  ['wasm-bindgen 0.2.125', false]
] as const)(
  'requires the canonical CLI producer and normalizes rust-src paths: %s',
  async (version, accepted) => {
    const directory = await mkdtemp(join(tmpdir(), 'mls-build-contract-'));
    try {
      const tools = join(directory, 'toolchain/bin');
      const crate = join(directory, 'crate');
      await mkdir(tools, { recursive: true });
      await mkdir(crate);
      await writeFile(
        join(directory, 'build.sh'),
        await readFile(new URL('../build.sh', import.meta.url))
      );
      await writeFile(
        join(crate, 'rust-toolchain.toml'),
        'channel = "1.96.0"\n'
      );
      const stub = (name: string, source: string) =>
        writeFile(join(tools, name), '#!/bin/sh\n' + source, { mode: 0o700 });
      await stub('rustup', 'printf "%s\\n" "$MLS_TEST_CARGO"\n');
      await stub(
        'rustc',
        'printf "commit-hash: ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96\\n"\n'
      );
      await stub(
        'wasm-bindgen',
        'printf "%s\\n" "$MLS_TEST_BINDGEN_VERSION"\n'
      );
      await stub(
        'cargo',
        'printf "%s" "$RUSTFLAGS" > "$MLS_TEST_FLAGS"\nexit 75\n'
      );
      const capture = join(directory, 'flags');
      const result = spawnSync('bash', [join(directory, 'build.sh')], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          PATH: tools + ':/usr/bin:/bin',
          MLS_TEST_CARGO: join(tools, 'cargo'),
          MLS_TEST_BINDGEN_VERSION: version,
          MLS_TEST_FLAGS: capture
        }
      });
      expect(result.status).toBe(accepted ? 75 : 1);
      if (accepted) {
        const flags = await readFile(capture, 'utf8');
        expect(flags).toContain(
          `--remap-path-prefix=${directory}/toolchain/lib/rustlib/src/rust/library=/rustc/ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96/library`
        );
      } else {
        expect(result.stderr).toContain(
          'crates.io wasm-bindgen CLI 0.2.126 is required'
        );
        expect(existsSync(capture)).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
