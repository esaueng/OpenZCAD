#!/usr/bin/env node
// Re-runs the ROADMAP Active 1 baselines (H02 first edit after reload, W01
// 100 ms interaction target, large pattern previews) on a quiet host, and
// checks them against the budgets in scripts/active1-budgets.mjs.
// Record: docs/performance/2026-11-15-active1-baselines.md.
//
//   node scripts/measure-active1-baselines.mjs [--runs 3] [--angle vulkan]
//     [--only h02,w01-box,w01-history,pattern-node,pattern-browser]
//     [--out perf-results/active1/<stamp>] [--no-build] [--check]
//     [--wait-minutes 180]
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
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ACTIVE1_BUDGETS } from './active1-budgets.mjs';
import { hostSnapshot, noisyReasons } from './perf-host.mjs';

const PROBES = [
  'h02',
  'w01-box',
  'w01-history',
  'pattern-node',
  'pattern-browser'
];

function parseArgs(argv) {
  const options = {
    runs: 3,
    angle: 'vulkan',
    only: PROBES,
    out: null,
    build: true,
    check: false,
    waitMinutes: 180,
    summarize: null
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
    else if (flag === '--check') options.check = true;
    else if (flag === '--wait-minutes') options.waitMinutes = Number(value());
    else if (flag === '--summarize') options.summarize = value();
    else throw new Error(`Unknown option ${flag}`);
  }
  for (const probe of options.only)
    if (!PROBES.includes(probe)) throw new Error(`Unknown probe ${probe}`);
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
async function waitForQuiet(limitMinutes) {
  const deadline = Date.now() + limitMinutes * 60_000;
  for (;;) {
    const snapshot = hostSnapshot(process.pid);
    const reasons = noisyReasons(snapshot);
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
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  });
  return result.status ?? 1;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Medians across runs for each measurement, with their budgets. */
export function summarize(dir) {
  const rows = [];
  const add = (measurement, values, budget, unit = 'ms') => {
    const value = median(values);
    rows.push({
      measurement,
      runs: values.length,
      median: value,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      budget,
      unit,
      withinBudget: budget == null || value == null ? null : value <= budget
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
  for (const [probe, label] of [
    ['w01-box', 'simple box'],
    ['w01-history', '100-feature history, isolated part']
  ]) {
    const files = existsSync(dir)
      ? readdirSync(dir).filter(
          (name) => name.startsWith(`${probe}-r`) && name.endsWith('.json')
        )
      : [];
    const reports = files.map((name) =>
      JSON.parse(readFileSync(join(dir, name), 'utf8'))
    );
    const budget = ACTIVE1_BUDGETS.interaction[probe];
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
    (probe) => probe !== 'pattern-node'
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
  if (browserProbes.length) {
    if (options.build) {
      await waitForQuiet(options.waitMinutes);
      const status = run('pnpm', ['--filter', '@openzcad/web', 'build'], {
        VITE_E2E: '1',
        VITE_E2E_FULL_RENDER: '1'
      });
      if (status !== 0) throw new Error('Production-renderer build failed.');
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
  const playwright = (spec, env) =>
    run(
      'pnpm',
      ['exec', 'playwright', 'test', spec, '--workers=1', '--reporter=line'],
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
