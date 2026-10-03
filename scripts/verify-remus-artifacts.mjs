import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const pins = new Set(
  [
    ...readFileSync('pnpm-lock.yaml', 'utf8').matchAll(
      /codeload\.github\.com\/esaueng\/remus\/tar\.gz\/([a-f0-9]{40})/g
    )
  ].map((match) => match[1])
);
if (pins.size !== 1) throw new Error('Expected exactly one paired Remus pin.');
const commit = [...pins][0];
const artifacts = [
  ['remus-wasm', 'crates/wasm/pkg', 'remus_wasm_bg.wasm'],
  ['remus-wasm-io', 'crates/wasm-io/pkg', 'remus_wasm_io_bg.wasm']
];
const blobId = (bytes) =>
  createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
const record = process.argv.includes('--record');
const manifest = record
  ? { commit, files: {} }
  : JSON.parse(readFileSync('remus-checksums.json', 'utf8'));
if (manifest.commit !== commit)
  throw new Error('Remus checksum manifest does not match the kernel pin.');
for (const [pkg, upstreamPath, file] of artifacts) {
  const key = `${pkg}/${file}`;
  const bytes = readFileSync(
    `packages/kernel-adapter/node_modules/${pkg}/${file}`
  );
  const expected = record
    ? JSON.parse(
        execFileSync(
          'gh',
          [
            'api',
            `repos/esaueng/remus/contents/${upstreamPath}/${file}?ref=${commit}`
          ],
          { encoding: 'utf8' }
        )
      ).sha
    : manifest.files[key];
  if (!/^[a-f0-9]{40}$/.test(expected ?? '') || blobId(bytes) !== expected) {
    throw new Error(
      `Installed ${key} does not match the immutable upstream blob.`
    );
  }
  manifest.files[key] = expected;
}
if (record)
  writeFileSync(
    'remus-checksums.json',
    JSON.stringify(manifest, null, 2) + '\n'
  );
console.log(`Paired Remus WASM bytes verified at ${commit}.`);
