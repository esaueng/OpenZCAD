/**
 * Checks every installed file of the paired Remus packages against
 * `remus-checksums.json` before a build.
 *
 * The packages come from a GitHub tarball that `pnpm-lock.yaml` cannot give an
 * `integrity` hash, and all of their files ship or run in the app (the WASM
 * modules and the JS glue that loads them), so each one is pinned:
 * - `files`: the upstream git blob id at the pinned Remus commit;
 * - `sha256`: the SHA-256 of the same bytes.
 * Verification reads only the installed files and the manifest. It fails on a
 * changed, missing or unlisted file, or a manifest for another Remus commit.
 *
 * Regenerating after a Remus bump: `.github/workflows/update-remus.yml` runs
 * `node scripts/verify-remus-artifacts.mjs --record` after its frozen install,
 * and commits the result with the manifest and lockfile. By hand, after
 * `pnpm install --frozen-lockfile` on the bumped lockfile, run the same
 * command with an authenticated `gh`. Recording refuses any installed file
 * whose bytes differ from the upstream blob at the pinned commit, so the
 * manifest only ever records what Remus published.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

const MANIFEST = 'remus-checksums.json';
const pins = new Set(
  [
    ...readFileSync('pnpm-lock.yaml', 'utf8').matchAll(
      /codeload\.github\.com\/esaueng\/remus\/tar\.gz\/([a-f0-9]{40})/g
    )
  ].map((match) => match[1])
);
if (pins.size !== 1) throw new Error('Expected exactly one paired Remus pin.');
const commit = [...pins][0];
const packages = [
  ['remus-wasm', 'crates/wasm/pkg'],
  ['remus-wasm-io', 'crates/wasm-io/pkg']
];
const blobId = (bytes) =>
  createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every file under `root`, as sorted POSIX paths relative to it. */
function installedFiles(root, prefix = '') {
  return readdirSync(posix.join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return installedFiles(root, path);
      if (entry.isFile()) return [path];
      throw new Error(`Unexpected Remus package entry ${root}/${path}.`);
    })
    .sort();
}

/** Upstream blob ids of a Remus directory at the pin, keyed by relative path. */
function upstreamBlobs(upstreamPath, prefix = '') {
  const listing = JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        `repos/esaueng/remus/contents/${posix.join(upstreamPath, prefix)}?ref=${commit}`
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
  );
  if (!Array.isArray(listing))
    throw new Error(`Upstream ${upstreamPath}/${prefix} is not a directory.`);
  const blobs = new Map();
  for (const entry of listing) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === 'dir')
      for (const [child, sha] of upstreamBlobs(upstreamPath, path))
        blobs.set(child, sha);
    else if (entry.type === 'file') blobs.set(path, entry.sha);
  }
  return blobs;
}

const record = process.argv.includes('--record');
const manifest = record
  ? { commit, files: {}, sha256: {} }
  : JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (manifest.commit !== commit)
  throw new Error('Remus checksum manifest does not match the kernel pin.');
if (
  typeof manifest.files !== 'object' ||
  manifest.files === null ||
  typeof manifest.sha256 !== 'object' ||
  manifest.sha256 === null
)
  throw new Error('Remus checksum manifest is missing its file checksums.');

let verified = 0;
for (const [pkg, upstreamPath] of packages) {
  const root = `packages/kernel-adapter/node_modules/${pkg}`;
  const files = installedFiles(root);
  const upstream = record ? upstreamBlobs(upstreamPath) : null;
  const pinned = Object.keys(manifest.files)
    .filter((key) => key.startsWith(`${pkg}/`))
    .map((key) => key.slice(pkg.length + 1))
    .sort();
  if (!record && pinned.join('\n') !== files.join('\n'))
    throw new Error(
      `Installed ${pkg} files do not match the checksum manifest (expected ${pinned.join(', ')}; found ${files.join(', ')}).`
    );
  for (const file of files) {
    const key = `${pkg}/${file}`;
    const bytes = readFileSync(`${root}/${file}`);
    const expectedBlob = record ? upstream.get(file) : manifest.files[key];
    const expectedSha256 = record ? sha256(bytes) : manifest.sha256[key];
    if (
      !/^[a-f0-9]{40}$/.test(expectedBlob ?? '') ||
      blobId(bytes) !== expectedBlob
    )
      throw new Error(
        `Installed ${key} does not match the immutable upstream blob.`
      );
    if (
      !/^[a-f0-9]{64}$/.test(expectedSha256 ?? '') ||
      sha256(bytes) !== expectedSha256
    )
      throw new Error(`Installed ${key} does not match its pinned SHA-256.`);
    manifest.files[key] = expectedBlob;
    manifest.sha256[key] = expectedSha256;
    verified += 1;
  }
}
if (!record) {
  const listed = Object.keys(manifest.sha256).sort().join('\n');
  if (listed !== Object.keys(manifest.files).sort().join('\n'))
    throw new Error('Remus checksum manifest lists different files per hash.');
}
if (record) {
  const sorted = (entries) =>
    Object.fromEntries(
      Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1))
    );
  writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        commit,
        files: sorted(manifest.files),
        sha256: sorted(manifest.sha256)
      },
      null,
      2
    ) + '\n'
  );
}
console.log(`Paired Remus package files (${verified}) verified at ${commit}.`);
