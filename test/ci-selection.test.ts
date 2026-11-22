import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  additiveUnitManifest,
  browserSpecsFromChanges,
  changedPaths,
  selectCI
} from '../scripts/ci-selection.mjs';
import {
  DEFAULT_UNIT_WEIGHT_SECONDS,
  discoverRelatedFiles,
  mergeUnitWeights,
  parseUnitShard,
  partitionUnitFiles,
  readUnitWeights,
  relatedFiles,
  listProjectFiles,
  runUnits,
  selectedFiles,
  UNIT_ROOT_WEIGHTS_PATH,
  weightsFromVitestReports
} from '../scripts/run-ci-units.mjs';
import { unitTestInclude } from '../scripts/unit-suites.mjs';

describe('critical and affected CI selection', () => {
  it('narrows only semantic additions that preserve both critical manifests', () => {
    const before = { root: ['test/auth.test.ts'], web: ['src/App.test.tsx'] };
    const after = { ...before, root: [...before.root, 'test/io.test.ts'] };
    expect(
      additiveUnitManifest(JSON.stringify(before), JSON.stringify(after))
    ).toBe(true);
    for (const invalid of [
      before,
      { ...after, root: ['test/io.test.ts'] },
      { ...after, web: [] },
      { ...after, root: [...after.root, 'test/io.test.ts'] },
      { ...after, extra: [] },
      { ...after, root: ['../auth.test.ts'] }
    ])
      expect(
        additiveUnitManifest(JSON.stringify(before), JSON.stringify(invalid))
      ).toBe(false);
    expect(additiveUnitManifest('not JSON', JSON.stringify(after))).toBe(false);
    expect(
      selectCI(['test/unit-ci-files.json'], { manifestAdditions: true }).unit
    ).toBe('smoke');
    expect(selectCI(['test/unit-ci-files.json']).unit).toBe('full');
    expect(
      selectCI(['test/unit-ci-files.json', 'pnpm-lock.yaml'], {
        manifestAdditions: true
      }).unit
    ).toBe('full');
  });

  it('retains critical policy tests and invalidates dynamically loaded package assets', () => {
    for (const path of [
      '.github/workflows/dependency-audit.yml',
      'scripts/dependency-audit-selection.mjs',
      'scripts/install-cargo-audit.sh'
    ])
      expect(selectCI([path]).unit).toBe('smoke');
    for (const path of [
      'packages/kernel-adapter/src/fixture.json',
      'packages/kernel-adapter/src/kernel.wasm',
      'packages/shared/src/template.svg'
    ])
      expect(selectCI([path]).unit).toBe('full');
    expect(unitTestInclude('root', { CI: 'true' })).toContain(
      'test/css-class-coverage.test.ts'
    );
    expect(unitTestInclude('root', { CI: 'true' })).toContain(
      'test/ci-runtime-optimization.test.ts'
    );
  });
  it('runs the full project on failed discovery and preserves the real test exit code', () => {
    const calls: string[][] = [];
    const status = runUnits(
      ['root'],
      { OPENZCAD_UNIT_SUITE: 'smoke' },
      (_file, args, options) => {
        calls.push(args);
        expect(options.env.OPENZCAD_UNIT_SUITE).toBe('full');
        expect(options.env.OPENZCAD_UNIT_FILES).toBeUndefined();
        return { status: 17 };
      }
    );
    expect(status).toBe(17);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('vitest.full.config.ts');
  });
  it('retains complete unit validation for unknown and foundational inputs', () => {
    for (const paths of [
      [],
      ['pnpm-lock.yaml'],
      ['package.json'],
      ['scripts/new.mjs'],
      ['.github/workflows/ci.yml'],
      ['test/support/kernel.ts'],
      ['new-configuration.json'],
      ['packages/kernel-adapter/package.json']
    ]) {
      expect(selectCI(paths)).toEqual({ unit: 'full', e2e: 'smoke' });
    }
    for (const options of [
      { event: 'schedule' },
      { event: 'workflow_dispatch' },
      { labels: ['ci:full'] },
      { labels: ['kernel-bump'] },
      { deleted: true }
    ])
      expect(
        selectCI(['apps/web/src/components/TopBar.tsx'], options).unit
      ).toBe('full');
    expect(selectCI(['apps/web/src/components/TopBar.tsx'])).toEqual({
      unit: 'smoke',
      e2e: 'smoke'
    });
  });

  it('reserves full browsers for explicit qualification and removed browser regressions', () => {
    for (const options of [
      { event: 'schedule' },
      { event: 'workflow_dispatch' },
      { labels: ['ci:full'] }
    ])
      expect(selectCI(['apps/web/src/App.tsx'], options)).toEqual({
        unit: 'full',
        e2e: 'full'
      });
    expect(selectCI(['pnpm-lock.yaml'], { labels: ['kernel-bump'] })).toEqual({
      unit: 'full',
      e2e: 'smoke'
    });
    expect(selectCI(['test/e2e/deleted.spec.ts'], { deleted: true })).toEqual({
      unit: 'full',
      e2e: 'full'
    });
    expect(
      selectCI(['.github/workflows/checks.yml'], { deleted: true })
    ).toEqual({ unit: 'full', e2e: 'smoke' });
  });

  it('selects changed untagged browser regressions and refuses deleted specs', () => {
    expect(
      browserSpecsFromChanges(
        ['test/e2e/new-regression.spec.ts', 'apps/web/src/App.tsx'],
        ['new-regression.spec.ts', 'modeling.spec.ts']
      )
    ).toEqual(['new-regression.spec.ts']);
    expect(() =>
      browserSpecsFromChanges(['test/e2e/deleted.spec.ts'], [])
    ).toThrow('missing');
  });

  it('adds affected files outside the smoke manifest without dropping critical contracts', () => {
    const extra = 'test/account-deletion.test.ts';
    const selected = selectedFiles('root', [extra, extra], {});
    expect(selected.filter((name) => name === extra)).toHaveLength(1);
    for (const file of unitTestInclude('root', { CI: 'true' })!)
      expect(selected).toContain(file);
    expect(
      unitTestInclude('root', {
        OPENZCAD_UNIT_SUITE: 'smoke',
        OPENZCAD_UNIT_FILES: JSON.stringify({ root: selected })
      })
    ).toEqual(selected);
  });

  it('validates Vitest discovery against real project files and refuses escaped or stale inventories', () => {
    expect(
      relatedFiles(
        'root',
        [{ file: resolve('test/auth.test.ts') }],
        process.cwd()
      )
    ).toEqual(['test/auth.test.ts']);
    expect(relatedFiles('root', [], process.cwd())).toEqual([]);
    expect(() => relatedFiles('root', {}, process.cwd())).toThrow('array');
    expect(() =>
      relatedFiles('root', [{ file: '../outside.test.ts' }], process.cwd())
    ).toThrow('escaped');
    expect(() =>
      relatedFiles('root', [{ file: 'test/missing.test.ts' }], process.cwd())
    ).toThrow('Missing');
    expect(() => relatedFiles('root', [{}], process.cwd())).toThrow(
      'lacks a file'
    );
  });

  it('keeps smoke selection when only docs markdown files are deleted', () => {
    expect(
      selectCI(['ROADMAP.md', 'docs/roadmap-evidence/f01--old.md'], {
        deleted: true,
        deletedPaths: ['docs/roadmap-evidence/f01--old.md']
      })
    ).toEqual({ unit: 'smoke', e2e: 'smoke' });
    expect(
      selectCI(['docs/roadmap-evidence/f01--old.md', 'apps/web/src/old.ts'], {
        deleted: true,
        deletedPaths: [
          'docs/roadmap-evidence/f01--old.md',
          'apps/web/src/old.ts'
        ]
      })
    ).toEqual({ unit: 'full', e2e: 'smoke' });
    expect(
      selectCI(['docs/notes.md', 'test/e2e/deleted.spec.ts'], {
        deleted: true,
        deletedPaths: ['test/e2e/deleted.spec.ts']
      })
    ).toEqual({ unit: 'full', e2e: 'full' });
    // A docs deletion must not narrow combined-tree browser coverage of an
    // edited spec: any deletion plus a spec change still runs the full matrix.
    expect(
      selectCI(
        [
          'docs/roadmap-evidence/f01--old.md',
          'test/e2e/import-formats.spec.ts'
        ],
        {
          deleted: true,
          deletedPaths: ['docs/roadmap-evidence/f01--old.md']
        }
      ).e2e
    ).toBe('full');
  });

  it('takes the full shard inventory from Vitest and runs every inventoried file once', () => {
    // Fake inventory: Vitest resolves the full glob in a subprocess; the
    // runner partitions exactly what it reports, never its own file walk.
    const inventory = [
      'test/account-deletion.test.ts',
      'test/ci-selection.test.ts',
      'test/unit-suites.test.ts',
      'test/e2e-shards.test.ts'
    ];
    const ran: string[] = [];
    for (const shard of ['1/3', '2/3', '3/3']) {
      const status = runUnits(
        ['root', `--shard=${shard}`],
        { OPENZCAD_UNIT_SUITE: 'full' },
        (_file, args, options) => {
          if (args.includes('--list-all')) {
            writeFileSync(
              args.at(-1)!,
              JSON.stringify(inventory.map((file) => resolve(file)))
            );
            return { status: 0 };
          }
          expect(args).toContain('vitest.config.ts');
          expect(args.join(' ')).not.toContain('--shard');
          ran.push(
            ...(
              JSON.parse(options.env.OPENZCAD_UNIT_FILES!) as {
                root: string[];
              }
            ).root
          );
          return { status: 0 };
        }
      );
      expect(status).toBe(0);
    }
    expect(ran.sort()).toEqual([...inventory].sort());
  });

  it('runs the complete project on a shard whose inventory or discovery fails', () => {
    // Sibling shards select independently; a shard that cannot list or
    // discover must not narrow to any partition of a list it could not trust.
    const cases = [
      { OPENZCAD_UNIT_SUITE: 'full', listing: 1 },
      { OPENZCAD_UNIT_SUITE: 'full', listing: 0, empty: true },
      { OPENZCAD_UNIT_SUITE: 'smoke', CI_BASE_SHA: 'not-a-sha', listing: 0 }
    ];
    for (const { listing, empty, ...env } of cases) {
      for (const shard of ['1/3', '3/3']) {
        const runs: { args: string[]; files?: string; suite?: string }[] = [];
        const status = runUnits(
          ['root', `--shard=${shard}`],
          env,
          (_file, args, options) => {
            if (args.includes('--list-all')) {
              if (empty) writeFileSync(args.at(-1)!, '[]');
              return { status: listing };
            }
            runs.push({
              args,
              files: options.env.OPENZCAD_UNIT_FILES,
              suite: options.env.OPENZCAD_UNIT_SUITE
            });
            return { status: 0 };
          }
        );
        expect(status).toBe(0);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.args).toContain('vitest.full.config.ts');
        expect(runs[0]!.args.join(' ')).not.toContain('--shard');
        expect(runs[0]!.files).toBeUndefined();
        expect(runs[0]!.suite).toBe('full');
      }
    }
  });

  it('balances root unit shards deterministically and assigns every file once', async () => {
    expect(parseUnitShard('2/3')).toEqual({ shard: 2, total: 3 });
    expect(() => parseUnitShard('0/3')).toThrow();
    expect(() => parseUnitShard('4/3')).toThrow();

    const weights = readUnitWeights();
    const smoke = unitTestInclude('root', { CI: 'true' })!;
    const allRoot = relatedFiles(
      'root',
      await listProjectFiles(process.cwd()),
      process.cwd()
    );
    expect(allRoot.length).toBeGreaterThan(800);
    expect(allRoot.length).toBeGreaterThan(smoke.length);
    for (const file of smoke) expect(allRoot).toContain(file);

    for (const files of [smoke, allRoot]) {
      const shards = partitionUnitFiles(files, weights, 3);
      expect(shards.every((shard) => shard.files.length > 0)).toBe(true);
      expect(shards.flatMap((shard) => shard.files).sort()).toEqual(
        [...files].sort()
      );
    }

    // Unmeasured-fast files weigh 0 s; ties must still spread across shards.
    expect(
      partitionUnitFiles(['a', 'b', 'c'], { a: 0, b: 0, c: 0 }, 3).map(
        (shard) => shard.files
      )
    ).toEqual([['a'], ['b'], ['c']]);

    const toy = partitionUnitFiles(
      ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'],
      { 'a.test.ts': 10, 'b.test.ts': 6, 'c.test.ts': 5 },
      2
    );
    // d uses DEFAULT_UNIT_WEIGHT_SECONDS (2): 10 vs 6+5+2 -> 10+2=12 vs 6+5=11
    expect(toy).toEqual([
      {
        files: ['a.test.ts', 'd.test.ts'],
        seconds: 10 + DEFAULT_UNIT_WEIGHT_SECONDS
      },
      { files: ['b.test.ts', 'c.test.ts'], seconds: 11 }
    ]);

    expect(
      weightsFromVitestReports([
        {
          testResults: [
            {
              name: '/home/runner/work/OpenZCAD/OpenZCAD/test/auth.test.ts',
              startTime: 1000,
              endTime: 3550
            }
          ]
        }
      ])
    ).toEqual({ 'test/auth.test.ts': 2.6 });

    expect(
      mergeUnitWeights(
        { 'test/kept.test.ts': 5, 'test/gone.test.ts': 9 },
        { 'test/kept.test.ts': 7, 'test/new.test.ts': 1.2 },
        ['test/kept.test.ts', 'test/new.test.ts']
      )
    ).toEqual({ 'test/kept.test.ts': 7, 'test/new.test.ts': 1.2 });

    expect(readFileSync(UNIT_ROOT_WEIGHTS_PATH, 'utf8')).toBe(
      `${JSON.stringify(weights, null, 2)}\n`
    );
  }, 60_000);

  it('discovers related tests on shallow disconnected history without falling back to full', async () => {
    // Regression: CI clones HEAD at depth=1 and fetches base at depth=1, so
    // `git diff base...HEAD` fails with "no merge base". changedPaths uses a
    // two-dot diff and runUnits passes those paths to --list-related instead.
    const dir = mkdtempSync(join(tmpdir(), 'ci-shallow-discovery-'));
    const remote = join(dir, 'remote.git');
    const work = join(dir, 'work');
    const shallow = join(dir, 'shallow');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=example-user',
          '-c',
          'user.email=example-user@example.invalid',
          '-c',
          'commit.gpgsign=false',
          '-c',
          `core.hooksPath=${join(dir, 'no-hooks')}`,
          ...args
        ],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();
    try {
      mkdirSync(remote, { recursive: true });
      mkdirSync(work, { recursive: true });
      git(remote, 'init', '--bare', '--quiet');
      git(work, 'init', '--quiet');
      git(work, 'remote', 'add', 'origin', remote);
      writeFileSync(join(work, 'a.txt'), 'v1\n');
      git(work, 'add', '.');
      git(work, 'commit', '--quiet', '-m', 'base');
      const base = git(work, 'rev-parse', 'HEAD');
      git(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');

      writeFileSync(join(work, 'a.txt'), 'v2\n');
      git(work, 'add', '.');
      git(work, 'commit', '--quiet', '-m', 'middle');
      writeFileSync(join(work, 'b.txt'), 'v3\n');
      git(work, 'add', '.');
      git(work, 'commit', '--quiet', '-m', 'head');
      git(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/feature');

      git(
        dir,
        'clone',
        '--quiet',
        '--depth=1',
        '--branch',
        'feature',
        `file://${remote}`,
        shallow
      );
      git(
        shallow,
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth=1',
        'origin',
        base
      );
      // Confirm no merge base exists, matching GitHub Actions shallow checkout.
      expect(() => git(shallow, 'merge-base', base, 'HEAD')).toThrow();
      expect(changedPaths(base, shallow)).toEqual(['a.txt', 'b.txt']);

      // Explicit-path Vitest discovery resolves changed tests without Git.
      const discovered = await discoverRelatedFiles(process.cwd(), [
        resolve('test/account-deletion.test.ts')
      ]);
      expect(relatedFiles('root', discovered, process.cwd())).toEqual([
        'test/account-deletion.test.ts'
      ]);

      // Zero-change base (HEAD) stays on smoke without invoking discovery.
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8'
      }).trim();
      const observedCalls: string[][] = [];
      const status = runUnits(
        ['root', '--shard=1/3'],
        {
          OPENZCAD_UNIT_SUITE: 'smoke',
          CI_BASE_SHA: head
        },
        (_file, args, options) => {
          observedCalls.push(args);
          expect(options.env.OPENZCAD_UNIT_SUITE).toBe('smoke');
          expect(options.env.OPENZCAD_UNIT_FILES).toBeDefined();
          return { status: 0 };
        }
      );
      expect(status).toBe(0);
      expect(observedCalls).toHaveLength(1);
      expect(observedCalls[0]).toContain('vitest.config.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
