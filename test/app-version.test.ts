import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_VERSION_FILES,
  checkAppVersion,
  isAppVersion,
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
