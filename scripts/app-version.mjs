#!/usr/bin/env node
/**
 * The OpenZCAD app version: `YYYY.RELEASE.PATCH`, the scheme Remus uses for
 * the kernel (docs/versioning.md). The root `package.json` is the source of
 * truth; the web and desktop manifests repeat it so each tool that reads its
 * own manifest (npm, Tauri, Cargo) reports the same number.
 *
 *   node scripts/app-version.mjs                 # print the version
 *   node scripts/app-version.mjs --check         # every manifest agrees
 *   node scripts/app-version.mjs --bump patch    # 2026.1.0 -> 2026.1.1
 *   node scripts/app-version.mjs --bump release  # 2026.1.4 -> 2026.2.0
 *   node scripts/app-version.mjs --set 2027.1.0  # open a new year's line
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The first year of the scheme; older numbers belong to `0.1.0`. */
const FIRST_YEAR = 2026;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DESKTOP_CRATE = 'openzcad-desktop';

/**
 * Every file that carries the app version. The first one is authoritative.
 * `kind` selects how the version is read and rewritten, always as a textual
 * replacement so the files keep their formatting.
 */
export const APP_VERSION_FILES = Object.freeze([
  { path: 'package.json', kind: 'json' },
  { path: 'apps/web/package.json', kind: 'json' },
  { path: 'apps/desktop/package.json', kind: 'json' },
  { path: 'apps/desktop/src-tauri/tauri.conf.json', kind: 'json' },
  { path: 'apps/desktop/src-tauri/Cargo.toml', kind: 'cargo-manifest' },
  { path: 'apps/desktop/src-tauri/Cargo.lock', kind: 'cargo-lock' }
]);

/** Parses `YYYY.RELEASE.PATCH`, throwing on anything else. */
export function parseAppVersion(value) {
  const match = typeof value === 'string' ? VERSION.exec(value) : null;
  const parts = match?.slice(1).map(Number);
  if (
    !parts ||
    !parts.every(Number.isSafeInteger) ||
    parts[0] < FIRST_YEAR ||
    parts[1] < 1
  ) {
    throw new Error(
      `Expected an app version YYYY.RELEASE.PATCH (year >= ${FIRST_YEAR}, release >= 1), got ${JSON.stringify(value)}.`
    );
  }
  const [year, release, patch] = parts;
  return { year, release, patch };
}

export function isAppVersion(value) {
  try {
    parseAppVersion(value);
    return true;
  } catch {
    return false;
  }
}

/** The next version for a `patch` fix or a planned `release`. */
export function nextAppVersion(current, part) {
  const { year, release, patch } = parseAppVersion(current);
  if (part === 'patch') return `${year}.${release}.${patch + 1}`;
  if (part === 'release') return `${year}.${release + 1}.0`;
  throw new Error(`Expected --bump patch or --bump release, got ${part}.`);
}

// Each pattern captures (prefix)(version)(suffix) for the one occurrence
// that is the app version: the first top-level `"version"` key, the
// `[package]` table's version, the desktop crate's lockfile entry.
const PATTERNS = {
  json: /^(\{[^]*?\n {2}"version": ")([^"]*)(")/,
  'cargo-manifest':
    /^(\[package\](?:\n(?!\[)[^\n]*)*?\nversion = ")([^"]*)(")/m,
  'cargo-lock': new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${DESKTOP_CRATE}"\\nversion = ")([^"]*)(")`
  )
};

function locate(text, { path, kind }) {
  const match = PATTERNS[kind].exec(text);
  if (!match) throw new Error(`${path} has no app version to read.`);
  return match;
}

/** The version each file declares, in `APP_VERSION_FILES` order. */
export function readAppVersions(repoRoot) {
  return APP_VERSION_FILES.map((file) => ({
    path: file.path,
    version: locate(readFileSync(join(repoRoot, file.path), 'utf8'), file)[2]
  }));
}

/**
 * The app version, once it is well formed and every manifest repeats it.
 * Builds call this, so a hand edit to one manifest fails the build instead
 * of shipping a desktop app and a web app that disagree.
 */
export function checkAppVersion(repoRoot) {
  const [source, ...copies] = readAppVersions(repoRoot);
  parseAppVersion(source.version);
  const stale = copies.filter((copy) => copy.version !== source.version);
  if (stale.length > 0) {
    throw new Error(
      `App version ${source.version} (package.json) is not repeated by ${stale
        .map((copy) => `${copy.path} (${copy.version})`)
        .join(', ')}. Run node scripts/app-version.mjs --set ${source.version}.`
    );
  }
  return source.version;
}

/** Writes `version` into every manifest and returns the files it changed. */
export function setAppVersion(repoRoot, version) {
  parseAppVersion(version);
  const changed = [];
  for (const file of APP_VERSION_FILES) {
    const target = join(repoRoot, file.path);
    const text = readFileSync(target, 'utf8');
    const match = locate(text, file);
    if (match[2] === version) continue;
    const start = match.index + match[1].length;
    writeFileSync(
      target,
      `${text.slice(0, start)}${version}${text.slice(start + match[2].length)}`
    );
    changed.push(file.path);
  }
  return changed;
}

function main(args) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const [flag, value] = args;
  if (flag === undefined) {
    console.log(checkAppVersion(repoRoot));
    return;
  }
  if (flag === '--check' && value === undefined) {
    console.log(`App version ${checkAppVersion(repoRoot)} is consistent.`);
    return;
  }
  if ((flag === '--bump' || flag === '--set') && value !== undefined) {
    const current = readAppVersions(repoRoot)[0].version;
    const next =
      flag === '--bump' ? nextAppVersion(current, value) : value.trim();
    // Moving off the pre-scheme 0.1.0 has nothing to compare against.
    if (flag === '--set' && isAppVersion(current)) {
      const [a, b] = [parseAppVersion(current), parseAppVersion(next)];
      const order =
        a.year - b.year || a.release - b.release || a.patch - b.patch;
      if (order > 0) {
        throw new Error(
          `Refusing to move the app version back from ${current} to ${next}.`
        );
      }
    }
    const changed = setAppVersion(repoRoot, next);
    console.log(
      `App version ${current} -> ${next}${changed.length ? `: ${changed.join(', ')}` : ' (no change)'}`
    );
    return;
  }
  throw new Error(
    'Usage: node scripts/app-version.mjs [--check | --bump patch|release | --set YYYY.RELEASE.PATCH]'
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
