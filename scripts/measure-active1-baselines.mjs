#!/usr/bin/env node
// Re-runs the ROADMAP Active 1 baselines (H02 first edit after reload, W01
// 100 ms interaction target, large pattern previews) on a quiet host, and
// checks them against the budgets in scripts/active1-budgets.mjs.
// Record: docs/performance/2026-11-15-active1-baselines.md.
//
//   node scripts/measure-active1-baselines.mjs [--runs 3] [--angle vulkan]
//     [--only h02,w01-box,w01-history,f06-switch-box,f06-switch-history,
//             pattern-node,pattern-browser,face-drag,orbit,sustained]
//     [--out perf-results/active1/<stamp>] [--no-build] [--check]
//     [--assume-build plain|instrumented]
//     [--wait-minutes 180] [--heavy-lock ~/.cache/openzcad-heavy.lock]
//
// Before every run it waits until the host is quiet (1-minute load average
// below 2.0, at least 3 GiB available, no cargo, rustc or Playwright process
// outside this run) and records the host snapshot beside the result. The
// browser probes share one production-renderer preview build; `--angle`
// picks Chromium's ANGLE backend (`vulkan`, `gl`; `swiftshader` keeps the
// software default). `--check` exits non-zero when a measured median
// exceeds its budget; `--summarize <dir>` only re-reads a finished run.
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ACTIVE1_BUDGETS } from './active1-budgets.mjs';
import { hostSnapshot, noisyReasons } from './perf-host.mjs';

const PROBES = [
  'h02',
  'w01-box',
  'w01-history',
  // F06: Switch → frame for a configuration row, judged by the W01 budgets.
  'f06-switch-box',
  'f06-switch-history',
  'pattern-node',
  'pattern-browser',
  // H02 face-drag targets: pointer → presented frame on public native parts.
  'face-drag',
  // H02 orbit tails: frame intervals of a one-finger orbit, unthrottled and
  // at 4× CPU slow-down.
  'orbit',
  // H02 whole-worker retention: 300 edits through the worker's exact
  // adapter with idle compaction (`test/sustained-session-retention.test.ts`).
  'sustained'
];

/** Which flavour the last build this script made was (`--no-build` checks it). */
const BUILD_STAMP = resolve('perf-results/active1/.last-build.json');
const DIST_INDEX = resolve('apps/web/dist/index.html');
const distMtimeMs = () =>
  existsSync(DIST_INDEX) ? statSync(DIST_INDEX).mtimeMs : null;

/** Probes that need the `OZ_PERF=1` instrumented build. */
const INSTRUMENTED_PROBES = ['face-drag', 'orbit'];

/** The public `perf-face-drag-trace` cases the `face-drag` probe runs. */
export const FACE_DRAG_CASES =
  'filleted union width|long native history face drag|rounded box top-face drag|native hammer-holder arm drag';

function parseArgs(argv) {
  const options = {
    runs: 3,
    angle: 'vulkan',
    only: PROBES.filter((probe) => !INSTRUMENTED_PROBES.includes(probe)),
    out: null,
    build: true,
    assumeBuild: null,
    check: false,
    waitMinutes: 180,
    summarize: null,
    heavyLock: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === '--runs') options.runs = Number(value());
    else if (flag === '--angle') options.angle = value();
    else if (flag === '--only') options.only = value().split(',');
    else if (flag === '--out') options.out = value();
    else if (flag === '--no-build') options.build = false;
    else if (flag === '--assume-build') {
      const flavour = value();
      if (flavour !== 'plain' && flavour !== 'instrumented')
        throw new Error('--assume-build takes plain or instrumented');
      options.assumeBuild = flavour;
    } else if (flag === '--check') options.check = true;
    else if (flag === '--heavy-lock') options.heavyLock = value();
    else if (flag === '--wait-minutes') options.waitMinutes = Number(value());
    else if (flag === '--summarize') options.summarize = value();
    else throw new Error(`Unknown option ${flag}`);
  }
  for (const probe of options.only)
    if (!PROBES.includes(probe)) throw new Error(`Unknown probe ${probe}`);
  // The drag and orbit probes read frame marks only an `OZ_PERF` build
  // compiles in; the other browser probes' baselines were taken without it.
  const instrumented = options.only.filter((probe) =>
    INSTRUMENTED_PROBES.includes(probe)
  );
  const plain = options.only.filter(
    (probe) =>
      !INSTRUMENTED_PROBES.includes(probe) &&
      probe !== 'pattern-node' &&
      probe !== 'sustained'
  );
  if (instrumented.length && plain.length)
    throw new Error(
      `Run ${instrumented.join(', ')} separately from ${plain.join(', ')}: they need an OZ_PERF build.`
    );
  if (!(options.runs >= 1)) throw new Error('--runs must be at least 1');
  return options;
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
/**
 * `--heavy-lock <path>`: on a machine whose agent lanes serialize heavy jobs
 * with one `flock`, every build and probe takes that lock (non-blocking) only
 * while it runs, and the script never holds it while waiting for a quiet
 * host. Other lanes' heavy work can then not overlap a probe, so busy
 * processes stop counting against quiet; load and memory still do.
 */
let heavyLock = null;
const LOCK_BUSY = 75;

async function waitForQuiet(limitMinutes) {
  const deadline = Date.now() + limitMinutes * 60_000;
  for (;;) {
    const snapshot = hostSnapshot(process.pid);
    const reasons = noisyReasons(snapshot).filter(
      (reason) => !heavyLock || !reason.endsWith('busy processes')
    );
    if (!reasons.length) return snapshot;
    if (Date.now() > deadline)
      throw new Error(`Host never became quiet: ${reasons.join(', ')}`);
    console.log(`[active1] waiting for a quiet host: ${reasons.join(', ')}`);
    await sleep(30_000);
  }
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function run(command, args, env) {
  const once = () =>
    spawnSync(
      heavyLock ? 'flock' : command,
      heavyLock
        ? ['-n', '-E', String(LOCK_BUSY), heavyLock, command, ...args]
        : args,
      { stdio: 'inherit', env: { ...process.env, ...env } }
    ).status ?? 1;
  for (let attempt = 0; ; attempt += 1) {
    const status = once();
    if (!heavyLock || status !== LOCK_BUSY) return status;
    // Another lane's heavy job holds the lock: wait without holding it.
    if (attempt === 0) console.log(`[active1] waiting for ${heavyLock}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  }
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Nearest-rank percentile of a list of numbers. */
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[
        Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
      ]
    : null;
};

/**
 * Frame cadence while the pointer moves: the intervals between every frame
 * the drag trace recorded (each a WebGL render inside the viewer's animation
 * callback) from the first pointer event to the last. The viewer's
 * `continuous` frame marks cover only part of a drag and can include
 * intervals that end before or straddle the first move, so they misstate the
 * rate during motion. Latency at the start and end of a drag is measured by
 * the lag and release rows, not here.
 */
export function dragFrameCadence(sample) {
  const trace = Array.isArray(sample.trace) ? sample.trace : null;
  if (!trace) return null;
  const kind = (event) => event.stage ?? event.kind;
  const pointer = trace.filter((event) => kind(event) === 'pointer');
  if (pointer.length < 2) return null;
  const start = pointer[0].t;
  const end = pointer.at(-1).t;
  const frames = trace
    .filter(
      (event) => kind(event) === 'frame' && event.t >= start && event.t <= end
    )
    .map((event) => event.t);
  const intervals = frames.slice(1).map((t, index) => t - frames[index]);
  if (!intervals.length) return null;
  return {
    frames: frames.length,
    p50: percentile(intervals, 0.5),
    p95: percentile(intervals, 0.95),
    max: Math.max(...intervals)
  };
}

/** Medians across runs for each measurement, with their budgets. */
export function summarize(dir) {
  const rows = [];
  const add = (measurement, values, budget, unit = 'ms', atLeast = false) => {
    const present = values.filter(Number.isFinite);
    const value = median(present);
    // A run that recorded nothing for a budgeted row fails it rather than
    // dropping out of the median.
    const missing = present.length < values.length;
    rows.push({
      measurement,
      runs: values.length,
      median: value,
      min: present.length ? Math.min(...present) : null,
      max: present.length ? Math.max(...present) : null,
      budget,
      unit,
      // A probe this run did not select has no samples: not measured.
      withinBudget:
        budget == null || values.length === 0
          ? null
          : missing || value == null
            ? false
            : atLeast
              ? value >= budget
              : value <= budget
    });
  };
  const holder = readJsonl(join(dir, 'h02.jsonl'));
  for (const fixture of new Set(holder.map((sample) => sample.scenario))) {
    const samples = holder.filter((sample) => sample.scenario === fixture);
    const edit = (sample, label) =>
      sample.edits.find((entry) => entry.label === label)?.exactMs;
    const budget =
      ACTIVE1_BUDGETS.firstEditAfterReload.find((entry) =>
        fixture.includes(entry.match)
      ) ?? {};
    add(
      `H02 reload → exact ready (${fixture})`,
      samples.map((sample) => sample.reload.navigationToReadyMs),
      budget.reloadToReadyMs
    );
    add(
      `H02 first edit after settled reload (${fixture})`,
      samples.map((sample) => edit(sample, 'first edit after reload')),
      budget.settledFirstEditMs
    );
    add(
      `H02 edit typed during reload (${fixture})`,
      samples.map((sample) => edit(sample, 'immediate edit after reload')),
      budget.immediateEditMs
    );
  }
  for (const [probe, label, budgetProbe] of [
    ['w01-box', 'simple box', 'w01-box'],
    ['w01-history', '100-feature history, isolated part', 'w01-history'],
    // F06 row switches answer to the same W01 budgets as an edit.
    ['f06-switch-box', 'F06 row switch, simple box', 'w01-box'],
    [
      'f06-switch-history',
      'F06 row switch, 100-feature history, isolated part',
      'w01-history'
    ]
  ]) {
    const files = existsSync(dir)
      ? readdirSync(dir).filter(
          (name) => name.startsWith(`${probe}-r`) && name.endsWith('.json')
        )
      : [];
    const reports = files.map((name) =>
      JSON.parse(readFileSync(join(dir, name), 'utf8'))
    );
    const budget = ACTIVE1_BUDGETS.interaction[budgetProbe];
    add(
      `W01 input → frame median (${label})`,
      reports.map((report) => report.summaries.inputToFrameMs.medianMs),
      budget.medianMs
    );
    add(
      `W01 input → frame p95 (${label})`,
      reports.map((report) => report.summaries.inputToFrameMs.p95Ms),
      budget.p95Ms
    );
  }
  const node = readJsonl(join(dir, 'pattern-node.jsonl'));
  for (const grid of new Set(node.map((sample) => sample.grid))) {
    add(
      `Pattern preview, Node adapter (${grid})`,
      node
        .filter((sample) => sample.grid === grid)
        .map((sample) => sample.previewMs),
      grid === '10x10' ? ACTIVE1_BUDGETS.patternPreview10x10.nodeMedianMs : null
    );
  }
  const drags = readJsonl(join(dir, 'face-drag.jsonl'));
  for (const label of new Set(drags.map((sample) => sample.label))) {
    const samples = drags.filter((sample) => sample.label === label);
    const budget = ACTIVE1_BUDGETS.faceDrag[label] ?? {};
    // What followed the pointer in each run: its disposable proxy frames
    // when it presented them (the exact preview is then built once the hand
    // rests), otherwise its streamed exact frames. The two kinds get rows of
    // their own, each over its own runs, so a fast proxy run never shares a
    // median with a slow exact-only one.
    const proxied = (sample) => sample.summary.proxyPresentedFrames > 0;
    for (const [kind, runs, read] of [
      [
        'proxy',
        samples.filter(proxied),
        (sample) => sample.summary.pointerToProxyFrameMs
      ],
      [
        'exact',
        samples.filter((sample) => !proxied(sample)),
        (sample) => sample.summary.steadyPointerToPresentedMs
      ]
    ]) {
      if (!runs.length) continue;
      add(
        `Face drag pointer → ${kind} frame p50 (${label})`,
        runs.map((sample) => read(sample)?.p50 ?? null),
        budget.lagP50Ms
      );
      add(
        `Face drag pointer → ${kind} frame p95 (${label})`,
        runs.map((sample) => read(sample)?.p95 ?? null),
        budget.lagP95Ms
      );
    }
    // First exact geometry on screen, from the first pointer move, for
    // every run that built any (a proxy-led drag builds it only once the
    // hand rests, so this is far above H02's 100 ms target).
    const exactRuns = samples.filter(
      (sample) => sample.summary.presentedFrames > 0
    );
    if (exactRuns.length)
      add(
        `Face drag first exact geometry (${label})`,
        exactRuns.map((sample) => sample.summary.firstGeometryMs),
        budget.firstGeometryMs
      );
    // Only runs that asked for an exact preview before release have one.
    const previewed = samples.filter((sample) => sample.summary.requests > 0);
    if (previewed.length)
      add(
        `Face drag exact preview round trip p50 (${label})`,
        previewed.map((sample) => sample.summary.stages?.roundTripMs?.p50),
        budget.exactPreviewMs
      );
    const cadence = samples.map(dragFrameCadence);
    add(
      `Face drag frame interval p50 while moving (${label})`,
      cadence.map((value) => value?.p50 ?? null),
      budget.frameIntervalP50Ms
    );
    add(
      `Face drag frame interval p95 while moving (${label})`,
      cadence.map((value) => value?.p95 ?? null),
      budget.frameIntervalP95Ms
    );
    add(
      `Face drag release → accepted frame (${label})`,
      samples.map((sample) => sample.summary.releaseToFrameMs),
      budget.releaseToFrameMs
    );
  }
  const orbitRuns = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.startsWith('orbit-r'))
    : [];
  const orbits = orbitRuns.flatMap((run) =>
    existsSync(join(dir, run, 'summary.json'))
      ? JSON.parse(readFileSync(join(dir, run, 'summary.json'), 'utf8'))
      : []
  );
  for (const key of new Set(
    orbits.map((result) => `${result.scene} x${result.throttle}`)
  )) {
    const results = orbits.filter(
      (result) => `${result.scene} x${result.throttle}` === key
    );
    const budget =
      ACTIVE1_BUDGETS.orbit[key] ??
      ACTIVE1_BUDGETS.orbit[`* x${results[0].throttle}`] ??
      {};
    // The viewer's own frames (`oz:viewer.frame`), not the page's
    // requestAnimationFrame callbacks, which keep their cadence while the
    // viewer skips frames.
    add(
      `Orbit viewer frame interval p95 (${key})`,
      results.map((result) => result.orbit.viewerInterval?.p95 ?? null),
      budget.p95Ms
    );
    add(
      `Orbit viewer frame interval p99 (${key})`,
      results.map((result) => result.orbit.viewerInterval?.p99 ?? null),
      budget.p99Ms
    );
    add(
      `Orbit viewer frames per second (${key})`,
      results.map((result) => result.orbit.viewerFps ?? null),
      budget.minViewerFps,
      'fps',
      true
    );
  }
  const sustainedRuns = existsSync(dir)
    ? readdirSync(dir).filter(
        (name) => name.startsWith('sustained-r') && name.endsWith('.jsonl')
      )
    : [];
  if (sustainedRuns.length) {
    const files = sustainedRuns.map((name) => readJsonl(join(dir, name)));
    const runs = files.map((lines) => lines.filter((row) => 'edit' in row));
    // Peaks over every sync, from each run's summary line; the rows are
    // only sampled every tenth edit and after compactions.
    const peaks = files.map((lines) => lines.find((row) => 'syncs' in row));
    const third = (rows, part) =>
      rows.slice(
        Math.floor((rows.length * part) / 3),
        Math.floor((rows.length * (part + 1)) / 3)
      );
    const oneFeature = (rows) =>
      median(
        rows
          .filter((row) => row.replayed === 1 && row.compactMs == null)
          .map((row) => row.ms)
      );
    const budget = ACTIVE1_BUDGETS.sustained;
    add(
      'Sustained session: peak WASM linear memory',
      peaks.map((peak) =>
        Number.isFinite(peak?.peakLinearMemoryBytes)
          ? peak.peakLinearMemoryBytes / 2 ** 20
          : null
      ),
      budget.peakLinearMemoryMiB,
      'MiB'
    );
    add(
      'Sustained session: peak retired arena slots',
      peaks.map((peak) => peak?.peakRetiredSlots ?? null),
      budget.peakRetiredSlots,
      'slots'
    );
    add(
      'Sustained session: post-GC heap growth, first → last third',
      runs.map(
        (rows) =>
          (median(third(rows, 2).map((row) => row.heapUsed)) -
            median(third(rows, 0).map((row) => row.heapUsed))) /
          2 ** 20
      ),
      budget.heapGrowthMiB,
      'MiB'
    );
    add(
      'Sustained session: one-feature edit drift, last ÷ first third',
      runs.map(
        (rows) => oneFeature(third(rows, 2)) / oneFeature(third(rows, 0))
      ),
      budget.editDriftRatio,
      '×'
    );
  }
  const browser = readJsonl(join(dir, 'pattern-browser.jsonl'));
  for (const grid of new Set(
    browser.flatMap((sample) => sample.steps.map((step) => step.grid))
  )) {
    add(
      `Pattern preview, browser (${grid})`,
      browser.flatMap((sample) =>
        sample.steps
          .filter((step) => step.grid === grid)
          .map((step) => step.previewMs)
      ),
      grid === '10x10'
        ? ACTIVE1_BUDGETS.patternPreview10x10.browserMedianMs
        : null
    );
  }
  return rows;
}

function markdown(rows) {
  const format = (value) =>
    value == null ? '—' : Math.round(value).toLocaleString('en-US');
  return [
    '| Measurement | Runs | Median | Range | Budget | Within |',
    '| --- | ---: | ---: | ---: | ---: | :---: |',
    ...rows.map(
      (row) =>
        `| ${row.measurement} | ${row.runs} | ${format(row.median)} | ` +
        `${format(row.min)}–${format(row.max)} | ${format(row.budget)} | ` +
        `${row.withinBudget == null ? '—' : row.withinBudget ? 'yes' : '**no**'} |`
    )
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  heavyLock = options.heavyLock;
  if (options.summarize) {
    const rows = summarize(resolve(options.summarize));
    console.log(markdown(rows));
    process.exitCode =
      options.check && rows.some((row) => row.withinBudget === false) ? 1 : 0;
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = resolve(options.out ?? `perf-results/active1/${stamp}`);
  mkdirSync(dir, { recursive: true });
  const runsLog = join(dir, 'runs.jsonl');
  const angle = options.angle === 'swiftshader' ? '' : options.angle;
  const browserProbes = options.only.filter(
    (probe) => probe !== 'pattern-node' && probe !== 'sustained'
  );
  let server;
  let port;
  const cleanup = () => server?.kill('SIGTERM');
  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  const instrumented = options.only.some((probe) =>
    INSTRUMENTED_PROBES.includes(probe)
  );
  if (browserProbes.length) {
    if (options.build) {
      await waitForQuiet(options.waitMinutes);
      const status = run('pnpm', ['--filter', '@openzcad/web', 'build'], {
        VITE_E2E: '1',
        VITE_E2E_FULL_RENDER: '1',
        ...(instrumented ? { OZ_PERF: '1' } : {})
      });
      if (status !== 0) throw new Error('Production-renderer build failed.');
      mkdirSync(dirname(BUILD_STAMP), { recursive: true });
      writeFileSync(
        BUILD_STAMP,
        `${JSON.stringify({ instrumented, distMtimeMs: distMtimeMs() })}\n`
      );
    } else {
      // `--no-build` serves whatever is in the web output now. Accept it
      // only as this script's last build of the right flavour (the stamp
      // names it, and the output is unchanged since), or as the flavour the
      // caller vouches for with --assume-build after building it by hand.
      const stamp = existsSync(BUILD_STAMP)
        ? JSON.parse(readFileSync(BUILD_STAMP, 'utf8'))
        : null;
      const flavour =
        options.assumeBuild !== null
          ? options.assumeBuild === 'instrumented'
          : stamp && stamp.distMtimeMs === distMtimeMs()
            ? stamp.instrumented
            : null;
      if (flavour !== instrumented)
        throw new Error(
          `--no-build: the web output is ${flavour === null ? 'not a build this script recorded' : flavour ? 'instrumented (OZ_PERF)' : 'uninstrumented'}; these probes need ${instrumented ? 'an instrumented' : 'an uninstrumented'} one. Build again, or pass --assume-build ${instrumented ? 'instrumented' : 'plain'} for a build you made yourself.`
        );
    }
    port = await freePort();
    server = spawn(
      'pnpm',
      [
        '--filter',
        '@openzcad/web',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort'
      ],
      { stdio: 'ignore', detached: false }
    );
    for (let attempt = 0; ; attempt += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (attempt > 120) throw new Error('Preview server did not start.');
      await sleep(500);
    }
  }
  const probeEnv = {
    OZ_PERF: '1',
    OZ_PERF_ANGLE: angle,
    OZ_PERF_OWN_ROOT: String(process.pid),
    ...(port ? { PLAYWRIGHT_PORT: String(port) } : {})
  };
  const playwright = (spec, env, extra = []) =>
    run(
      'pnpm',
      [
        'exec',
        'playwright',
        'test',
        spec,
        '--workers=1',
        '--reporter=line',
        ...extra
      ],
      {
        ...probeEnv,
        ...env
      }
    );
  const commands = {
    // --check also asserts the probe's within-run H02 ratios.
    h02: () =>
      playwright('perf-holder-reload', {
        OZ_PERF_OUT: join(dir, 'h02.jsonl'),
        ...(options.check ? { OZ_PERF_BUDGET: '1' } : {})
      }),
    'w01-box': (round) =>
      playwright('perf-cad-edit', {
        CAD_PERF_BROWSER_SAMPLES: '30',
        CAD_PERF_BROWSER_OUT: join(dir, `w01-box-r${round}.json`)
      }),
    'w01-history': (round) =>
      playwright('perf-cad-edit', {
        CAD_PERF_BROWSER_SAMPLES: '30',
        CAD_PERF_BROWSER_HISTORY: '100',
        CAD_PERF_BROWSER_ISOLATE: '1',
        CAD_PERF_BROWSER_OUT: join(dir, `w01-history-r${round}.json`)
      }),
    'f06-switch-box': (round) =>
      playwright('perf-configuration-switch', {
        CONFIG_SWITCH_SAMPLES: '30',
        CONFIG_SWITCH_OUT: join(dir, `f06-switch-box-r${round}.json`)
      }),
    'f06-switch-history': (round) =>
      playwright('perf-configuration-switch', {
        CONFIG_SWITCH_SAMPLES: '30',
        CONFIG_SWITCH_HISTORY: '100',
        CONFIG_SWITCH_OUT: join(dir, `f06-switch-history-r${round}.json`)
      }),
    'pattern-node': () =>
      run(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          '--config',
          'test/perf/pattern-preview.config.ts'
        ],
        {
          PATTERN_PERF_RUN: '1',
          PATTERN_PERF_SAMPLES: '1',
          ...(options.check ? { PATTERN_PERF_BUDGET: '1' } : {}),
          PATTERN_PERF_OUT: join(dir, 'pattern-node.jsonl')
        }
      ),
    'pattern-browser': () =>
      playwright('perf-pattern-preview', {
        OZ_PERF_OUT: join(dir, 'pattern-browser.jsonl')
      }),
    'face-drag': () =>
      playwright(
        'perf-face-drag-trace',
        {
          OZ_PERF_OUT: join(dir, 'face-drag.jsonl'),
          ...(angle ? { OZ_FACE_DRAG_ANGLE: angle } : {})
        },
        ['-g', FACE_DRAG_CASES]
      ),
    sustained: (round) =>
      run(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          'test/sustained-session-retention.test.ts',
          '-t',
          'long session'
        ],
        {
          SUSTAINED_EDITS: '300',
          SUSTAINED_OUT: join(dir, `sustained-r${round}.jsonl`)
        }
      ),
    orbit: (round) =>
      playwright('perf-frame-timing', {
        OZ_PERF_DIR: join(dir, `orbit-r${round}`),
        OZ_PERF_THROTTLE: '1,4',
        ...(angle ? {} : { OZ_PERF_SOFTWARE_GL: '1' })
      })
  };
  let failures = 0;
  for (let round = 0; round < options.runs; round += 1) {
    for (const probe of options.only) {
      const before = await waitForQuiet(options.waitMinutes);
      const started = Date.now();
      const status = commands[probe](round);
      const after = hostSnapshot(process.pid);
      if (status !== 0) failures += 1;
      appendFileSync(
        runsLog,
        `${JSON.stringify({ probe, round, status, wallMs: Date.now() - started, angle: options.angle, host: { before, after } })}\n`
      );
      console.log(`[active1] ${probe} round ${round}: exit ${status}`);
    }
  }
  cleanup();
  const rows = summarize(dir);
  writeFileSync(
    join(dir, 'summary.json'),
    `${JSON.stringify(rows, null, 2)}\n`
  );
  writeFileSync(join(dir, 'summary.md'), `${markdown(rows)}\n`);
  console.log(markdown(rows));
  console.log(`[active1] results in ${dir}`);
  const overBudget = rows.some((row) => row.withinBudget === false);
  process.exitCode = failures || (options.check && overBudget) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
