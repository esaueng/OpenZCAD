import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import {
  gitBlobId,
  githubApi,
  packedFiles,
  recordRemusManifest,
  REMUS_PACKAGES,
  sha256,
  upstreamBlobs,
  verifyRemusArtifacts,
  verifyRemusPackages,
  type RemusManifest
} from '../scripts/remus-artifacts.mjs';
import { checkReleaseBuild } from '../scripts/check-release-build.mjs';
import { RELEASE_BUILD_CHECK } from '../scripts/validate-deployment-config.mjs';
import { remusArtifactGate } from '../apps/web/build/remusArtifactGate';

const COMMIT = 'c'.repeat(40);
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** The files of one fake Remus package, as upstream publishes them. */
function packageSource(pkg: string): Record<string, string> {
  const stem = pkg.replace(/-/g, '_');
  return {
    'package.json': JSON.stringify({
      name: pkg,
      main: `${stem}_node.cjs`,
      module: `${stem}.js`,
      types: `${stem}.d.ts`,
      exports: {
        '.': { node: `./${stem}_node.cjs`, import: `./${stem}.js` },
        [`./${stem}_bg.wasm`]: `./${stem}_bg.wasm`
      },
      files: [
        `${stem}_bg.wasm`,
        `${stem}.js`,
        `${stem}.d.ts`,
        'NOTICE',
        `${stem}_node.cjs`
      ]
    }),
    [`${stem}.js`]: `export const kernel = '${pkg}';`,
    [`${stem}_node.cjs`]: `module.exports = '${pkg}';`,
    [`${stem}.d.ts`]: 'export declare const kernel: string;',
    [`${stem}_bg.wasm`]: `\0asm${pkg}`,
    NOTICE: 'notice',
    // Present upstream but never packed.
    '.gitignore': '*',
    [`${stem}_bg.wasm.d.ts`]: 'export {};'
  };
}

function writeFiles(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
}

const blobs = (files: Record<string, string>) =>
  new Map(
    Object.entries(files).map(([name, text]) => [
      name,
      gitBlobId(Buffer.from(text))
    ])
  );

/** A repository root with the installed packages, the lock pin and a manifest. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'remus-artifacts-'));
  scratch.push(root);
  const packageDirs: Record<string, string> = {};
  const upstream = new Map<string, Map<string, string>>();
  for (const [pkg, upstreamPath] of REMUS_PACKAGES) {
    const source = packageSource(pkg);
    const installed = { ...source };
    delete installed['.gitignore'];
    delete installed[`${pkg.replace(/-/g, '_')}_bg.wasm.d.ts`];
    const dir = join(root, 'packages/kernel-adapter/node_modules', pkg);
    writeFiles(dir, installed);
    packageDirs[pkg] = dir;
    upstream.set(upstreamPath, blobs(source));
  }
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    `remus-wasm: https://codeload.github.com/esaueng/remus/tar.gz/${COMMIT}#path:/crates/wasm/pkg\n`
  );
  const record = (
    options: { previous?: RemusManifest | null; allowShrink?: boolean } = {}
  ) =>
    recordRemusManifest({
      commit: COMMIT,
      packageDirs,
      upstream: (path) => upstream.get(path)!,
      ...options
    });
  const manifest = record();
  writeFileSync(join(root, 'remus-checksums.json'), JSON.stringify(manifest));
  return { root, packageDirs, upstream, manifest, record };
}

describe('Remus package recording', () => {
  it('packs exactly what upstream publishes through its files list', () => {
    const { manifest } = fixtureRepo();
    expect(Object.keys(manifest.files)).toEqual([
      'remus-wasm-io/NOTICE',
      'remus-wasm-io/package.json',
      'remus-wasm-io/remus_wasm_io.d.ts',
      'remus-wasm-io/remus_wasm_io.js',
      'remus-wasm-io/remus_wasm_io_bg.wasm',
      'remus-wasm-io/remus_wasm_io_node.cjs',
      'remus-wasm/NOTICE',
      'remus-wasm/package.json',
      'remus-wasm/remus_wasm.d.ts',
      'remus-wasm/remus_wasm.js',
      'remus-wasm/remus_wasm_bg.wasm',
      'remus-wasm/remus_wasm_node.cjs'
    ]);
    expect(Object.keys(manifest.sha256)).toEqual(Object.keys(manifest.files));
  });

  it('matches the pinned production manifest inventory', () => {
    const pinned = JSON.parse(
      readFileSync('remus-checksums.json', 'utf8')
    ) as RemusManifest;
    for (const [pkg] of REMUS_PACKAGES) {
      const stem = pkg.replace(/-/g, '_');
      const upstream = [
        '.gitignore',
        'LICENSE-APACHE',
        'NOTICE',
        'package.json',
        `${stem}.d.ts`,
        `${stem}.js`,
        `${stem}_bg.js`,
        `${stem}_bg.wasm`,
        `${stem}_bg.wasm.d.ts`,
        `${stem}_node.cjs`
      ];
      const packageJson = {
        main: `${stem}_node.cjs`,
        files: [
          `${stem}_bg.wasm`,
          `${stem}.js`,
          `${stem}_bg.js`,
          `${stem}.d.ts`,
          'LICENSE-APACHE',
          'NOTICE',
          `${stem}_node.cjs`
        ]
      };
      expect(
        packedFiles(upstream, packageJson).map((file) => `${pkg}/${file}`)
      ).toEqual(
        Object.keys(pinned.files).filter((key) => key.startsWith(`${pkg}/`))
      );
    }
  });

  it('refuses a missing installed file instead of recording a smaller manifest', () => {
    const { packageDirs, record } = fixtureRepo();
    rmSync(join(packageDirs['remus-wasm']!, 'remus_wasm.js'));
    expect(() => record()).toThrow(
      'Installed remus-wasm files do not match the upstream package'
    );
  });

  it('refuses an extra installed file', () => {
    const { packageDirs, record } = fixtureRepo();
    writeFileSync(join(packageDirs['remus-wasm-io']!, 'extra.js'), '');
    expect(() => record()).toThrow(
      'Installed remus-wasm-io files do not match the upstream package'
    );
  });

  it('refuses installed bytes that differ from the upstream blob', () => {
    const { packageDirs, record } = fixtureRepo();
    writeFileSync(
      join(packageDirs['remus-wasm']!, 'remus_wasm.js'),
      'tampered'
    );
    expect(() => record()).toThrow(
      'remus-wasm/remus_wasm.js does not match the immutable upstream blob'
    );
  });

  it('refuses an upstream package that packs no module or misses an entry point', () => {
    const { upstream, record } = fixtureRepo();
    const empty = new Map(
      [...upstream.get('crates/wasm/pkg')!].filter(
        ([name]) => name === 'package.json'
      )
    );
    upstream.set('crates/wasm/pkg', empty);
    expect(() => record()).toThrow('does not pack its entry points');
  });

  it('refuses a manifest that drops a pinned file unless explicitly allowed', () => {
    const { manifest, record } = fixtureRepo();
    const previous = {
      ...manifest,
      files: {
        ...manifest.files,
        'remus-wasm/remus_wasm_bg.js': 'a'.repeat(40)
      }
    };
    expect(() => record({ previous })).toThrow(
      'drops remus-wasm/remus_wasm_bg.js'
    );
    expect(record({ previous, allowShrink: true })).toEqual(manifest);
  });

  it('lists upstream directories on github.com whatever GH_HOST says', () => {
    const run = vi.fn(() => '[]');
    expect(githubApi('repos/esaueng/remus/contents/x', run)).toEqual([]);
    expect(run).toHaveBeenCalledWith(
      'gh',
      ['api', '--hostname', 'github.com', 'repos/esaueng/remus/contents/x'],
      expect.objectContaining({ encoding: 'utf8' })
    );
  });

  it('reads nested upstream directories and refuses links', () => {
    const api = (path: string) =>
      path.includes('/pkg/snippets')
        ? [{ type: 'file', name: 'a.js', sha: 'b'.repeat(40) }]
        : [
            { type: 'file', name: 'package.json', sha: 'a'.repeat(40) },
            { type: 'dir', name: 'snippets' }
          ];
    expect([...upstreamBlobs(COMMIT, 'crates/wasm/pkg', api)]).toEqual([
      ['package.json', 'a'.repeat(40)],
      ['snippets/a.js', 'b'.repeat(40)]
    ]);
    expect(() =>
      upstreamBlobs(COMMIT, 'crates/wasm/pkg', () => [
        { type: 'symlink', name: 'x', sha: 'a'.repeat(40) }
      ])
    ).toThrow('Unsupported upstream Remus entry');
    expect(() => upstreamBlobs('main', 'crates/wasm/pkg', () => [])).toThrow(
      'Invalid Remus commit'
    );
  });
});

describe('Remus package verification', () => {
  it('passes the pinned packages and fails on a changed byte', () => {
    const { root, packageDirs } = fixtureRepo();
    expect(verifyRemusArtifacts({ repoRoot: root }).files).toBe(12);
    writeFileSync(
      join(packageDirs['remus-wasm-io']!, 'remus_wasm_io.js'),
      'tampered'
    );
    expect(() => verifyRemusArtifacts({ repoRoot: root })).toThrow(
      'remus-wasm-io/remus_wasm_io.js does not match the immutable upstream blob'
    );
  });

  it('refuses an empty or entry-point-free manifest', () => {
    const { manifest, packageDirs } = fixtureRepo();
    const without = (prefix: string) => ({
      commit: COMMIT,
      files: Object.fromEntries(
        Object.entries(manifest.files).filter(
          ([key]) => !key.startsWith(prefix)
        )
      ),
      sha256: Object.fromEntries(
        Object.entries(manifest.sha256).filter(
          ([key]) => !key.startsWith(prefix)
        )
      )
    });
    expect(() =>
      verifyRemusPackages({
        manifest: without('remus-wasm/'),
        commit: COMMIT,
        packageDirs
      })
    ).toThrow('lists no remus-wasm files');
    // A package trimmed to its package.json, installed and pinned alike.
    for (const name of [
      'remus_wasm.js',
      'remus_wasm_node.cjs',
      'remus_wasm.d.ts',
      'remus_wasm_bg.wasm',
      'NOTICE'
    ])
      rmSync(join(packageDirs['remus-wasm']!, name));
    const trimmed = without('remus-wasm/remus_wasm');
    delete trimmed.files['remus-wasm/NOTICE'];
    delete trimmed.sha256['remus-wasm/NOTICE'];
    expect(() =>
      verifyRemusPackages({ manifest: trimmed, commit: COMMIT, packageDirs })
    ).toThrow('omits remus-wasm entry points');
  });

  it('checks the directories it is given, such as local overlays', () => {
    const { root, packageDirs } = fixtureRepo();
    const overlay = join(root, 'overlay');
    writeFiles(overlay, { 'package.json': '{"name":"remus-wasm"}' });
    expect(() =>
      verifyRemusArtifacts({
        repoRoot: root,
        packageDirs: { ...packageDirs, 'remus-wasm': overlay }
      })
    ).toThrow('Installed remus-wasm files do not match the checksum manifest');
  });
});

describe('Vite Remus package gate', () => {
  const stamp = { commit: COMMIT, files: 16, manifestSha256: 'f'.repeat(64) };
  const failing = () => {
    throw new Error('changed bytes');
  };

  it('verifies the installed packages for every build and returns the stamp', () => {
    const verify = vi.fn<typeof verifyRemusArtifacts>(() => stamp);
    expect(
      remusArtifactGate({
        command: 'build',
        repoRoot: '.',
        env: {},
        overlay: null,
        verify
      })
    ).toEqual(stamp);
    const dirs = verify.mock.calls[0]![0]!.packageDirs!;
    expect(Object.keys(dirs)).toEqual(['remus-wasm', 'remus-wasm-io']);
    expect(dirs['remus-wasm']).toContain('remus-wasm');
  });

  it('fails builds but only warns in dev and preview', () => {
    expect(() =>
      remusArtifactGate({
        command: 'build',
        repoRoot: '.',
        env: {},
        overlay: null,
        verify: failing
      })
    ).toThrow('Remus package verification failed: changed bytes');
    const warn = vi.fn();
    expect(
      remusArtifactGate({
        command: 'serve',
        repoRoot: '.',
        env: {},
        overlay: null,
        verify: failing,
        warn
      })
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('changed bytes'));
  });

  it('refuses overlay builds without the explicit opt-in and verifies the overlay directories', () => {
    const overlay = { 'remus-wasm': '/qa/kernel', 'remus-wasm-io': '/qa/io' };
    expect(() =>
      remusArtifactGate({
        command: 'build',
        repoRoot: '.',
        env: {},
        overlay,
        verify: failing
      })
    ).toThrow('OZ_ALLOW_LOCAL_REMUS=1');
    const verify = vi.fn<typeof verifyRemusArtifacts>(failing);
    const warn = vi.fn();
    expect(
      remusArtifactGate({
        command: 'build',
        repoRoot: '.',
        env: { OZ_ALLOW_LOCAL_REMUS: '1' },
        overlay,
        verify,
        warn
      })
    ).toBeNull();
    expect(verify.mock.calls[0]![0]!.packageDirs).toBe(overlay);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot be deployed')
    );
    // Dev servers keep the overlay route without an opt-in.
    expect(
      remusArtifactGate({
        command: 'serve',
        repoRoot: '.',
        env: {},
        overlay,
        verify: failing,
        warn
      })
    ).toBeNull();
  });

  it('runs inside the shared Vite config for web and desktop builds', () => {
    const config = readFileSync('apps/web/vite.config.ts', 'utf8');
    expect(config).toContain('remusArtifactGate({');
    expect(config).toContain('overlay: localRemus?.aliases ?? null');
    expect(config).toContain('artifacts: remusArtifacts');
  });
});

describe('release build check', () => {
  function releaseFixture() {
    const repo = fixtureRepo();
    const dist = join(repo.root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    for (const [pkg] of REMUS_PACKAGES) {
      const stem = pkg.replace(/-/g, '_');
      writeFileSync(
        join(dist, 'assets', `${stem}_bg-hash.wasm`),
        readFileSync(join(repo.packageDirs[pkg]!, `${stem}_bg.wasm`))
      );
    }
    const verified = verifyRemusArtifacts({ repoRoot: repo.root });
    const writeMeta = (remus: Record<string, unknown>) =>
      writeFileSync(
        join(dist, 'build-meta.json'),
        JSON.stringify({
          format: 'openzcad-build-metadata',
          commit: 'x',
          remus
        })
      );
    writeMeta({ version: '2026.1.1', commit: COMMIT, artifacts: verified });
    return { ...repo, dist, verified, writeMeta };
  }

  it('accepts a stamped build that ships the pinned modules', () => {
    const { root, verified } = releaseFixture();
    expect(checkReleaseBuild({ repoRoot: root, dist: 'dist' })).toEqual(
      verified
    );
  });

  it('refuses local overlay output', () => {
    const { root, verified, writeMeta } = releaseFixture();
    writeMeta({
      version: '2026.1.1+local',
      commit: COMMIT,
      local: true,
      artifacts: verified
    });
    expect(() => checkReleaseBuild({ repoRoot: root, dist: 'dist' })).toThrow(
      '+local'
    );
  });

  it('refuses unstamped or stale output', () => {
    const { root, verified, writeMeta } = releaseFixture();
    writeMeta({ version: '2026.1.1', commit: COMMIT });
    expect(() => checkReleaseBuild({ repoRoot: root, dist: 'dist' })).toThrow(
      'was not built from the verified'
    );
    writeMeta({
      version: '2026.1.1',
      commit: COMMIT,
      artifacts: { ...verified, manifestSha256: sha256(Buffer.from('old')) }
    });
    expect(() => checkReleaseBuild({ repoRoot: root, dist: 'dist' })).toThrow(
      'was not built from the verified'
    );
    expect(() =>
      checkReleaseBuild({ repoRoot: root, dist: 'missing' })
    ).toThrow('no build metadata');
  });

  it('refuses output whose WebAssembly is not the pinned module', () => {
    const { root, dist } = releaseFixture();
    writeFileSync(join(dist, 'assets', 'remus_wasm_bg-hash.wasm'), 'other');
    expect(() => checkReleaseBuild({ repoRoot: root, dist: 'dist' })).toThrow(
      'does not ship the pinned remus-wasm/remus_wasm_bg.wasm'
    );
  });

  it('refuses output when the installed packages no longer verify', () => {
    const { root, packageDirs } = releaseFixture();
    writeFileSync(join(packageDirs['remus-wasm']!, 'NOTICE'), 'changed');
    expect(() => checkReleaseBuild({ repoRoot: root, dist: 'dist' })).toThrow(
      'remus-wasm/NOTICE'
    );
  });
});

describe('deploy paths run the release build check', () => {
  const scripts = (path: string) =>
    (
      JSON.parse(readFileSync(path, 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
  const wranglerBuild = (path: string) => {
    const parsed = ts.parseConfigFileTextToJson(
      path,
      readFileSync(path, 'utf8')
    );
    return (parsed.config as { build?: { command?: string } }).build?.command;
  };

  it('checks before migrating or publishing', () => {
    const beta = scripts('apps/web/package.json')['deploy:beta']!;
    expect(beta.startsWith(`${RELEASE_BUILD_CHECK} && `)).toBe(true);
    expect(beta.indexOf('check:release-build')).toBeLessThan(
      beta.indexOf('apply-beta-migrations')
    );
    const selfhost = scripts('package.json')['deploy:selfhost']!;
    expect(selfhost).toContain('pnpm build && pnpm check:release-build && ');
    expect(scripts('package.json')['check:release-build']).toBe(
      'node scripts/check-release-build.mjs'
    );
  });

  it('makes raw wrangler deploys and version uploads check the output', () => {
    expect(wranglerBuild('wrangler.jsonc')).toBe(RELEASE_BUILD_CHECK);
    expect(wranglerBuild('wrangler.selfhost.example.jsonc')).toBe(
      RELEASE_BUILD_CHECK
    );
  });
});
