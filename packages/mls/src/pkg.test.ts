/**
 * The committed WASM matches its build manifest, the MLS crates stay pinned
 * exactly, and nothing on the package entry path loads the WASM eagerly.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const text = (path: string) => read(path).toString('utf8');

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
          `^${name} = (\\{ version = )?"=${version.replace(/\./g, '\\.')}"`,
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
