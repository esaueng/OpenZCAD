/**
 * Integrity checks for the paired Remus packages (`remus-wasm` and
 * `remus-wasm-io`), shared by the build gate in `apps/web/vite.config.ts`,
 * `scripts/verify-remus-artifacts.mjs` and `scripts/check-release-build.mjs`.
 *
 * The packages come from a GitHub tarball that `pnpm-lock.yaml` cannot give an
 * `integrity` hash, and all of their files ship or run in the app (the WASM
 * modules and the JS glue that loads them), so `remus-checksums.json` pins
 * each one:
 * - `files`: the upstream git blob id at the pinned Remus commit;
 * - `sha256`: the SHA-256 of the same bytes.
 *
 * Verification reads only local files. Recording derives the expected file
 * list from the pinned commit's upstream tree and the package's own `files`
 * list, so a missing or extra installed file cannot shrink or grow the pin.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

export const MANIFEST = 'remus-checksums.json';
export const UPSTREAM_REPOSITORY = 'esaueng/remus';
/** Package name and its directory in the Remus repository. */
export const REMUS_PACKAGES = /** @type {const} */ ([
  ['remus-wasm', 'crates/wasm/pkg'],
  ['remus-wasm-io', 'crates/wasm-io/pkg']
]);
/** Opt-in for building with `REMUS_WASM_PKG` / `REMUS_WASM_IO_PKG` overlays. */
export const ALLOW_LOCAL_REMUS_ENV = 'OZ_ALLOW_LOCAL_REMUS';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** Files npm and pnpm always pack, whatever `files` says. */
const ALWAYS_PACKED =
  /^(?:package\.json|(?:readme|copying|license|licence)(?:\.[^/]*)?)$/i;
/** Files npm and pnpm never pack. */
const NEVER_PACKED =
  /(?:^|\/)(?:\.git|\.svn|\.hg|CVS|node_modules|\.npmrc|\.gitignore|\.npmignore|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.DS_Store|npm-debug\.log)(?:\/|$)/;

export const gitBlobId = (bytes) =>
  createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

/** The single Remus commit both packages resolve to in `pnpm-lock.yaml`. */
export function remusPin(lockText) {
  const pins = new Set(
    [
      ...lockText.matchAll(
        /codeload\.github\.com\/esaueng\/remus\/tar\.gz\/([a-f0-9]{40})/g
      )
    ].map((match) => match[1])
  );
  if (pins.size !== 1)
    throw new Error('Expected exactly one paired Remus pin.');
  return [...pins][0];
}

/** Installed package directories, resolved through pnpm's links. */
export function installedPackageDirs(repoRoot) {
  return Object.fromEntries(
    REMUS_PACKAGES.map(([pkg]) => [
      pkg,
      realpathSync(join(repoRoot, 'packages/kernel-adapter/node_modules', pkg))
    ])
  );
}

/** Every file under `root`, as sorted POSIX paths relative to it. */
export function packageFiles(root, prefix = '') {
  return readdirSync(prefix ? join(root, prefix) : root, {
    withFileTypes: true
  })
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return packageFiles(root, path);
      if (entry.isFile()) return [path];
      throw new Error(`Unexpected Remus package entry ${root}/${path}.`);
    })
    .sort();
}

const relativeTarget = (value) => value.replace(/^\.\//, '');

/**
 * Files a package cannot load without: `main`, `module`, `browser`, `types`,
 * every `exports` target, and each WebAssembly module it ships.
 */
export function entryPoints(packageJson, files) {
  const targets = new Set();
  for (const field of ['main', 'module', 'browser', 'types', 'typings'])
    if (typeof packageJson[field] === 'string')
      targets.add(relativeTarget(packageJson[field]));
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.includes('*'))
        throw new Error(`Unsupported Remus export pattern ${value}.`);
      targets.add(relativeTarget(value));
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object')
      Object.values(value).forEach(walk);
  };
  walk(packageJson.exports);
  for (const file of files) if (file.endsWith('.wasm')) targets.add(file);
  return [...targets].sort();
}

function globPattern(entry) {
  let source = '';
  for (let index = 0; index < entry.length; index += 1) {
    const char = entry[index];
    if (char === '*' && entry[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}(?:/.*)?$`);
}

/**
 * The files pnpm installs from an upstream package directory: everything its
 * `files` list selects, plus the files npm always packs, minus the files it
 * never packs. Unsupported packaging rules fail rather than guess.
 */
export function packedFiles(upstreamFiles, packageJson) {
  if (upstreamFiles.includes('.npmignore'))
    throw new Error('Remus packages with an .npmignore are not supported.');
  const { files } = packageJson;
  if (files !== undefined && !Array.isArray(files))
    throw new Error('Remus package.json "files" must be a list.');
  const patterns = (files ?? []).map((entry) => {
    if (typeof entry !== 'string' || entry.startsWith('!'))
      throw new Error(`Unsupported Remus "files" entry ${String(entry)}.`);
    return globPattern(relativeTarget(entry).replace(/\/+$/, ''));
  });
  const main =
    typeof packageJson.main === 'string'
      ? relativeTarget(packageJson.main)
      : null;
  return upstreamFiles
    .filter(
      (file) =>
        !NEVER_PACKED.test(file) &&
        (files === undefined ||
          (!file.includes('/') && ALWAYS_PACKED.test(file)) ||
          file === main ||
          patterns.some((pattern) => pattern.test(file)))
    )
    .sort();
}

const manifestKeys = (manifest, pkg) =>
  Object.keys(manifest.files)
    .filter((key) => key.startsWith(`${pkg}/`))
    .map((key) => key.slice(pkg.length + 1))
    .sort();

function checkShape(manifest) {
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    typeof manifest.files !== 'object' ||
    manifest.files === null ||
    typeof manifest.sha256 !== 'object' ||
    manifest.sha256 === null
  )
    throw new Error('Remus checksum manifest is missing its file checksums.');
  const listed = Object.keys(manifest.sha256).sort().join('\n');
  if (listed !== Object.keys(manifest.files).sort().join('\n'))
    throw new Error('Remus checksum manifest lists different files per hash.');
}

/**
 * Checks each package directory against the manifest. Fails on a changed,
 * missing or unlisted file, a manifest for another commit, or a manifest that
 * omits a package's entry points or WebAssembly module.
 */
export function verifyRemusPackages({ manifest, commit, packageDirs }) {
  if (manifest?.commit !== commit)
    throw new Error('Remus checksum manifest does not match the kernel pin.');
  checkShape(manifest);
  let verified = 0;
  for (const [pkg] of REMUS_PACKAGES) {
    const root = packageDirs[pkg];
    if (!root) throw new Error(`No package directory for ${pkg}.`);
    const files = packageFiles(root);
    const pinned = manifestKeys(manifest, pkg);
    if (pinned.length === 0)
      throw new Error(`Remus checksum manifest lists no ${pkg} files.`);
    if (pinned.join('\n') !== files.join('\n'))
      throw new Error(
        `Installed ${pkg} files do not match the checksum manifest (expected ${pinned.join(', ')}; found ${files.join(', ')}).`
      );
    for (const file of files) {
      const key = `${pkg}/${file}`;
      const bytes = readFileSync(join(root, file));
      const expectedBlob = manifest.files[key];
      if (!SHA1.test(expectedBlob ?? '') || gitBlobId(bytes) !== expectedBlob)
        throw new Error(
          `Installed ${key} does not match the immutable upstream blob.`
        );
      const expectedSha256 = manifest.sha256[key];
      if (
        !SHA256.test(expectedSha256 ?? '') ||
        sha256(bytes) !== expectedSha256
      )
        throw new Error(`Installed ${key} does not match its pinned SHA-256.`);
      verified += 1;
    }
    // package.json is verified above, so its entry points are trustworthy.
    if (!files.includes('package.json'))
      throw new Error(`Remus checksum manifest omits ${pkg}/package.json.`);
    const packageJson = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8')
    );
    if (packageJson.name !== pkg)
      throw new Error(
        `Installed ${pkg} package.json names ${packageJson.name}.`
      );
    const entries = entryPoints(packageJson, files);
    const missing = entries.filter((entry) => !files.includes(entry));
    if (missing.length > 0 || !files.some((file) => file.endsWith('.wasm')))
      throw new Error(
        `Remus checksum manifest omits ${pkg} entry points (${missing.join(', ') || 'no .wasm module'}).`
      );
  }
  return verified;
}

/** Runs `gh api` against github.com, whatever `GH_HOST` says. */
export function githubApi(path, run = execFileSync) {
  return JSON.parse(
    run('gh', ['api', '--hostname', 'github.com', path], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
  );
}

/**
 * Upstream blob ids of a Remus directory at the pinned commit, keyed by
 * relative path, from the authenticated contents API.
 */
export function upstreamBlobs(
  commit,
  upstreamPath,
  api = githubApi,
  prefix = ''
) {
  if (!SHA1.test(commit)) throw new Error('Invalid Remus commit.');
  const listing = api(
    `repos/${UPSTREAM_REPOSITORY}/contents/${posix.join(upstreamPath, prefix)}?ref=${commit}`
  );
  if (!Array.isArray(listing))
    throw new Error(`Upstream ${upstreamPath}/${prefix} is not a directory.`);
  const blobs = new Map();
  for (const entry of listing) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === 'dir')
      for (const [child, sha] of upstreamBlobs(commit, upstreamPath, api, path))
        blobs.set(child, sha);
    else if (entry.type === 'file' && SHA1.test(entry.sha ?? ''))
      blobs.set(path, entry.sha);
    else
      throw new Error(
        `Unsupported upstream Remus entry ${upstreamPath}/${path}.`
      );
  }
  return blobs;
}

/**
 * Builds a manifest for `commit` from the upstream tree: the expected file
 * list comes from upstream (tree plus packaging rules), each installed file
 * must match its upstream blob, and every entry point must be present. A
 * manifest that drops a file the previous one listed needs `allowShrink`.
 */
export function recordRemusManifest({
  commit,
  packageDirs,
  upstream = (upstreamPath) => upstreamBlobs(commit, upstreamPath),
  previous = null,
  allowShrink = false
}) {
  const manifest = { commit, files: {}, sha256: {} };
  for (const [pkg, upstreamPath] of REMUS_PACKAGES) {
    const root = packageDirs[pkg];
    const blobs = upstream(upstreamPath);
    if (!blobs.has('package.json'))
      throw new Error(`Upstream ${pkg} has no package.json at ${commit}.`);
    const packageBytes = readFileSync(join(root, 'package.json'));
    if (gitBlobId(packageBytes) !== blobs.get('package.json'))
      throw new Error(
        `Installed ${pkg}/package.json does not match the immutable upstream blob.`
      );
    const packageJson = JSON.parse(packageBytes.toString('utf8'));
    if (packageJson.name !== pkg)
      throw new Error(
        `Upstream ${pkg} package.json names ${packageJson.name}.`
      );
    const expected = packedFiles([...blobs.keys()], packageJson);
    const missingEntries = entryPoints(packageJson, expected).filter(
      (entry) => !expected.includes(entry)
    );
    if (missingEntries.length > 0)
      throw new Error(
        `Upstream ${pkg} does not pack its entry points (${missingEntries.join(', ')}).`
      );
    if (!expected.some((file) => file.endsWith('.wasm')))
      throw new Error(`Upstream ${pkg} packs no WebAssembly module.`);
    const installed = packageFiles(root);
    if (installed.join('\n') !== expected.join('\n'))
      throw new Error(
        `Installed ${pkg} files do not match the upstream package (expected ${expected.join(', ')}; found ${installed.join(', ')}).`
      );
    for (const file of expected) {
      const key = `${pkg}/${file}`;
      const bytes = readFileSync(join(root, file));
      if (gitBlobId(bytes) !== blobs.get(file))
        throw new Error(
          `Installed ${key} does not match the immutable upstream blob.`
        );
      manifest.files[key] = blobs.get(file);
      manifest.sha256[key] = sha256(bytes);
    }
  }
  if (previous && !allowShrink) {
    const dropped = Object.keys(previous.files ?? {}).filter(
      (key) => !(key in manifest.files)
    );
    if (dropped.length > 0)
      throw new Error(
        `The new Remus manifest drops ${dropped.join(', ')}. Review the upstream change and re-run with --allow-shrink.`
      );
  }
  const sorted = (entries) =>
    Object.fromEntries(
      Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1))
    );
  return {
    commit,
    files: sorted(manifest.files),
    sha256: sorted(manifest.sha256)
  };
}

/**
 * Verifies the given (or installed) package directories against the
 * repository's manifest and lockfile pin. Returns the build stamp recorded in
 * `build-meta.json`.
 */
export function verifyRemusArtifacts({ repoRoot, packageDirs } = {}) {
  const root = resolve(repoRoot ?? '.');
  const manifestBytes = readFileSync(join(root, MANIFEST));
  const commit = remusPin(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const files = verifyRemusPackages({
    manifest: JSON.parse(manifestBytes.toString('utf8')),
    commit,
    packageDirs: packageDirs ?? installedPackageDirs(root)
  });
  return { commit, files, manifestSha256: sha256(manifestBytes) };
}
