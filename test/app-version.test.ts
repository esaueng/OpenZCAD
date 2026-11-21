import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_VERSION_FILES,
  assertNewAppBase,
  buildAppVersion,
  checkAppVersion,
  isAppVersion,
  isUserFacingSubject,
  nextAppVersion,
  parseAppVersion,
  readAppVersions,
  setAppVersion
} from '../scripts/app-version.mjs';
import {
  appBuildDetail,
  appBuildLabel,
  resolveAppBuild
} from '../apps/web/src/lib/appBuild';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SYNTHETIC_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const fixtures: string[] = [];

/** A copy of just the manifests that carry the version. */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openzcad-app-version-'));
  fixtures.push(root);
  for (const { path } of APP_VERSION_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(root, path));
  }
  return root;
}

/** Runs git in `root` without the caller's identity, hooks or signing. */
function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=OpenZCAD test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

function commit(root: string, subject: string): void {
  git(root, 'commit', '--quiet', '--allow-empty', '-m', subject);
}

/** A git repository whose first commit sets the base version. */
function gitFixtureRepo(): string {
  const root = fixtureRepo();
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'add', '--all');
  commit(root, 'feat(version): set the base');
  return root;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('app version scheme', () => {
  it('accepts YYYY.RELEASE.PATCH from the first year of the scheme', () => {
    expect(parseAppVersion('2026.1.0')).toEqual({
      year: 2026,
      release: 1,
      patch: 0
    });
    expect(isAppVersion('2027.12.40')).toBe(true);
  });

  it('refuses the pre-scheme number, release 0, leading zeros and suffixes', () => {
    for (const value of [
      '0.1.0',
      '2025.1.0',
      '2026.0.3',
      '2026.01.0',
      '2026.1',
      '2026.1.0-beta.1',
      '2026.1.0+local',
      '',
      undefined
    ]) {
      expect(isAppVersion(value), String(value)).toBe(false);
    }
  });

  it('bumps a patch within the release and resets it for a release', () => {
    expect(nextAppVersion('2026.1.0', 'patch')).toBe('2026.1.1');
    expect(nextAppVersion('2026.1.4', 'release')).toBe('2026.2.0');
    expect(() =>
      nextAppVersion('2026.1.0', 'major' as unknown as 'patch')
    ).toThrow('--bump patch or --bump release');
  });
});

describe('app version manifests', () => {
  it('repeats one well-formed version in every manifest that carries it', () => {
    // The desktop bundle (Tauri, Cargo) and the web build must report the
    // same number; a hand edit to one of them fails here and in the build.
    const version = checkAppVersion(REPO_ROOT);
    expect(isAppVersion(version)).toBe(true);
    expect(
      readAppVersions(REPO_ROOT).map((file) => [file.path, file.version])
    ).toEqual(APP_VERSION_FILES.map(({ path }) => [path, version]));
  });

  it('rewrites every manifest in place and touches nothing else', () => {
    const root = fixtureRepo();
    const before = APP_VERSION_FILES.map(({ path }) =>
      readFileSync(join(root, path), 'utf8')
    );
    const current = checkAppVersion(root);
    const next = nextAppVersion(current, 'release');

    expect(setAppVersion(root, next)).toEqual(
      APP_VERSION_FILES.map(({ path }) => path)
    );
    expect(checkAppVersion(root)).toBe(next);
    APP_VERSION_FILES.forEach(({ path }, index) => {
      const after = readFileSync(join(root, path), 'utf8');
      // Only the version text changed: putting the old one back restores
      // the file byte for byte.
      expect(after.replace(next, current)).toBe(before[index]);
    });
    expect(setAppVersion(root, next)).toEqual([]);
  });

  it('names the manifest that disagrees with package.json', () => {
    const root = fixtureRepo();
    const current = checkAppVersion(root);
    setAppVersion(root, nextAppVersion(current, 'patch'));
    // Put one copy back by hand, the drift the check exists to catch.
    const tauri = 'apps/desktop/src-tauri/tauri.conf.json';
    cpSync(join(REPO_ROOT, tauri), join(root, tauri));
    expect(() => checkAppVersion(root)).toThrow(`${tauri} (${current})`);
  });

  it('refuses to write a malformed version', () => {
    expect(() => setAppVersion(fixtureRepo(), '2026.1')).toThrow(
      'YYYY.RELEASE.PATCH'
    );
  });
});

describe('app build version', () => {
  it('counts feat, fix, perf and revert merges, typed or breaking', () => {
    for (const subject of [
      'feat(f01): extrude up to the next face (schema v130) (#1847)',
      'fix: report a dismissed share sheet (#1859)',
      'perf(kernel)!: reuse measured geometry',
      'revert: feat(x): something',
      'Revert "feat(x): something (#12)"'
    ]) {
      expect(isUserFacingSubject(subject), subject).toBe(true);
    }
    for (const subject of [
      'docs(roadmap): fold evidence',
      'test(pattern): give grid row fusion cases room (#1857)',
      'chore(release): OpenZCAD 2026.2.0',
      'ci: stage fleet v9',
      'refactor: split the solver',
      'Speed up exact CAD rebuilds (#1809)',
      'feature: not a type'
    ]) {
      expect(isUserFacingSubject(subject), subject).toBe(false);
    }
  });

  it('adds one patch per user-facing merge since the base was set', () => {
    const root = gitFixtureRepo();
    const base = checkAppVersion(root);
    const { year, release, patch } = parseAppVersion(base);
    expect(buildAppVersion(root)).toEqual({
      version: base,
      base,
      merges: 0,
      exact: true
    });

    for (const subject of [
      'feat(sketch): a feature (#1)',
      'docs: a guide (#2)',
      'fix: a bug (#3)',
      'test: a case (#4)',
      'perf!: a speedup (#5)',
      'Revert "feat(sketch): a feature (#1)" (#6)'
    ]) {
      commit(root, subject);
    }
    expect(buildAppVersion(root)).toMatchObject({
      version: `${year}.${release}.${patch + 4}`,
      merges: 4,
      exact: true
    });

    // A release bump starts a new base, counted from its own merge.
    const next = nextAppVersion(buildAppVersion(root).version, 'release');
    setAppVersion(root, next);
    // Until it is committed the build reports the new base as is.
    expect(buildAppVersion(root)).toMatchObject({ version: next, merges: 0 });
    git(root, 'add', '--all');
    commit(root, `chore(release): OpenZCAD ${next}`);
    commit(root, 'fix(export): another bug (#7)');
    expect(buildAppVersion(root)).toMatchObject({
      version: nextAppVersion(next, 'patch'),
      base: next,
      merges: 1
    });
  });

  it('deepens a shallow clone instead of mistaking its boundary for the base', () => {
    const origin = gitFixtureRepo();
    for (let index = 0; index < 5; index += 1) {
      commit(origin, `fix: bug ${index}`);
    }
    commit(origin, 'docs: a note');
    const clone = mkdtempSync(join(tmpdir(), 'openzcad-app-version-clone-'));
    fixtures.push(clone);
    git(clone, 'clone', '--quiet', '--depth=1', `file://${origin}`, '.');
    const base = checkAppVersion(clone);
    const { year, release, patch } = parseAppVersion(base);

    // The boundary commit looks like it added the base; it must not count
    // as zero merges since the base.
    expect(buildAppVersion(clone)).toMatchObject({
      version: base,
      exact: false,
      reason: 'the clone is shallow'
    });
    expect(() => buildAppVersion(clone, { required: true })).toThrow(
      'the clone is shallow'
    );
    expect(buildAppVersion(clone, { fetch: true, required: true })).toEqual({
      version: `${year}.${release}.${patch + 5}`,
      base,
      merges: 5,
      exact: true
    });
  });

  it('only takes a new base that opens a later release or year', () => {
    // A committed patch base races the merges queued beside it.
    expect(() =>
      assertNewAppBase('2026.1.0', '2026.1.103', '2026.1.104')
    ).toThrow('--bump release');
    expect(() =>
      assertNewAppBase('2026.1.0', '2026.1.103', '2026.1.50')
    ).toThrow('builds already report 2026.1.103');
    expect(() =>
      assertNewAppBase('2026.2.0', '2026.2.3', '2026.1.9')
    ).toThrow();
    // Re-setting the current base repairs a drifted manifest.
    expect(() =>
      assertNewAppBase('2026.1.0', '2026.1.103', '2026.1.0')
    ).not.toThrow();
    expect(() =>
      assertNewAppBase('2026.1.0', '2026.1.103', '2026.2.0')
    ).not.toThrow();
    expect(() =>
      assertNewAppBase('2026.1.0', '2026.1.103', '2027.1.0')
    ).not.toThrow();
  });

  it('reports the base outside a git checkout unless the build requires history', () => {
    const root = fixtureRepo();
    expect(buildAppVersion(root)).toMatchObject({
      version: checkAppVersion(root),
      exact: false
    });
    expect(() => buildAppVersion(root, { required: true })).toThrow(
      'not a git checkout'
    );
  });
});

describe('app build identity', () => {
  const build = resolveAppBuild({
    OZ_APP_VERSION: '2026.1.0',
    OZ_BUILD_COMMIT: SYNTHETIC_COMMIT
  });

  it('labels the row with the version and an abbreviated commit', () => {
    expect(appBuildLabel(build)).toBe('OpenZCAD 2026.1.0 · 0123456');
    expect(appBuildDetail(build)).toBe(
      `OpenZCAD 2026.1.0 — esaueng/OpenZCAD@${SYNTHETIC_COMMIT}`
    );
  });

  it('says unknown rather than undefined outside a Vite build', () => {
    expect(resolveAppBuild({})).toEqual({
      version: 'unknown',
      sourceCommit: 'unknown'
    });
    expect(appBuildLabel(resolveAppBuild({}))).toBe(
      'OpenZCAD unknown · unknown'
    );
  });
});
