import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Balanced Playwright shards for CI.
 *
 * Playwright's own `--shard=k/n` cuts the alphabetically ordered test list
 * into `n` equal *counts*, so a shard's wall time is decided by which file
 * names happen to sort next to each other. Here the slow specs cluster under
 * `c` and `g` (cloud-sync, command-contract, cylinder-preview, growing-holder),
 * so shard 1 of 4 ran 19.7 minutes while the others ran 6 to 8 — and that one
 * shard was the whole `ci` wall clock.
 *
 * This script instead assigns whole spec files to shards by recorded seconds
 * (longest-processing-time first, into the lightest shard), reading the
 * weights from `test/e2e/shard-weights.json`. Every `*.spec.ts` in the
 * directory is assigned exactly once; a file with no recorded weight gets
 * `DEFAULT_WEIGHT_SECONDS`, so a new spec runs on its first CI pass without
 * touching the weights file. Refresh the weights from the `e2e-report-*`
 * artifacts a `ci` run uploads:
 *
 *   node scripts/e2e-shards.mjs --update path/to/e2e-report-*.json
 *
 * and print the file filters for one shard (what the workflow passes to
 * `playwright test`):
 *
 *   node scripts/e2e-shards.mjs 3/6
 */

export const SPEC_DIR = 'test/e2e';
export const WEIGHTS_PATH = 'test/e2e/shard-weights.json';
/** Mirrors `testMatch` in `playwright.config.ts`; the test keeps them equal. */
export const SPEC_PATTERN = /\.spec\.ts$/;
/**
 * Spec paths the filters can carry literally: Playwright reads a positional
 * argument as a regular expression and the workflow splits the script's
 * output on whitespace, so a name with a space, a bracket or another
 * metacharacter would select nothing or something else. Such a spec is
 * refused outright rather than silently left out of every shard.
 */
export const SAFE_SPEC_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** Seconds assumed for a spec with no recorded weight. */
export const DEFAULT_WEIGHT_SECONDS = 60;

/**
 * Every spec under the directory, as `/`-separated paths relative to it,
 * sorted. Playwright collects `testDir` recursively, so a spec in a
 * subdirectory has to be found here too or no shard would ever run it.
 *
 * @returns {string[]}
 */
export function listSpecs(dir = SPEC_DIR) {
  const specs = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && SPEC_PATTERN.test(entry.name)) {
        specs.push(relative(dir, path).split(sep).join('/'));
      }
    }
  };
  visit(dir);
  return specs.sort((a, b) => a.localeCompare(b));
}

/** @param {string} value like `3/6` */
export function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(value ?? ''));
  if (!match) throw new Error(`Expected a shard like 3/6, got "${value}".`);
  const shard = Number(match[1]);
  const total = Number(match[2]);
  if (shard > total) throw new Error(`Shard ${shard} exceeds total ${total}.`);
  return { shard, total };
}

/**
 * Longest-processing-time-first assignment: heaviest file into the lightest
 * shard. Ties break on name and then on shard index so the output is a pure
 * function of the inputs.
 *
 * @param {string[]} specs
 * @param {Record<string, number>} weights seconds per spec basename
 * @param {number} total
 * @returns {{ files: string[]; seconds: number }[]}
 */
export function partitionSpecs(specs, weights, total) {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`Shard total must be a positive integer, got ${total}.`);
  }
  const seconds = (spec) => {
    const weight = weights[spec];
    return typeof weight === 'number' && Number.isFinite(weight) && weight >= 0
      ? weight
      : DEFAULT_WEIGHT_SECONDS;
  };
  const ordered = [...specs].sort(
    (a, b) => seconds(b) - seconds(a) || a.localeCompare(b)
  );
  const shards = Array.from({ length: total }, () => ({
    files: [],
    seconds: 0
  }));
  for (const spec of ordered) {
    let lightest = shards[0];
    for (const shard of shards) {
      if (shard.seconds < lightest.seconds) lightest = shard;
    }
    lightest.files.push(spec);
    lightest.seconds += seconds(spec);
  }
  for (const shard of shards) shard.files.sort((a, b) => a.localeCompare(b));
  return shards;
}

/**
 * The `playwright test` file filters for one shard. Playwright treats each
 * positional argument as a case-insensitive regular expression over the
 * file path, so the filter carries the directory: a bare basename such as
 * `cloud-sync.spec.ts` would also select `import-cloud-sync.spec.ts`.
 */
export function shardFilters(shard, total, specs, weights) {
  const unsafe = specs.filter((spec) => !SAFE_SPEC_PATH.test(spec));
  if (unsafe.length > 0) {
    throw new Error(
      `Spec paths must match ${SAFE_SPEC_PATH} to be passed to playwright test literally: ${unsafe.join(', ')}`
    );
  }
  const partition = partitionSpecs(specs, weights, total);
  return partition[shard - 1].files.map((spec) => `${SPEC_DIR}/${spec}`);
}

/**
 * Seconds per spec file from Playwright JSON reports (`--reporter=json`),
 * summing every attempt so a retried test counts what it really cost. The
 * report names files relative to `testDir`, the same key `listSpecs` uses.
 *
 * @param {unknown[]} reports parsed reports
 * @returns {Record<string, number>}
 */
export function weightsFromReports(reports) {
  const totals = {};
  const reportFile = (value) =>
    typeof value === 'string' ? value.split('\\').join('/') : undefined;
  const visit = (suite, inherited) => {
    if (!suite || typeof suite !== 'object') return;
    const file = reportFile(suite.file) ?? inherited;
    for (const spec of suite.specs ?? []) {
      const specFile = reportFile(spec.file) ?? file;
      if (!specFile) continue;
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          const duration = Number(result.duration);
          if (Number.isFinite(duration)) {
            totals[specFile] = (totals[specFile] ?? 0) + duration / 1000;
          }
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child, file);
  };
  for (const report of reports) {
    for (const suite of report?.suites ?? []) visit(suite, undefined);
  }
  return Object.fromEntries(
    Object.keys(totals)
      .sort((a, b) => a.localeCompare(b))
      .map((file) => [file, Math.round(totals[file])])
  );
}

/**
 * Merge fresh measurements into the checked-in weights: measured files take
 * the new value, unmeasured files keep theirs, and files no longer on disk
 * drop out so the list cannot rot.
 */
export function mergeWeights(current, measured, specs) {
  const next = {};
  for (const spec of [...specs].sort((a, b) => a.localeCompare(b))) {
    const value = measured[spec] ?? current[spec];
    if (typeof value === 'number') next[spec] = value;
  }
  return next;
}

export function readWeights(path = WEIGHTS_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '--update') {
    if (rest.length === 0) {
      throw new Error('Pass at least one Playwright JSON report to --update.');
    }
    const reports = rest.map((path) => JSON.parse(readFileSync(path, 'utf8')));
    const next = mergeWeights(
      readWeights(),
      weightsFromReports(reports),
      listSpecs()
    );
    writeFileSync(WEIGHTS_PATH, `${JSON.stringify(next, null, 2)}\n`);
    for (const shard of partitionSpecs(listSpecs(), next, rest.length)) {
      console.error(`${Math.round(shard.seconds)}s ${shard.files.join(' ')}`);
    }
  } else {
    const { shard, total } = parseShard(command);
    const filters = shardFilters(shard, total, listSpecs(), readWeights());
    if (filters.length === 0) {
      throw new Error(`Shard ${shard}/${total} would run no spec files.`);
    }
    console.log(filters.join('\n'));
  }
}
