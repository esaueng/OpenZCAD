#!/usr/bin/env node
/**
 * Summaries for the viewport frame-timing probe
 * (test/e2e/perf-frame-timing.spec.ts), which writes one JSON file per
 * scene and CPU-throttle rate into `artifacts/perf/<label>`.
 *
 *   node scripts/frame-timing-report.mjs <run-dir>
 *     rewrites <run-dir>/summary.{json,md} from the run's per-test files.
 *
 *   node scripts/frame-timing-report.mjs --compare \
 *     before=<dir>[,<dir>...] after=<dir>[,<dir>...] [--out <file.md>]
 *     compares two builds over repeated runs: each cell is the median of the
 *     runs with their min–max spread, so run-to-run noise stays visible.
 *
 * The numbers come from desktop Chromium with CDP CPU throttling and an
 * iPad-sized touch viewport: a proxy, never a device measurement.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** One display refresh at 60 Hz, the rate an iPad without ProMotion runs at. */
export const VSYNC_MS = 1000 / 60;

/**
 * Nearest-rank percentiles, mean and max.
 * @param {readonly number[]} values
 */
export function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (/** @type {number} */ fraction) =>
    sorted.length === 0
      ? null
      : sorted[
          Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
        ];
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    mean: sorted.length
      ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
      : null,
    max: sorted.at(-1) ?? null
  };
}

/**
 * Display refreshes that showed no new frame, from consecutive frame
 * intervals: an interval spanning n refreshes missed n − 1 of them. The
 * percentage is of all refreshes the gesture lasted.
 * @param {readonly number[]} intervals
 * @param {number} [periodMs]
 */
export function droppedFrames(intervals, periodMs = VSYNC_MS) {
  let refreshes = 0;
  let missed = 0;
  for (const interval of intervals) {
    if (!(interval > 0)) continue;
    const spans = Math.max(1, Math.round(interval / periodMs));
    refreshes += spans;
    missed += spans - 1;
  }
  return {
    missed,
    refreshes,
    pct: refreshes === 0 ? null : (100 * missed) / refreshes
  };
}

/**
 * The per-test result files of one run, ordered by scene then rate.
 * @param {string} dir
 */
export function readRun(dir) {
  return (
    readdirSync(dir)
      .filter((name) => name.endsWith('.json') && name !== 'summary.json')
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
      .filter((result) => result && result.kind === 'frame-timing')
      // A run marked invalid (its orbit never reached the viewer) is kept on
      // disk for diagnosis but left out of every summary.
      .filter((result) => result.valid !== false)
      .sort(
        (a, b) =>
          String(a.scene).localeCompare(String(b.scene)) ||
          a.throttle - b.throttle
      )
  );
}

/** @param {number | null | undefined} value @param {number} [digits] */
function fixed(value, digits = 1) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(digits);
}

/**
 * The single-run table: one row per scene and throttle rate.
 * @param {any[]} results
 */
export function runMarkdown(results) {
  const first = results[0];
  const lines = [
    '# Viewport frame timing (proxy)',
    '',
    'Desktop Chromium with CDP CPU throttling, an iPad-sized touch viewport',
    'and device pixel ratio 2: a proxy for an iPad, not a device measurement.',
    ''
  ];
  if (first) {
    lines.push(
      `- Browser: ${first.environment.browser}`,
      `- GPU: ${first.environment.gpu}`,
      `- Viewport: ${first.environment.viewport.width}×${first.environment.viewport.height} @${first.environment.deviceScaleFactor}x, touch`,
      `- GPU timer queries: ${first.environment.timerQuery ? 'yes' : 'unavailable'}`,
      ''
    );
  }
  lines.push(
    '| Scene | CPU× | Tris | Frame p50 / p95 / p99 ms | Dropped % | Viewer CPU p50 / p95 ms | GPU p50 / p95 ms | Body install ms | Silhouette build ms (candidates) |',
    '| --- | --: | --: | --: | --: | --: | --: | --: | --: |'
  );
  for (const result of results) {
    const { orbit, load } = result;
    const silhouette = load.silhouettes.reduce(
      (/** @type {{ms:number,candidates:number}} */ sum, entry) => ({
        ms: sum.ms + entry.ms,
        candidates: sum.candidates + entry.candidates
      }),
      { ms: 0, candidates: 0 }
    );
    lines.push(
      `| ${result.scene} | ${result.throttle} | ${orbit.triangles ?? '—'} | ${fixed(orbit.frame.p50)} / ${fixed(orbit.frame.p95)} / ${fixed(orbit.frame.p99)} | ${fixed(orbit.dropped.pct)} | ${fixed(orbit.viewerCpu.p50)} / ${fixed(orbit.viewerCpu.p95)} | ${orbit.gpu ? `${fixed(orbit.gpu.p50, 2)} / ${fixed(orbit.gpu.p95, 2)}` : '—'} | ${fixed(load.bodiesMs, 0)} | ${load.silhouettes.length ? `${fixed(silhouette.ms, 0)} (${silhouette.candidates})` : '—'} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Rewrites `summary.json` and `summary.md` beside a run's result files.
 * @param {string} dir
 */
export function writeRunSummary(dir) {
  const results = readRun(dir);
  writeFileSync(
    join(dir, 'summary.json'),
    `${JSON.stringify(
      results.map(({ scene, throttle, load, orbit }) => ({
        scene,
        throttle,
        load,
        orbit: { ...orbit, samples: undefined }
      })),
      null,
      2
    )}\n`
  );
  writeFileSync(join(dir, 'summary.md'), runMarkdown(results));
  return results;
}

/**
 * The median of `values` and their spread.
 * @param {readonly (number | null | undefined)[]} values
 */
export function spread(values) {
  const present = /** @type {number[]} */ (
    values.filter(
      (value) => typeof value === 'number' && Number.isFinite(value)
    )
  ).sort((a, b) => a - b);
  if (present.length === 0) return null;
  const middle = Math.floor(present.length / 2);
  return {
    median:
      present.length % 2
        ? present[middle]
        : (present[middle - 1] + present[middle]) / 2,
    min: present[0],
    max: present.at(-1),
    runs: present.length
  };
}

/** @param {ReturnType<typeof spread>} value @param {number} [digits] */
function cell(value, digits = 1) {
  if (!value) return '—';
  return value.runs > 1 && value.max !== value.min
    ? `${value.median.toFixed(digits)} (${value.min.toFixed(digits)}–${value.max.toFixed(digits)})`
    : value.median.toFixed(digits);
}

/**
 * Before/after table over repeated runs of each build.
 * @param {{ before: any[][], after: any[][], beforeLabel?: string, afterLabel?: string }} options
 */
export function compareMarkdown({
  before,
  after,
  beforeLabel = 'before',
  afterLabel = 'after'
}) {
  /** @param {any[][]} runs */
  const index = (runs) => {
    /** @type {Map<string, any[]>} */
    const byKey = new Map();
    for (const run of runs)
      for (const result of run) {
        const key = `${result.scene}\u0000${result.throttle}`;
        byKey.set(key, [...(byKey.get(key) ?? []), result]);
      }
    return byKey;
  };
  const left = index(before);
  const right = index(after);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => {
    const [sceneA, rateA] = a.split('\u0000');
    const [sceneB, rateB] = b.split('\u0000');
    return sceneA.localeCompare(sceneB) || Number(rateA) - Number(rateB);
  });
  /** @param {any[] | undefined} results @param {(result: any) => number | null | undefined} pick */
  const over = (results, pick) => spread((results ?? []).map(pick));
  const lines = [
    `Each cell: median over runs (min–max). Frame = requestAnimationFrame interval while orbiting; dropped = refreshes with no new frame at 60 Hz.`,
    '',
    `| Scene | CPU× | Build | Frame p50 ms | p95 ms | p99 ms | Dropped % | Viewer CPU p95 ms | GPU p95 ms | Body install ms | Silhouette build ms |`,
    '| --- | --: | --- | --: | --: | --: | --: | --: | --: | --: | --: |'
  ];
  for (const key of keys) {
    const [scene, rate] = key.split('\u0000');
    for (const [label, results] of [
      [beforeLabel, left.get(key)],
      [afterLabel, right.get(key)]
    ]) {
      lines.push(
        `| ${scene} | ${rate} | ${label} | ${cell(over(results, (r) => r.orbit.frame.p50))} | ${cell(over(results, (r) => r.orbit.frame.p95))} | ${cell(over(results, (r) => r.orbit.frame.p99))} | ${cell(over(results, (r) => r.orbit.dropped.pct))} | ${cell(over(results, (r) => r.orbit.viewerCpu.p95))} | ${cell(
          over(results, (r) => r.orbit.gpu?.p95),
          2
        )} | ${cell(
          over(results, (r) => r.load.bodiesMs),
          0
        )} | ${cell(
          over(results, (r) =>
            r.load.silhouettes.length
              ? r.load.silhouettes.reduce(
                  (
                    /** @type {number} */ sum,
                    /** @type {{ms:number}} */ entry
                  ) => sum + entry.ms,
                  0
                )
              : null
          ),
          0
        )} |`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** @param {string[]} argv */
function main(argv) {
  if (argv[0] === '--compare') {
    /** @type {Record<string, string[]>} */
    const sides = {};
    let out = null;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--out') out = argv[++i];
      else {
        const [side, list] = arg.split('=');
        if (!list)
          throw new Error(
            `Expected before=<dirs> or after=<dirs>, got "${arg}".`
          );
        sides[side] = list.split(',').map((dir) => resolve(dir));
      }
    }
    if (!sides.before || !sides.after)
      throw new Error('--compare needs before=<dirs> and after=<dirs>.');
    const page = compareMarkdown({
      before: sides.before.map(readRun),
      after: sides.after.map(readRun)
    });
    if (out) writeFileSync(out, page);
    process.stdout.write(page);
    return;
  }
  if (!argv[0]) {
    throw new Error(
      'Usage: frame-timing-report.mjs <run-dir> | --compare before=<dirs> after=<dirs> [--out file]'
    );
  }
  writeRunSummary(resolve(argv[0]));
  process.stdout.write(
    readFileSync(join(resolve(argv[0]), 'summary.md'), 'utf8')
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2));
}
