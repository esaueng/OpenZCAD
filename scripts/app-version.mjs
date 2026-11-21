#!/usr/bin/env node
/**
 * The OpenZCAD app version: `YYYY.RELEASE.PATCH`, the scheme Remus uses for
 * the kernel (docs/versioning.md). The root `package.json` holds the base
 * version; the web and desktop manifests repeat it so each tool that reads its
 * own manifest (npm, Tauri, Cargo) reports the same number.
 *
 * A build reports the base plus one patch for every user-facing merge since
 * the base was set (`buildAppVersion`), so the number advances on every
 * `feat`, `fix`, `perf` or `revert` merge without a version PR.
 *
 *   node scripts/app-version.mjs                 # print the base version
 *   node scripts/app-version.mjs --build         # print the version a build reports
 *   node scripts/app-version.mjs --check         # every manifest agrees
 *   node scripts/app-version.mjs --bump release  # 2026.1.104 -> 2026.2.0
 *   node scripts/app-version.mjs --set 2027.1.0  # open a new year's line
 */
import { execFileSync } from 'node:child_process';
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

/**
 * A merge that changes what users get. Squash merges are titled with the
 * Conventional Commits type of their PR; `docs`, `test`, `chore`, `ci`,
 * `build`, `refactor` and `style` merges, and untyped titles, do not count.
 */
const USER_FACING_SUBJECT =
  /^(?:(?:feat|fix|perf|revert)(?:\([^)]*\))?!?:|Revert ")/;

export function isUserFacingSubject(subject) {
  return USER_FACING_SUBJECT.test(subject);
}

/** Public, so a build without an `origin` remote can still fetch history. */
const PUBLIC_REMOTE = 'https://github.com/esaueng/OpenZCAD.git';
const FIRST_DEEPEN = 64;
const MAX_DEEPEN = 4096;

function gitRunner(repoRoot) {
  return (...args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

function shallowBoundary(git, repoRoot) {
  if (git('rev-parse', '--is-shallow-repository') !== 'true') return null;
  const file = resolve(repoRoot, git('rev-parse', '--git-path', 'shallow'));
  return new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean));
}

/**
 * The newest first-parent commit that set `package.json` to `base`, or null
 * when HEAD's history never did (an uncommitted bump). A shallow clone shows
 * its oldest commit as adding every line, so a match on the boundary, or no
 * match above it, means the history is too short to answer yet.
 */
function findBaseCommit(git, repoRoot, base) {
  const added = git(
    'log',
    '--first-parent',
    '--format=%H',
    '-S',
    `"version": "${base}"`,
    'HEAD',
    '--',
    'package.json'
  )
    .split('\n')
    .filter(Boolean);
  const boundary = shallowBoundary(git, repoRoot);
  const commit = added[0] ?? null;
  if (boundary && (!commit || boundary.has(commit))) return undefined;
  return commit;
}

function deepen(git, depth) {
  const head = git('rev-parse', 'HEAD');
  const remotes = git('remote').split('\n').filter(Boolean);
  const sources = remotes.includes('origin')
    ? ['origin', PUBLIC_REMOTE]
    : [PUBLIC_REMOTE];
  const how = depth > MAX_DEEPEN ? ['--unshallow'] : [`--deepen=${depth}`];
  for (const source of sources) {
    try {
      git('fetch', '--quiet', '--no-tags', ...how, source, head);
      return true;
    } catch {
      // Try the next source.
    }
  }
  return false;
}

/**
 * The version a build reports: the base in `package.json` plus one patch per
 * user-facing first-parent merge since the commit that set it. A shallow
 * clone is deepened when `fetch` allows it.
 *
 * Without the history it needs, it throws when `required` and otherwise
 * returns the base with `exact: false`, so a dev server still runs while
 * every build fails instead of shipping the base as if nothing had merged.
 */
export function buildAppVersion(repoRoot, options = {}) {
  return countAppVersion(repoRoot, checkAppVersion(repoRoot), options);
}

function countAppVersion(
  repoRoot,
  base,
  { fetch = false, required = false } = {}
) {
  const inexact = (reason) => {
    if (required) {
      throw new Error(
        `Cannot work out the app version: ${reason}. The build counts user-facing merges since ${base} was set, so it needs the git history back to that commit (docs/versioning.md).`
      );
    }
    return { version: base, base, merges: 0, exact: false, reason };
  };
  const git = gitRunner(repoRoot);
  try {
    git('rev-parse', 'HEAD');
  } catch {
    return inexact('the source tree is not a git checkout');
  }
  let since = findBaseCommit(git, repoRoot, base);
  for (
    let depth = FIRST_DEEPEN;
    since === undefined && fetch && depth <= MAX_DEEPEN * 2;
    depth *= 2
  ) {
    if (!deepen(git, depth)) break;
    since = findBaseCommit(git, repoRoot, base);
  }
  if (since === undefined) {
    return inexact(
      fetch ? 'the shallow clone could not be deepened' : 'the clone is shallow'
    );
  }
  const subjects = since
    ? git('log', '--first-parent', '--format=%s', `${since}..HEAD`)
        .split('\n')
        .filter(Boolean)
    : [];
  const merges = subjects.filter(isUserFacingSubject).length;
  const { year, release, patch } = parseAppVersion(base);
  return {
    version: `${year}.${release}.${patch + merges}`,
    base,
    merges,
    exact: true
  };
}

/**
 * Refuses a new base that a build could report below what users already
 * see. Patch numbers are counted, so a new base must open a later release
 * or year: a committed patch base races the merges queued beside it
 * (base 2026.1.104 lands after two fixes already reported 2026.1.105).
 * Re-setting the current base, to repair a drifted manifest, is allowed.
 */
export function assertNewAppBase(currentBase, reported, next) {
  const [from, to] = [parseAppVersion(reported), parseAppVersion(next)];
  if (next === currentBase) return;
  if (
    to.year > from.year ||
    (to.year === from.year && to.release > from.release)
  )
    return;
  throw new Error(
    `Refusing to set the app version base to ${next}: builds already report ${reported}, and patch numbers are counted from merges. Open a new release with --bump release or a new year with --set YYYY.1.0.`
  );
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
  if (flag === '--build' && value === undefined) {
    const build = buildAppVersion(repoRoot, { fetch: true });
    console.log(
      build.exact
        ? `${build.version} (base ${build.base} + ${build.merges} user-facing merges)`
        : `${build.version} (base only: ${build.reason})`
    );
    return;
  }
  if (
    ((flag === '--bump' && value === 'release') || flag === '--set') &&
    value !== undefined
  ) {
    // Only the root manifest: --set is also how a drifted copy is repaired.
    const current = readAppVersions(repoRoot)[0].version;
    // Moving off the pre-scheme 0.1.0 has nothing to compare against.
    const reported = isAppVersion(current)
      ? countAppVersion(repoRoot, current, { fetch: true, required: true })
          .version
      : current;
    const next =
      flag === '--bump' ? nextAppVersion(reported, value) : value.trim();
    if (isAppVersion(current)) assertNewAppBase(current, reported, next);
    const changed = setAppVersion(repoRoot, next);
    const files = changed.length ? `: ${changed.join(', ')}` : ' (no change)';
    console.log(
      next === current
        ? `App version base ${current} rewritten${files}`
        : `App version ${reported} -> ${next}${files}`
    );
    return;
  }
  throw new Error(
    'Usage: node scripts/app-version.mjs [--check | --build | --bump release | --set YYYY.RELEASE.PATCH]'
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
