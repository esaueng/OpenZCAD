import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHT_SECONDS,
  listSpecs,
  mergeWeights,
  parseShard,
  partitionSpecs,
  readWeights,
  shardFilters,
  SPEC_DIR,
  SPEC_PATTERN,
  weightsFromReports
} from '../scripts/e2e-shards.mjs';

/**
 * The CI matrix passes each shard's file list to `playwright test`, so the
 * assignment is a gate: a spec left out of every shard never runs, and one
 * assigned twice wastes a runner. The shard count here mirrors
 * `.github/workflows/fleet-ci.yml`.
 */
const CI_SHARDS = 6;

describe('balanced e2e shards', () => {
  const specs = listSpecs();
  const weights = readWeights();

  it('assigns every spec file on disk to exactly one CI shard', () => {
    const assigned = Array.from({ length: CI_SHARDS }, (_, index) =>
      shardFilters(index + 1, CI_SHARDS, specs, weights)
    ).flat();
    expect(assigned.length).toBeGreaterThan(0);
    expect([...assigned].sort()).toEqual(
      specs.map((spec) => `${SPEC_DIR}/${spec}`).sort()
    );
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it('emits filters Playwright resolves to one file each', () => {
    // Positional arguments become case-insensitive regular expressions over
    // the absolute path; the directory prefix keeps `cloud-sync.spec.ts` from
    // also selecting `import-cloud-sync.spec.ts`.
    const paths = specs.map((spec) => `/repo/${SPEC_DIR}/${spec}`);
    for (const filter of shardFilters(1, 1, specs, weights)) {
      const matcher = new RegExp(filter, 'i');
      expect(paths.filter((path) => matcher.test(path))).toHaveLength(1);
    }
  });

  it('discovers exactly what Playwright is configured to collect', () => {
    // Playwright's default testMatch also takes `*.test.ts` and `*.spec.tsx`;
    // such a file would run locally yet land in no CI shard. The config pins
    // the pattern to what this script discovers, so the two cannot drift.
    expect(readFileSync('playwright.config.ts', 'utf8')).toMatch(
      /testMatch:\s*'\*\*\/\*\.spec\.ts'/
    );
    expect(SPEC_PATTERN.test('a.spec.ts')).toBe(true);
    for (const name of ['a.test.ts', 'a.spec.tsx', 'a.spec.js', 'a.spec.mts']) {
      expect(SPEC_PATTERN.test(name)).toBe(false);
    }
  });

  it('finds specs in subdirectories, as Playwright collects testDir', () => {
    // A nested spec that only Playwright's recursive collection saw would be
    // in no shard's file list, and `e2e` would go green without running it.
    const dir = mkdtempSync(join(tmpdir(), 'e2e-shards-'));
    try {
      mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true });
      writeFileSync(join(dir, 'b.spec.ts'), '');
      writeFileSync(join(dir, 'a.spec.ts'), '');
      writeFileSync(join(dir, 'helper.ts'), '');
      writeFileSync(join(dir, 'nested', 'c.spec.ts'), '');
      writeFileSync(join(dir, 'nested', 'deeper', 'd.spec.ts'), '');
      expect(listSpecs(dir)).toEqual([
        'a.spec.ts',
        'b.spec.ts',
        'nested/c.spec.ts',
        'nested/deeper/d.spec.ts'
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the recorded weights in step with the spec directory', () => {
    // A weight for a deleted spec is a stale entry that only misleads the
    // next rebalance; a missing weight is allowed and gets the default.
    expect(
      Object.keys(weights).filter((file) => !specs.includes(file))
    ).toEqual([]);
    for (const value of Object.values(weights)) {
      expect(Number.isFinite(value) && value >= 0).toBe(true);
    }
    expect(readFileSync('test/e2e/shard-weights.json', 'utf8')).toBe(
      `${JSON.stringify(weights, null, 2)}\n`
    );
  });

  it('balances by longest-processing-time first, deterministically', () => {
    const plan = partitionSpecs(
      ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts', 'e.spec.ts'],
      { 'a.spec.ts': 10, 'b.spec.ts': 8, 'c.spec.ts': 7, 'd.spec.ts': 3 },
      2
    );
    // e has no weight, so it counts DEFAULT_WEIGHT_SECONDS, goes first and
    // fills one shard on its own; everything else lands in the other.
    expect(plan).toEqual([
      { files: ['e.spec.ts'], seconds: DEFAULT_WEIGHT_SECONDS },
      {
        files: ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts'],
        seconds: 28
      }
    ]);
    expect(partitionSpecs(['x.spec.ts'], {}, 3).map((s) => s.files)).toEqual([
      ['x.spec.ts'],
      [],
      []
    ]);
  });

  it('parses shard arguments and refuses impossible ones', () => {
    expect(parseShard('3/6')).toEqual({ shard: 3, total: 6 });
    expect(() => parseShard('0/6')).toThrow();
    expect(() => parseShard('7/6')).toThrow();
    expect(() => parseShard('3')).toThrow();
  });

  it('sums every attempt of every test per file from JSON reports', () => {
    const report = {
      suites: [
        {
          file: 'slow.spec.ts',
          specs: [
            {
              file: 'slow.spec.ts',
              tests: [{ results: [{ duration: 90_000 }, { duration: 30_000 }] }]
            }
          ],
          suites: [
            {
              specs: [{ tests: [{ results: [{ duration: 1_500 }] }] }]
            }
          ]
        },
        {
          file: 'nested\\fast.spec.ts',
          specs: [{ tests: [{ results: [{ duration: 2_000 }] }] }]
        }
      ]
    };
    expect(weightsFromReports([report, report])).toEqual({
      'nested/fast.spec.ts': 4,
      'slow.spec.ts': 243
    });
  });

  it('merges measurements without keeping deleted specs', () => {
    expect(
      mergeWeights(
        { 'kept.spec.ts': 5, 'gone.spec.ts': 9, 'stale.spec.ts': 1 },
        { 'kept.spec.ts': 7, 'new.spec.ts': 2 },
        ['kept.spec.ts', 'new.spec.ts', 'unmeasured.spec.ts', 'stale.spec.ts']
      )
    ).toEqual({ 'kept.spec.ts': 7, 'new.spec.ts': 2, 'stale.spec.ts': 1 });
  });
});
