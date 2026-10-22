/**
 * The committed WASM matches its build manifest, the MLS crates stay pinned
 * exactly, and nothing on the package entry path loads the WASM eagerly.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const text = (path: string) => read(path).toString('utf8');
const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('@openzcad/mls build', () => {
  it('pkg/ matches BUILD.json, which build.sh --check reproduces', () => {
    const manifest = JSON.parse(text('../pkg/BUILD.json')) as {
      toolchain: string;
      wasmBindgen: string;
      files: Record<string, string>;
    };
    expect(manifest.toolchain).toBe(
      text('../crate/rust-toolchain.toml').match(/channel = "(.+)"/)?.[1]
    );
    expect(Object.keys(manifest.files)).toContain('openzcad_mls_bg.wasm');
    for (const [file, sha] of Object.entries(manifest.files)) {
      expect(
        createHash('sha256')
          .update(read(`../pkg/${file}`))
          .digest('hex'),
        file
      ).toBe(sha);
    }
    expect(text('../crate/Cargo.toml')).toContain(
      `wasm-bindgen = "=${manifest.wasmBindgen}"`
    );
  });

  // CI has no Rust, so it cannot rebuild pkg/; the scenario suites run the
  // committed WASM. The manifest records the sources that WASM was built
  // from, so a Rust change committed without build.sh fails here instead of
  // passing against the old WASM.
  it('BUILD.json records the current crate sources, so pkg/ is not stale', () => {
    const manifest = JSON.parse(text('../pkg/BUILD.json')) as {
      sources?: Record<string, string>;
    };
    const crateSources = [
      'crate/Cargo.toml',
      'crate/Cargo.lock',
      'crate/rust-toolchain.toml',
      ...readdirSync(new URL('../crate/src', import.meta.url), {
        recursive: true,
        encoding: 'utf8'
      })
        .map((file) => `crate/src/${file.split(sep).join('/')}`)
        .filter((file) =>
          statSync(new URL(`../${file}`, import.meta.url)).isFile()
        )
    ].sort();
    expect(Object.keys(manifest.sources ?? {}).sort()).toEqual(crateSources);
    for (const [file, sha] of Object.entries(manifest.sources ?? {})) {
      expect(
        createHash('sha256')
          .update(read(`../${file}`))
          .digest('hex'),
        `${file} changed since pkg/ was built: run packages/mls/build.sh`
      ).toBe(sha);
    }
  });

  it('pins every MLS crate exactly, in the manifest and the lockfile', () => {
    const cargo = text('../crate/Cargo.toml');
    const lock = text('../crate/Cargo.lock');
    const pins: Record<string, string> = {
      'mls-rs': '0.56.0',
      'mls-rs-core': '0.27.0',
      'mls-rs-codec': '0.7.0',
      'mls-rs-crypto-rustcrypto': '0.22.1'
    };
    for (const [name, version] of Object.entries(pins)) {
      expect(cargo).toMatch(
        new RegExp(
          `^${name} = (\\{ version = )?"=${escapeRegExp(version)}"`,
          'm'
        )
      );
      const locked = [
        ...lock.matchAll(
          new RegExp(`name = "${name}"\\nversion = "([^"]+)"`, 'g')
        )
      ].map((m) => m[1]);
      expect(locked, name).toEqual([version]);
    }
    expect(lock).not.toMatch(/name = "mls-rs-crypto-webcrypto"/);
  });

  it('keeps the WASM behind the lazily started Worker', () => {
    const index = text('./index.ts');
    expect(index).not.toMatch(/from '\.\.\/pkg\//);
    expect(index).not.toMatch(
      /from '\.\/(worker|engine|test-support|scenarios)'/
    );
    expect(index).toContain(
      "new Worker(new URL('./worker.ts', import.meta.url)"
    );
    expect(text('./worker.ts')).toContain(
      "new URL('../pkg/openzcad_mls_bg.wasm', import.meta.url)"
    );
  });
});
