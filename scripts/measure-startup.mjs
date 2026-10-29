#!/usr/bin/env node

/**
 * Startup probe for a production build: when the opened project's model is
 * visible and the workspace is ready for input, what blocks the main thread
 * on the way, and what the network carries. See
 * docs/performance-baseline.md, "Readiness marks".
 *
 *   pnpm build
 *   node scripts/measure-startup.mjs --runs 5 --headed
 *   node scripts/measure-startup.mjs --mode cold --runs 5 --network slow4g
 *
 * `warm` (the default) opens a demo once, then reloads it `--runs` times with
 * the HTTP cache and the stored project in place: the shape of a returning
 * user's reload. `cold` opens the demo from the library in a fresh profile
 * each run, cache enabled, so a duplicate request is a real one and not an
 * artifact of DevTools' "Disable cache". `--trace <dir>` also records a
 * Chrome trace per run, without the sampling profiler, and attributes each
 * long main-thread task to the trace events inside it.
 *
 * Measurement, not a gate: timings depend on the machine and above all on
 * the GPU path. Headless Chromium renders WebGL with SwiftShader on the CPU;
 * pass `--headed` (and `--channel chrome`) for the real GPU. The report
 * names the WebGL renderer it measured.
 */

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const NETWORK_PROFILES = {
  none: null,
  // DevTools' presets.
  fast4g: {
    latency: 150,
    downloadThroughput: 1_012_500,
    uploadThroughput: 84_375
  },
  slow4g: {
    latency: 562.5,
    downloadThroughput: 180_000,
    uploadThroughput: 84_375
  }
};

const TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'toplevel',
  'v8',
  'v8.execute',
  'v8.wasm',
  'disabled-by-default-v8.compile',
  'blink',
  'blink.user_timing',
  'loading',
  'gpu'
].join(',');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream'
};
const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.wasm',
  '.svg'
]);

export function parseArgs(argv) {
  const args = {
    dist: path.join(repoRoot, 'apps/web/dist'),
    runs: 5,
    mode: 'warm',
    demo: 'Heat Sink',
    headed: false,
    channel: null,
    cpu: 1,
    network: 'none',
    settleMs: 3_000,
    trace: null,
    out: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === '--dist') args.dist = path.resolve(value());
    else if (flag === '--runs') args.runs = Number(value());
    else if (flag === '--mode') args.mode = value();
    else if (flag === '--demo') args.demo = value();
    else if (flag === '--headed') args.headed = true;
    else if (flag === '--channel') args.channel = value();
    else if (flag === '--cpu') args.cpu = Number(value());
    else if (flag === '--network') args.network = value();
    else if (flag === '--settle') args.settleMs = Number(value());
    else if (flag === '--trace') args.trace = path.resolve(value());
    else if (flag === '--out') args.out = path.resolve(value());
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1)
    throw new Error('--runs must be a positive integer.');
  if (!['warm', 'cold'].includes(args.mode))
    throw new Error('--mode is warm or cold.');
  if (!(args.network in NETWORK_PROFILES))
    throw new Error(
      `--network is one of ${Object.keys(NETWORK_PROFILES).join(', ')}.`
    );
  if (!(args.cpu >= 1))
    throw new Error('--cpu is a slowdown factor of at least 1.');
  return args;
}

/** Serves a build like production: immutable assets, compressed text, SPA fallback, no API. */
function serve(dist) {
  const compressed = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (url.pathname.startsWith('/api/')) {
      // Signed out and offline, as a local-only visitor.
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{"error":"offline"}');
      return;
    }
    let file = path.join(dist, decodeURIComponent(url.pathname));
    if (!file.startsWith(dist)) {
      response.writeHead(403).end();
      return;
    }
    let body;
    try {
      body = readFileSync(file);
    } catch {
      file = path.join(dist, 'index.html');
      body = readFileSync(file);
    }
    const extension = path.extname(file);
    const headers = {
      'Content-Type': MIME[extension] ?? 'application/octet-stream',
      'Cache-Control': url.pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'max-age=0, must-revalidate'
    };
    if (
      COMPRESSIBLE.has(extension) &&
      /\bgzip\b/.test(String(request.headers['accept-encoding']))
    ) {
      if (!compressed.has(file)) compressed.set(file, gzipSync(body));
      body = compressed.get(file);
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    response.writeHead(200, headers);
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Installed before any page script: long tasks and LCP, buffered from navigation. */
function installObservers() {
  const probe = { longTasks: [], lcp: null };
  window.__ozStartupProbe = probe;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        probe.longTasks.push({
          start: entry.startTime,
          duration: entry.duration
        });
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const element = entry.element;
        probe.lcp = {
          start: entry.startTime,
          element: element
            ? `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().split(/\s+/).join('.')}` : ''}`
            : null
        };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    // Reported as missing.
  }
  try {
    const key = 'openzcad-panel-state:v1';
    const state = JSON.parse(localStorage.getItem(key) ?? '{}');
    state.workspaceTourDismissed = true;
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // The tour would only cover the stage.
  }
}

/** Page-side: waits for input readiness, by mark when the build has it. */
async function waitForReady(page, timeout = 120_000) {
  const marked = () =>
    performance.getEntriesByName('oz:input-ready', 'mark').length > 0;
  // A build from before the readiness marks has only the e2e suite's
  // readiness signal, a modeling tool enabled, observed by polling.
  await page.waitForFunction(
    () =>
      performance.getEntriesByName('oz:input-ready', 'mark').length > 0 ||
      [...document.querySelectorAll('button')].some(
        (button) =>
          /^Fillet/.test(
            button.getAttribute('aria-label') ?? button.textContent ?? ''
          ) && !button.disabled
      ),
    undefined,
    { timeout, polling: 50 }
  );
  const hasMark = await page
    .waitForFunction(marked, undefined, { timeout: 2_000, polling: 50 })
    .then(() => true)
    .catch(() => false);
  return hasMark ? 'mark' : 'polled';
}

async function collect(page) {
  return page.evaluate(() => {
    const at = (name) => {
      const entry = performance.getEntriesByName(name)[0];
      return entry
        ? Math.round(
            entry.startTime +
              (entry.entryType === 'measure' ? entry.duration : 0)
          )
        : null;
    };
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const probe = window.__ozStartupProbe ?? { longTasks: [], lcp: null };
    return {
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
      milestones: {
        bundleEvaluated: at('oz:bundle.evaluated'),
        appMounted: at('oz:app.mounted'),
        startupReady: at('oz:startup.ready'),
        viewerFirstFrame: at('oz:viewer.firstFrame.ready'),
        workerReady: at('oz:worker.ready'),
        modelVisible: at('oz:model-visible'),
        inputReady: at('oz:input-ready')
      },
      // Startup phases the app times itself (lib/perf.ts), 5 ms and up.
      phases: performance
        .getEntriesByType('measure')
        .filter(
          (entry) =>
            entry.name.startsWith('oz:') &&
            !entry.name.startsWith('oz:edit.') &&
            entry.duration >= 5
        )
        .map((entry) => ({
          name: entry.name,
          start: Math.round(entry.startTime),
          ms: Math.round(entry.duration)
        })),
      readyObservedAt: Math.round(performance.now()),
      longTasks: probe.longTasks.map((task) => ({
        start: Math.round(task.start),
        duration: Math.round(task.duration)
      })),
      lcp: probe.lcp
        ? { start: Math.round(probe.lcp.start), element: probe.lcp.element }
        : null
    };
  });
}

function trackNetwork(cdp) {
  const requests = new Map();
  let lastActivity = Date.now();
  /** Requests started and not yet finished or failed. */
  const inFlight = new Set();
  const handlers = {
    'Network.requestWillBeSent': (event) => {
      lastActivity = Date.now();
      inFlight.add(event.requestId);
      requests.set(event.requestId, {
        url: event.request.url,
        type: event.type,
        priority: event.request.initialPriority,
        bytes: 0,
        fromCache: false
      });
    },
    'Network.requestServedFromCache': (event) => {
      const request = requests.get(event.requestId);
      if (request) request.fromCache = true;
    },
    'Network.responseReceived': (event) => {
      const request = requests.get(event.requestId);
      if (
        request &&
        (event.response.fromDiskCache || event.response.fromPrefetchCache)
      )
        request.fromCache = true;
    },
    'Network.loadingFinished': (event) => {
      lastActivity = Date.now();
      inFlight.delete(event.requestId);
      const request = requests.get(event.requestId);
      if (request) request.bytes = event.encodedDataLength;
    },
    'Network.loadingFailed': (event) => {
      lastActivity = Date.now();
      inFlight.delete(event.requestId);
    }
  };
  for (const [name, handler] of Object.entries(handlers)) cdp.on(name, handler);
  return {
    /**
     * Resolves once nothing is in flight and no request has started or
     * finished for `quietMs`: a slow request still loading is not quiet.
     */
    async settled(quietMs, limitMs) {
      const deadline = Date.now() + limitMs;
      while (
        (inFlight.size > 0 || Date.now() - lastActivity < quietMs) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 250));
    },
    summary() {
      for (const [name, handler] of Object.entries(handlers))
        cdp.off(name, handler);
      const all = [...requests.values()].filter((request) =>
        request.url.startsWith('http')
      );
      const seen = new Set(all.map((request) => request.url));
      const duplicates = all.filter(
        (request, index) =>
          all.findIndex((other) => other.url === request.url) !== index
      );
      // The lazy-chunk prefetch is the only fetch() of a hashed asset.
      const prefetches = all.filter(
        (request) =>
          request.type === 'Fetch' && request.url.includes('/assets/')
      );
      const sum = (list) =>
        list.reduce((total, request) => total + request.bytes, 0);
      return {
        requests: all.length,
        uniqueUrls: seen.size,
        transferredBytes: sum(all),
        fromCache: all.filter((request) => request.fromCache).length,
        duplicateRequests: duplicates.length,
        duplicateBytes: sum(duplicates),
        duplicatesFromNetwork: duplicates.filter(
          (request) => !request.fromCache
        ).length,
        prefetchRequests: prefetches.length,
        prefetchBytes: sum(prefetches)
      };
    }
  };
}

async function readTrace(cdp) {
  const done = new Promise((resolve) =>
    cdp.once('Tracing.tracingComplete', resolve)
  );
  await cdp.send('Tracing.end');
  const { stream } = await done;
  let text = '';
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream });
    text += chunk.base64Encoded
      ? Buffer.from(chunk.data, 'base64').toString('utf8')
      : chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed.traceEvents;
}

function describe(event) {
  const data = event.args?.data ?? event.args?.beginData ?? {};
  const where = data.url ? data.url.replace(/^https?:\/\/[^/]+/, '') : '';
  const fn = data.functionName ? ` ${data.functionName}` : '';
  const line = data.lineNumber !== undefined ? `:${data.lineNumber}` : '';
  return `${event.name}${where || fn ? ` (${where}${line}${fn})` : ''}`;
}

/**
 * Each main-thread task of 50 ms or more, with the slowest events inside it
 * and the time per event name (inclusive; nested events overlap).
 */
export function attributeLongTasks(events, minimumMs = 50) {
  const names = new Map();
  for (const event of events)
    if (event.ph === 'M' && event.name === 'thread_name')
      names.set(`${event.pid}:${event.tid}`, event.args?.name);
  const main = new Map();
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`;
    if (names.get(key) !== 'CrRendererMain' || event.ph !== 'X') continue;
    if (!main.has(key)) main.set(key, []);
    main.get(key).push(event);
  }
  // The page's renderer is the main thread with the most work.
  const [thread] = [...main.values()].sort(
    (a, b) =>
      b.reduce((t, e) => t + (e.dur ?? 0), 0) -
      a.reduce((t, e) => t + (e.dur ?? 0), 0)
  );
  if (!thread) return { navigationStart: null, tasks: [] };
  thread.sort((a, b) => a.ts - b.ts);
  const navigation = events.find(
    (event) =>
      event.name === 'navigationStart' && event.args?.data?.isLoadingMainFrame
  );
  const origin = navigation?.ts ?? thread[0].ts;
  const tasks = [];
  for (const task of thread) {
    if (task.name !== 'RunTask' || (task.dur ?? 0) < minimumMs * 1000) continue;
    const end = task.ts + task.dur;
    const inside = thread.filter(
      (event) =>
        event !== task &&
        event.ts >= task.ts &&
        event.ts + (event.dur ?? 0) <= end
    );
    const byName = new Map();
    for (const event of inside)
      byName.set(event.name, (byName.get(event.name) ?? 0) + (event.dur ?? 0));
    tasks.push({
      start: Math.round((task.ts - origin) / 1000),
      duration: Math.round(task.dur / 1000),
      slowest: inside
        .filter((event) => (event.dur ?? 0) >= 5_000)
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 12)
        .map((event) => ({
          ms: Math.round(event.dur / 1000),
          event: describe(event)
        })),
      byName: [...byName.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, dur]) => ({ name, ms: Math.round(dur / 1000) }))
    });
  }
  return { navigationStart: origin, tasks };
}

async function throttle(cdp, args) {
  await cdp.send('Network.enable');
  const network = NETWORK_PROFILES[args.network];
  if (network)
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      ...network
    });
  if (args.cpu > 1)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: args.cpu });
}

async function openDemo(page, demo) {
  await page
    // A plain substring match: the demo name comes from the command line.
    .getByRole('button', { name: demo })
    .first()
    .click({ timeout: 60_000 });
}

async function launch(args, profileDir) {
  return chromium.launchPersistentContext(profileDir, {
    headless: !args.headed,
    ...(args.channel ? { channel: args.channel } : {}),
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark'
  });
}

async function measureRun(page, cdp, args, index, navigate) {
  const network = trackNetwork(cdp);
  if (args.trace)
    await cdp.send('Tracing.start', {
      categories: TRACE_CATEGORIES,
      transferMode: 'ReturnAsStream'
    });
  await navigate();
  const readiness = await waitForReady(page);
  await page.waitForTimeout(args.settleMs);
  const sample = { run: index + 1, readiness, ...(await collect(page)) };
  if (args.trace) {
    const events = await readTrace(cdp);
    mkdirSync(args.trace, { recursive: true });
    writeFileSync(
      path.join(args.trace, `${args.mode}-${index + 1}.json`),
      JSON.stringify(events)
    );
    sample.attribution = attributeLongTasks(events).tasks;
  }
  // Prefetching starts after the model is visible; let it finish.
  await network.settled(5_000, 120_000);
  sample.network = network.summary();
  // LCP keeps moving until the first input; by now it has usually settled
  // on whatever text appeared last, which is why it is not a readiness signal.
  sample.lcpAfterSettle = await page.evaluate(() => {
    const lcp = window.__ozStartupProbe?.lcp;
    return lcp ? { start: Math.round(lcp.start), element: lcp.element } : null;
  });
  return sample;
}

function median(values) {
  const finite = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2
    ? finite[middle]
    : Math.round((finite[middle - 1] + finite[middle]) / 2);
}

export function summarize(samples) {
  const pick = (read) => {
    const values = samples.map(read);
    return {
      median: median(values),
      min: Math.min(...values.filter(Number.isFinite)),
      max: Math.max(...values.filter(Number.isFinite))
    };
  };
  const longest = (sample) =>
    Math.max(0, ...sample.longTasks.map((task) => task.duration));
  return {
    modelVisible: pick((sample) => sample.milestones.modelVisible),
    inputReady: pick((sample) => sample.milestones.inputReady),
    startupReady: pick((sample) => sample.milestones.startupReady),
    viewerFirstFrame: pick((sample) => sample.milestones.viewerFirstFrame),
    longestTask: pick(longest),
    longTaskCount: pick((sample) => sample.longTasks.length),
    longTaskTotal: pick((sample) =>
      sample.longTasks.reduce((total, task) => total + task.duration, 0)
    ),
    lcp: pick((sample) => sample.lcp?.start)
  };
}

export async function run(args) {
  const server = await serve(args.dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const samples = [];
  const profiles = [];
  try {
    if (args.mode === 'warm') {
      const profile = mkdtempSync(path.join(os.tmpdir(), 'oz-startup-'));
      profiles.push(profile);
      const context = await launch(args, profile);
      await context.addInitScript(installObservers);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(base);
      await openDemo(page, args.demo);
      await waitForReady(page);
      await page.waitForTimeout(args.settleMs);
      const cdp = await context.newCDPSession(page);
      await throttle(cdp, args);
      for (let index = 0; index < args.runs; index += 1) {
        samples.push(
          await measureRun(page, cdp, args, index, () => page.reload())
        );
        process.stderr.write(`run ${index + 1}/${args.runs}\n`);
      }
      await context.close();
    } else {
      for (let index = 0; index < args.runs; index += 1) {
        const profile = mkdtempSync(path.join(os.tmpdir(), 'oz-startup-'));
        profiles.push(profile);
        const context = await launch(args, profile);
        await context.addInitScript(installObservers);
        const page = context.pages()[0] ?? (await context.newPage());
        const cdp = await context.newCDPSession(page);
        await throttle(cdp, args);
        samples.push(
          await measureRun(page, cdp, args, index, async () => {
            await page.goto(base);
            await openDemo(page, args.demo);
          })
        );
        await context.close();
        process.stderr.write(`run ${index + 1}/${args.runs}\n`);
      }
    }
  } finally {
    server.close();
    for (const profile of profiles)
      rmSync(profile, { recursive: true, force: true });
  }
  return {
    mode: args.mode,
    demo: args.demo,
    runs: args.runs,
    headed: args.headed,
    channel: args.channel,
    cpuThrottling: args.cpu,
    network: args.network,
    renderer: samples[0]?.renderer ?? null,
    summary: summarize(samples),
    samples
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = parseArgs(process.argv.slice(2));
  const report = await run(args);
  const text = JSON.stringify(report, null, 2);
  if (args.out) writeFileSync(args.out, text);
  console.log(text);
}
