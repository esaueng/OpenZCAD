#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import {
  KERNEL_LOAD_POLICY,
  KERNEL_WASM_ASSET_PATTERN,
  evaluateKernelLoad,
  evaluateKernelLoadRegression,
  measureKernelWasm
} from './bundle-size-policy.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const DEFAULT_RUNS = 20;
const DEFAULT_WARM_SETTLE_MS = 3000;
const DEFAULT_PACKAGE_GLUE_DIRECTORY = path.join(
  repoRoot,
  'packages/kernel-adapter/node_modules/remus-wasm'
);
const GLUE_FILE = 'remus_wasm_bg.js';
const GLUE_IMPORT_MODULE = './remus_wasm_bg.js';
const PACKAGE_WASM_FILE = 'remus_wasm_bg.wasm';

/**
 * Browser profiles for the kernel load gates. `desktop` is the unthrottled
 * host. `mobile` is the mobile-class profile: Chrome DevTools Protocol CPU
 * throttling of the renderer main thread plus Fast 4G-class network shaping.
 */
export const LOAD_PROFILES = Object.freeze({
  desktop: Object.freeze({
    cpuThrottlingRate: 1,
    network: null
  }),
  mobile: Object.freeze({
    cpuThrottlingRate: 4,
    network: Object.freeze({
      latencyMs: 150,
      downloadBitsPerSecond: 9_000_000,
      uploadBitsPerSecond: 1_500_000
    })
  })
});

export const CONTENT_ENCODINGS = Object.freeze(['gzip', 'identity']);

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  if (!(fraction > 0 && fraction <= 1)) {
    throw new Error(
      'Percentile fraction must be greater than 0 and at most 1.'
    );
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

export function summarize(values) {
  const finite = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const midpoint = Math.floor(finite.length / 2);
  const median =
    finite.length === 0
      ? null
      : finite.length % 2 === 0
        ? (finite[midpoint - 1] + finite[midpoint]) / 2
        : finite[midpoint];
  return {
    median,
    p95: percentile(finite, 0.95)
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function resolveKernelArtifact(distDirectory) {
  const metadataPath = path.join(distDirectory, 'build-meta.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (
    metadata.format !== 'openzcad-build-metadata' ||
    metadata.formatVersion !== 2 ||
    !/^[0-9a-f]{40}$/i.test(metadata.commit) ||
    !/^[0-9a-f]{40}$/i.test(metadata.remus?.commit) ||
    typeof metadata.remus?.version !== 'string' ||
    !Array.isArray(metadata.assets)
  ) {
    throw new Error(
      `Build provenance is missing or malformed in ${metadataPath}`
    );
  }

  const matches = metadata.assets.filter(
    (entry) =>
      typeof entry === 'string' && KERNEL_WASM_ASSET_PATTERN.test(entry)
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one emitted Remus kernel WASM asset; found ${matches.length}`
    );
  }

  const assetPath = matches[0];
  const absolutePath = path.resolve(distDirectory, assetPath);
  const relativePath = path.relative(path.resolve(distDirectory), absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(
      `Kernel asset escapes the distribution directory: ${assetPath}`
    );
  }
  const bytes = readFileSync(absolutePath);
  const sizes = measureKernelWasm(bytes);
  return {
    source: 'build',
    assetPath,
    absolutePath,
    bytes,
    sha256: sha256(bytes),
    sizes,
    openzcadCommit: metadata.commit,
    remusCommit: metadata.remus.commit,
    remusVersion: metadata.remus.version
  };
}

/**
 * A `remus-wasm` package directory (`remus_wasm_bg.wasm` plus its
 * wasm-bindgen glue) measured without an OpenZCAD build, so a candidate
 * kernel can be load-tested before it is pinned.
 */
export function resolvePackageArtifact(packageDirectory) {
  const manifest = JSON.parse(
    readFileSync(path.join(packageDirectory, 'package.json'), 'utf8')
  );
  if (manifest.name !== 'remus-wasm' || typeof manifest.version !== 'string') {
    throw new Error(
      `${packageDirectory} is not a remus-wasm package directory`
    );
  }
  const absolutePath = path.join(packageDirectory, PACKAGE_WASM_FILE);
  const bytes = readFileSync(absolutePath);
  const sizes = measureKernelWasm(bytes);
  return {
    source: 'package',
    assetPath: `assets/${PACKAGE_WASM_FILE}`,
    absolutePath,
    bytes,
    sha256: sha256(bytes),
    sizes,
    openzcadCommit: null,
    remusCommit: null,
    remusVersion: manifest.version
  };
}

/**
 * The wasm-bindgen glue that drives `__wbindgen_start` and the `BrepKernel`
 * constructor. The production bundle inlines it into a worker chunk, so the
 * harness takes it from the package and refuses a package whose WASM is not
 * byte-identical to the measured asset: glue and module must match.
 */
export function resolveKernelGlue(packageDirectory, expectedSha256) {
  const wasmPath = path.join(packageDirectory, PACKAGE_WASM_FILE);
  const gluePath = path.join(packageDirectory, GLUE_FILE);
  if (!existsSync(wasmPath) || !existsSync(gluePath)) {
    throw new Error(
      `Kernel glue is missing: expected ${GLUE_FILE} and ${PACKAGE_WASM_FILE} in ${packageDirectory}`
    );
  }
  const packageSha256 = sha256(readFileSync(wasmPath));
  if (packageSha256 !== expectedSha256) {
    throw new Error(
      `The package WASM in ${packageDirectory} (${packageSha256}) does not match the measured kernel asset (${expectedSha256}); kernel-ready needs the glue built with that module.`
    );
  }
  return readFileSync(gluePath);
}

export function parseArgs(argv) {
  const args = {
    dist: path.join(repoRoot, 'apps/web/dist'),
    packageDirectory: null,
    glueDirectory: null,
    runs: DEFAULT_RUNS,
    out: null,
    executablePath: null,
    profile: 'desktop',
    encoding: 'gzip',
    warmSettleMs: DEFAULT_WARM_SETTLE_MS,
    check: false,
    baselinePackageDirectory: null,
    modulePhases: true,
    markdown: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--dist') {
      args.dist = path.resolve(argv[++index]);
    } else if (arg === '--package') {
      args.packageDirectory = path.resolve(argv[++index]);
    } else if (arg === '--glue') {
      args.glueDirectory = path.resolve(argv[++index]);
    } else if (arg === '--runs') {
      args.runs = Number(argv[++index]);
    } else if (arg === '--out') {
      args.out = path.resolve(argv[++index]);
    } else if (arg === '--browser-executable') {
      args.executablePath = path.resolve(argv[++index]);
    } else if (arg === '--profile') {
      args.profile = argv[++index];
    } else if (arg === '--encoding') {
      args.encoding = argv[++index];
    } else if (arg === '--warm-settle-ms') {
      args.warmSettleMs = Number(argv[++index]);
    } else if (arg === '--check') {
      args.check = true;
    } else if (arg === '--baseline-package') {
      args.baselinePackageDirectory = path.resolve(argv[++index]);
    } else if (arg === '--kernel-ready-only') {
      args.modulePhases = false;
    } else if (arg === '--markdown') {
      args.markdown = path.resolve(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    throw new Error('--runs expects a positive integer.');
  }
  if (!Object.hasOwn(LOAD_PROFILES, args.profile)) {
    throw new Error(
      `--profile expects one of: ${Object.keys(LOAD_PROFILES).join(', ')}.`
    );
  }
  if (!CONTENT_ENCODINGS.includes(args.encoding)) {
    throw new Error(
      `--encoding expects one of: ${CONTENT_ENCODINGS.join(', ')}.`
    );
  }
  if (!Number.isInteger(args.warmSettleMs) || args.warmSettleMs < 0) {
    throw new Error('--warm-settle-ms expects a non-negative integer.');
  }
  if (
    (args.check || args.baselinePackageDirectory) &&
    args.runs < KERNEL_LOAD_POLICY.minimumRuns
  ) {
    throw new Error(
      `--check and --baseline-package need at least ${KERNEL_LOAD_POLICY.minimumRuns} runs for a p95.`
    );
  }
  return args;
}

const HARNESS_PAGE =
  '<!doctype html><meta charset="utf-8"><title>WASM baseline</title>';

/**
 * Kernel-ready, the way the production worker reaches it: vite-plugin-wasm's
 * helper fetches the asset and calls `WebAssembly.instantiateStreaming` (the
 * path that compiles while downloading and that Chromium's compiled-module
 * cache serves), wasm-bindgen's entry runs `__wbindgen_start`, and the
 * adapter constructs the first `BrepKernel`. The glue module is imported
 * before the clock starts; it ships in a JavaScript chunk with its own budget.
 */
const HARNESS_MODULE = `import * as glue from './${GLUE_FILE}';

export async function measureKernelReady(url) {
  performance.clearResourceTimings();
  const start = performance.now();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('WASM fetch failed with HTTP ' + response.status);
  }
  const responseMs = performance.now() - start;
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.startsWith('application/wasm')) {
    throw new Error('instantiateStreaming needs application/wasm, got ' + contentType);
  }
  const { instance } = await WebAssembly.instantiateStreaming(response, {
    '${GLUE_IMPORT_MODULE}': glue
  });
  const instantiatedMs = performance.now() - start;
  glue.__wbg_set_wasm(instance.exports);
  instance.exports.__wbindgen_start();
  const startedMs = performance.now() - start;
  const kernel = new glue.BrepKernel();
  const readyMs = performance.now() - start;
  kernel.free();
  const resource = performance.getEntriesByName(url).at(-1);
  const timing = resource instanceof PerformanceResourceTiming ? resource : null;
  return {
    readyMs,
    responseMs,
    instantiateStreamingMs: instantiatedMs - responseMs,
    wbindgenStartMs: startedMs - instantiatedMs,
    constructMs: readyMs - startedMs,
    transferBytes: timing ? timing.transferSize : null,
    encodedBodyBytes: timing ? timing.encodedBodySize : null,
    decodedBodyBytes: timing ? timing.decodedBodySize : null
  };
}
`;

function startServer(artifact, glue, encoding) {
  let assetRequests = 0;
  const encodedBodies = new Map([
    ['identity', artifact.bytes],
    ['gzip', encoding === 'gzip' ? gzipSync(artifact.bytes) : null]
  ]);
  const etag = `"${artifact.sha256}-${encoding}"`;
  const encodingsServed = new Set();
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (request.url === '/') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8'
      });
      response.end(HARNESS_PAGE);
      return;
    }
    if (request.url === '/harness.mjs' || request.url === `/${GLUE_FILE}`) {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/javascript; charset=utf-8'
      });
      response.end(request.url === '/harness.mjs' ? HARNESS_MODULE : glue);
      return;
    }
    if (request.url === `/${artifact.assetPath}`) {
      assetRequests += 1;
      const accepted = String(request.headers['accept-encoding'] ?? '');
      const applied =
        encoding === 'gzip' && /\bgzip\b/.test(accepted) ? 'gzip' : 'identity';
      encodingsServed.add(applied);
      const headers = {
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag,
        Vary: 'Accept-Encoding'
      };
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      const body = encodedBodies.get(applied);
      response.writeHead(200, {
        ...headers,
        'Content-Length': body.byteLength,
        'Content-Type': 'application/wasm',
        ...(applied === 'gzip' ? { 'Content-Encoding': 'gzip' } : {})
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to resolve the benchmark server address.'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
        requestCount: () => assetRequests,
        encodingsServed: () => [...encodingsServed].sort(),
        encodedBytes: encodedBodies.get(encoding).byteLength
      });
    });
  });
}

async function applyProfile(cdp, profile) {
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  if (profile.network) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: profile.network.latencyMs,
      downloadThroughput: profile.network.downloadBitsPerSecond / 8,
      uploadThroughput: profile.network.uploadBitsPerSecond / 8
    });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', {
    rate: profile.cpuThrottlingRate
  });
}

async function memorySnapshot(page, cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const userAgent = await page.evaluate(async () => {
    const measure = performance.measureUserAgentSpecificMemory;
    if (typeof measure !== 'function') {
      return {
        bytes: null,
        error: 'measureUserAgentSpecificMemory unavailable'
      };
    }
    try {
      const result = await measure.call(performance);
      return { bytes: result.bytes, error: null };
    } catch (error) {
      return {
        bytes: null,
        error: String(error instanceof Error ? error.message : error)
      };
    }
  });
  return {
    jsHeapUsedBytes: heap.usedSize,
    userAgentBytes: userAgent.bytes,
    userAgentError: userAgent.error
  };
}

async function exercisePhase(page, assetUrl, cache) {
  return page.evaluate(
    async ({ url, cacheMode }) => {
      performance.clearResourceTimings();
      const loadStart = performance.now();
      const response = await fetch(url, { cache: cacheMode });
      if (!response.ok) {
        throw new Error(`WASM fetch failed with HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      const loadMs = performance.now() - loadStart;

      const compileStart = performance.now();
      const module = await WebAssembly.compile(bytes);
      const compileMs = performance.now() - compileStart;

      const imports = {};
      for (const entry of WebAssembly.Module.imports(module)) {
        if (entry.kind !== 'function') {
          throw new Error(
            `Unsupported ${entry.kind} import ${entry.module}.${entry.name}`
          );
        }
        imports[entry.module] ??= {};
        imports[entry.module][entry.name] = () => 0;
      }

      // Chromium refuses the synchronous `new WebAssembly.Instance` on the
      // main thread for modules over 8 MB; the asynchronous form given a
      // compiled Module resolves to the Instance alone.
      const instantiateStart = performance.now();
      const instance = await WebAssembly.instantiate(module, imports);
      const instantiateMs = performance.now() - instantiateStart;
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) {
        throw new Error(
          'The emitted Remus module did not export linear memory.'
        );
      }

      window.__openzcadWasmBaselineRetained = { bytes, module, instance };
      const resource = performance.getEntriesByName(url).at(-1);
      return {
        loadMs,
        compileMs,
        instantiateMs,
        retainedPayloadFloorBytes: bytes.byteLength + memory.buffer.byteLength,
        wasmLinearBytes: memory.buffer.byteLength,
        transferBytes:
          resource instanceof PerformanceResourceTiming
            ? resource.transferSize
            : null,
        decodedBodyBytes:
          resource instanceof PerformanceResourceTiming
            ? resource.decodedBodySize
            : null
      };
    },
    { url: assetUrl, cacheMode: cache }
  );
}

function retainedDelta(before, after, key) {
  return before[key] == null || after[key] == null
    ? null
    : after[key] - before[key];
}

async function launchContext(executablePath) {
  const launchOptions = {
    headless: true,
    args: ['--enable-precise-memory-info']
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  return chromium.launchPersistentContext('', launchOptions);
}

/**
 * The module phases: raw-byte fetch, `WebAssembly.compile` from bytes, and
 * instantiation against no-op imports, with retained-memory deltas.
 */
async function runModuleSample(server, artifact, args) {
  const context = await launchContext(args.executablePath);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    await applyProfile(cdp, LOAD_PROFILES[args.profile]);
    await page.goto(server.baseUrl, { waitUntil: 'load' });
    const assetUrl = new URL(artifact.assetPath, `${server.baseUrl}/`).href;
    const crossOriginIsolated = await page.evaluate(
      () => self.crossOriginIsolated
    );

    const coldBefore = await memorySnapshot(page, cdp);
    const coldRequestStart = server.requestCount();
    const coldTimings = await exercisePhase(page, assetUrl, 'default');
    const coldAfter = await memorySnapshot(page, cdp);
    const cold = {
      ...coldTimings,
      networkRequests: server.requestCount() - coldRequestStart,
      retainedUserAgentBytes: retainedDelta(
        coldBefore,
        coldAfter,
        'userAgentBytes'
      ),
      retainedJsHeapBytes: retainedDelta(
        coldBefore,
        coldAfter,
        'jsHeapUsedBytes'
      ),
      memoryMeasurementError:
        coldAfter.userAgentError ?? coldBefore.userAgentError
    };

    await page.evaluate(() => {
      window.__openzcadWasmBaselineRetained = null;
    });
    const warmBefore = await memorySnapshot(page, cdp);
    const warmRequestStart = server.requestCount();
    const warmTimings = await exercisePhase(page, assetUrl, 'default');
    const warmAfter = await memorySnapshot(page, cdp);
    const warm = {
      ...warmTimings,
      networkRequests: server.requestCount() - warmRequestStart,
      retainedUserAgentBytes: retainedDelta(
        warmBefore,
        warmAfter,
        'userAgentBytes'
      ),
      retainedJsHeapBytes: retainedDelta(
        warmBefore,
        warmAfter,
        'jsHeapUsedBytes'
      ),
      memoryMeasurementError:
        warmAfter.userAgentError ?? warmBefore.userAgentError
    };

    return {
      cold,
      warm,
      crossOriginIsolated,
      browserVersion: context.browser()?.version() ?? 'unknown',
      userAgent: await page.evaluate(() => navigator.userAgent)
    };
  } finally {
    await context.close();
  }
}

async function measureReadyOnFreshDocument(page, cdp, server, args, assetUrl) {
  await page.goto(server.baseUrl, { waitUntil: 'load' });
  // Re-assert the profile on the new document; CDP emulation is per target
  // and a navigation must not silently drop the throttle.
  await applyProfile(cdp, LOAD_PROFILES[args.profile]);
  const requestStart = server.requestCount();
  const result = await page.evaluate(async (url) => {
    const harness = await import('/harness.mjs');
    return harness.measureKernelReady(url);
  }, assetUrl);
  return { ...result, networkRequests: server.requestCount() - requestStart };
}

/**
 * Kernel-ready, cold then warm, in one fresh browser profile. Cold: empty
 * HTTP cache and no compiled-module cache. Warm: after a settle period in
 * which Chromium may write the compiled module into its code cache, a new
 * document in the same profile loads the kernel again.
 */
async function runKernelReadySample(server, artifact, args) {
  const context = await launchContext(args.executablePath);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    const assetUrl = new URL(artifact.assetPath, `${server.baseUrl}/`).href;
    const cold = await measureReadyOnFreshDocument(
      page,
      cdp,
      server,
      args,
      assetUrl
    );
    if (args.warmSettleMs > 0) await page.waitForTimeout(args.warmSettleMs);
    const warm = await measureReadyOnFreshDocument(
      page,
      cdp,
      server,
      args,
      assetUrl
    );
    return {
      kernelReady: { cold, warm },
      crossOriginIsolated: await page.evaluate(() => self.crossOriginIsolated),
      browserVersion: context.browser()?.version() ?? 'unknown',
      userAgent: await page.evaluate(() => navigator.userAgent)
    };
  } finally {
    await context.close();
  }
}

/**
 * Refuse a run whose cache state contradicts its label: a cold load must
 * reach the server and a warm one must not. Without this a broken protocol
 * (a disabled cache, a warm load that refetched) would still yield a number
 * that a gate then reads as evidence.
 */
export function assertCacheProtocol(samples) {
  samples.forEach(({ kernelReady }, index) => {
    if (kernelReady.cold.networkRequests !== 1) {
      throw new Error(
        `Sample ${index + 1}: cold kernel-ready made ${kernelReady.cold.networkRequests} asset requests; expected 1.`
      );
    }
    if (kernelReady.warm.networkRequests !== 0) {
      throw new Error(
        `Sample ${index + 1}: warm kernel-ready made ${kernelReady.warm.networkRequests} asset requests; expected a cache hit.`
      );
    }
  });
}

function summarizePhase(samples, phase) {
  const values = (key) => samples.map((sample) => sample[phase][key]);
  return {
    loadMs: summarize(values('loadMs')),
    compileMs: summarize(values('compileMs')),
    instantiateMs: summarize(values('instantiateMs')),
    retainedUserAgentBytes: summarize(values('retainedUserAgentBytes')),
    retainedJsHeapBytes: summarize(values('retainedJsHeapBytes')),
    retainedPayloadFloorBytes: summarize(values('retainedPayloadFloorBytes')),
    wasmLinearBytes: summarize(values('wasmLinearBytes')),
    networkRequests: summarize(values('networkRequests'))
  };
}

function summarizeReady(samples, phase) {
  const values = (key) =>
    samples.map((sample) => sample.kernelReady[phase][key]);
  return {
    readyMs: summarize(values('readyMs')),
    responseMs: summarize(values('responseMs')),
    instantiateStreamingMs: summarize(values('instantiateStreamingMs')),
    wbindgenStartMs: summarize(values('wbindgenStartMs')),
    constructMs: summarize(values('constructMs')),
    transferBytes: summarize(values('transferBytes')),
    networkRequests: summarize(values('networkRequests'))
  };
}

function cpuGovernor() {
  try {
    return readFileSync(
      '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor',
      'utf8'
    ).trim();
  } catch {
    return null;
  }
}

function round(value, digits = 2) {
  return value == null ? null : Number(value.toFixed(digits));
}

function printable(value, unit) {
  if (value == null) return '—';
  if (unit === 'bytes') return `${round(value / (1024 * 1024))} MiB`;
  return `${round(value)} ${unit}`;
}

function printTable(rows) {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length))
  );
  process.stdout.write(
    `${rows
      .map((row) =>
        row.map((cell, column) => cell.padEnd(widths[column])).join('  ')
      )
      .join('\n')}\n`
  );
}

function printSummary(report, args) {
  const rows = [['phase', 'metric', 'median', 'p95']];
  for (const phase of ['cold', 'warm']) {
    for (const [metric, unit] of [
      ['readyMs', 'ms'],
      ['responseMs', 'ms'],
      ['instantiateStreamingMs', 'ms'],
      ['wbindgenStartMs', 'ms'],
      ['constructMs', 'ms'],
      ['transferBytes', 'bytes']
    ]) {
      const values = report.summary.kernelReady[phase][metric];
      rows.push([
        `kernel-ready ${phase}`,
        metric,
        printable(values.median, unit),
        printable(values.p95, unit)
      ]);
    }
  }
  for (const phase of args.modulePhases ? ['cold', 'warm'] : []) {
    for (const [metric, unit] of [
      ['loadMs', 'ms'],
      ['compileMs', 'ms'],
      ['instantiateMs', 'ms'],
      ['retainedUserAgentBytes', 'bytes'],
      ['retainedJsHeapBytes', 'bytes'],
      ['retainedPayloadFloorBytes', 'bytes'],
      ['wasmLinearBytes', 'bytes']
    ]) {
      const values = report.summary[phase][metric];
      rows.push([
        `module ${phase}`,
        metric,
        printable(values.median, unit),
        printable(values.p95, unit)
      ]);
    }
  }
  printTable(rows);
}

function annotation(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function reportGates(gates) {
  const rows = [['load gate', 'p95', 'review budget', 'result']];
  for (const result of gates.results) {
    rows.push([
      result.code,
      printable(result.p95Ms, 'ms'),
      printable(result.budgetMs, 'ms'),
      result.withinBudget ? 'ok' : 'REVIEW'
    ]);
  }
  printTable(rows);
  for (const warning of gates.warnings) {
    const message = `${warning.reason}: p95 ${round(warning.p95Ms)} ms exceeds the ${warning.budgetMs} ms review budget (${gates.profile} profile).`;
    process.stdout.write(`review: ${message}\n`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      process.stdout.write(
        `::warning title=Kernel load review (${annotation(warning.code)})::${annotation(message)}\n`
      );
    }
  }
}

function printComparison(report) {
  const rows = [
    [
      'kernel-ready',
      'baseline p50',
      'candidate p50',
      'baseline p95',
      'candidate p95'
    ]
  ];
  for (const phase of ['cold', 'warm']) {
    const before = report.baseline.summary.kernelReady[phase].readyMs;
    const after = report.summary.kernelReady[phase].readyMs;
    rows.push([
      phase,
      printable(before.median, 'ms'),
      printable(after.median, 'ms'),
      printable(before.p95, 'ms'),
      printable(after.p95, 'ms')
    ]);
  }
  process.stdout.write(
    `baseline remus-wasm ${report.baseline.provenance.remusVersion} vs candidate ${report.provenance.remusVersion}\n`
  );
  printTable(rows);
}

function reportRegression(regression) {
  for (const result of regression.results) {
    process.stdout.write(
      `${result.code}: candidate p50 ${round(result.candidateP50Ms)} ms, allowed ${round(result.allowedP50Ms)} ms (baseline ${round(result.baselineP50Ms)} ms) -> ${result.withinBudget ? 'ok' : 'REVIEW'}\n`
    );
  }
  for (const warning of regression.warnings) {
    const message = `${warning.reason}: candidate p50 ${round(warning.candidateP50Ms)} ms exceeds ${round(warning.allowedP50Ms)} ms (baseline ${round(warning.baselineP50Ms)} ms, ${regression.profile} profile).`;
    process.stdout.write(`review: ${message}\n`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      process.stdout.write(
        `::warning title=Kernel load regression review (${annotation(warning.code)})::${annotation(message)}\n`
      );
    }
  }
}

function markdownMs(value) {
  return value == null ? '—' : `${Math.round(value)} ms`;
}

/**
 * A pull-request section for one profile: candidate kernel-ready against the
 * review budget and, with a baseline, against the current pin.
 */
export function markdownSection(report) {
  const { profile, runs } = report.protocol;
  const candidate = report.provenance.remusVersion;
  const baseline = report.baseline?.provenance.remusVersion ?? null;
  const lines = [
    `### Kernel load time: ${profile} profile`,
    '',
    baseline
      ? `\`remus-wasm\` ${baseline} (current pin) against ${candidate}, ${runs} alternating samples each, p50/p95 of kernel-ready (fetch, \`instantiateStreaming\`, \`__wbindgen_start\`, \`new BrepKernel()\`).`
      : `\`remus-wasm\` ${candidate}, ${runs} samples, p50/p95 of kernel-ready (fetch, \`instantiateStreaming\`, \`__wbindgen_start\`, \`new BrepKernel()\`).`,
    ''
  ];
  const header = baseline
    ? '| Phase | Pin p50 | Candidate p50 | Pin p95 | Candidate p95 | Allowed p50 | Review budget | Result |'
    : '| Phase | p50 | p95 | Review budget | Result |';
  lines.push(
    header,
    header.replace(/[^|]+/g, (cell, offset) =>
      offset === 1 ? ' --- ' : ' ---: '
    )
  );
  for (const phase of ['cold', 'warm']) {
    const after = report.summary.kernelReady[phase].readyMs;
    const gate = report.gates.results.find((result) =>
      result.code.endsWith(`-${phase}-review`)
    );
    const regression = report.regression?.results.find((result) =>
      result.code.endsWith(`-${phase}-regression`)
    );
    const flags = [
      ...(gate.withinBudget ? [] : ['over budget']),
      ...(regression && !regression.withinBudget ? ['slower than pin'] : [])
    ];
    const result =
      flags.length === 0 ? 'ok' : `**review: ${flags.join(', ')}**`;
    if (baseline) {
      const before = report.baseline.summary.kernelReady[phase].readyMs;
      lines.push(
        `| ${phase} | ${markdownMs(before.median)} | ${markdownMs(after.median)} | ${markdownMs(before.p95)} | ${markdownMs(after.p95)} | ${markdownMs(regression.allowedP50Ms)} | ${markdownMs(gate.budgetMs)} | ${result} |`
      );
    } else {
      lines.push(
        `| ${phase} | ${markdownMs(after.median)} | ${markdownMs(after.p95)} | ${markdownMs(gate.budgetMs)} | ${result} |`
      );
    }
  }
  lines.push('', '');
  return lines.join('\n');
}

async function measureSample(server, artifact, args) {
  const ready = await runKernelReadySample(server, artifact, args);
  if (!args.modulePhases) return ready;
  const moduleSample = await runModuleSample(server, artifact, args);
  return {
    ...moduleSample,
    kernelReady: ready.kernelReady,
    crossOriginIsolated:
      ready.crossOriginIsolated && moduleSample.crossOriginIsolated
  };
}

function summarizeSamples(samples, args) {
  const summary = {
    kernelReady: {
      cold: summarizeReady(samples, 'cold'),
      warm: summarizeReady(samples, 'warm')
    }
  };
  if (args.modulePhases) {
    summary.cold = summarizePhase(samples, 'cold');
    summary.warm = summarizePhase(samples, 'warm');
  }
  return summary;
}

function readyStatistics(summary) {
  return {
    coldReadyP50Ms: summary.kernelReady.cold.readyMs.median,
    coldReadyP95Ms: summary.kernelReady.cold.readyMs.p95,
    warmReadyP50Ms: summary.kernelReady.warm.readyMs.median,
    warmReadyP95Ms: summary.kernelReady.warm.readyMs.p95
  };
}

function provenance(artifact, server, encoding) {
  return {
    source: artifact.source,
    openzcadCommit: artifact.openzcadCommit,
    remusCommit: artifact.remusCommit,
    remusVersion: artifact.remusVersion,
    assetPath: artifact.assetPath,
    assetSha256: artifact.sha256,
    ...artifact.sizes,
    servedEncoding: encoding,
    servedEncodedBytes: server.encodedBytes,
    encodingsServed: server.encodingsServed()
  };
}

async function openTarget(artifact, glueDirectory, encoding) {
  const glue = resolveKernelGlue(glueDirectory, artifact.sha256);
  return { artifact, server: await startServer(artifact, glue, encoding) };
}

export async function runBenchmark(args) {
  const candidateArtifact = args.packageDirectory
    ? resolvePackageArtifact(args.packageDirectory)
    : resolveKernelArtifact(args.dist);
  // Every opened server is closed by the `finally` below, including when a
  // later target (a missing or mismatched baseline package) fails to open:
  // an open server would otherwise keep the process alive instead of
  // reporting the error.
  const targets = [];
  const samples = [];
  const baselineSamples = [];
  const loadAverageBefore = os.loadavg();
  const freeMemoryBeforeBytes = os.freemem();
  let candidate;
  let baseline;
  try {
    candidate = await openTarget(
      candidateArtifact,
      args.glueDirectory ??
        args.packageDirectory ??
        DEFAULT_PACKAGE_GLUE_DIRECTORY,
      args.encoding
    );
    targets.push(candidate);
    if (args.baselinePackageDirectory) {
      baseline = await openTarget(
        resolvePackageArtifact(args.baselinePackageDirectory),
        args.baselinePackageDirectory,
        args.encoding
      );
      targets.push(baseline);
    }
    for (let index = 0; index < args.runs; index += 1) {
      process.stderr.write(`sample ${index + 1}/${args.runs}\r`);
      if (!baseline) {
        samples.push(
          await measureSample(candidate.server, candidate.artifact, args)
        );
        continue;
      }
      // Alternate which kernel goes first so drift on a shared host lands on
      // both sides of the comparison equally.
      const order =
        index % 2 === 0 ? [candidate, baseline] : [baseline, candidate];
      for (const target of order) {
        const sample = await measureSample(
          target.server,
          target.artifact,
          args
        );
        (target === candidate ? samples : baselineSamples).push(sample);
      }
    }
  } finally {
    process.stderr.write('\n');
    for (const target of targets) await target.server.close();
  }
  assertCacheProtocol(samples);
  assertCacheProtocol(baselineSamples);

  const profile = LOAD_PROFILES[args.profile];
  const summary = summarizeSamples(samples, args);
  const gates = evaluateKernelLoad(args.profile, readyStatistics(summary));
  const baselineSummary = baseline
    ? summarizeSamples(baselineSamples, args)
    : null;
  const regression = baseline
    ? evaluateKernelLoadRegression(
        args.profile,
        readyStatistics(baselineSummary),
        readyStatistics(summary)
      )
    : null;
  const first = samples[0];
  const report = {
    format: 'openzcad-remus-wasm-load-baseline',
    formatVersion: 2,
    generatedAt: new Date().toISOString(),
    provenance: provenance(candidate.artifact, candidate.server, args.encoding),
    environment: {
      os: `${os.platform()} ${os.release()}`,
      architecture: os.arch(),
      cpuModel: os.cpus()[0]?.model.trim() ?? null,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBeforeBytes,
      freeMemoryAfterBytes: os.freemem(),
      loadAverageBefore,
      loadAverageAfter: os.loadavg(),
      cpuGovernor: cpuGovernor(),
      node: process.versions.node,
      browser: first.browserVersion,
      userAgent: first.userAgent,
      headless: true,
      crossOriginIsolated: [...samples, ...baselineSamples].every(
        (sample) => sample.crossOriginIsolated
      )
    },
    protocol: {
      runs: args.runs,
      profile: args.profile,
      cpuThrottlingRate: profile.cpuThrottlingRate,
      network: profile.network,
      statistics: 'midpoint median; nearest-rank p95',
      kernelReady:
        'fetch + WebAssembly.instantiateStreaming + __wbindgen_start + new BrepKernel(), the production worker path; glue imported before the clock starts',
      kernelReadyCold:
        'fresh Chromium profile: empty HTTP cache, no compiled-module cache',
      kernelReadyWarm: `new document in the same profile after ${args.warmSettleMs} ms settle: HTTP cache hit, compiled-module cache when Chromium wrote one`,
      comparison: baseline
        ? 'baseline and candidate samples alternate, each in its own fresh profile and origin'
        : null,
      cold: args.modulePhases
        ? 'module phase: fresh Chromium process, empty browser cache, fetch cache mode default'
        : null,
      warm: args.modulePhases
        ? 'module phase: same Chromium process after releasing the cold instance, fetch cache mode default'
        : null,
      retainedMemory: args.modulePhases
        ? 'post-GC delta while retaining asset bytes, compiled module, and instance'
        : null,
      imports: args.modulePhases
        ? 'module phase: signature-compatible no-op function imports; wasm-bindgen start and kernel construction are excluded'
        : null
    },
    summary,
    gates,
    baseline: baseline
      ? {
          provenance: provenance(
            baseline.artifact,
            baseline.server,
            args.encoding
          ),
          summary: baselineSummary,
          samples: baselineSamples.map(({ cold, warm, kernelReady }) => ({
            kernelReady,
            cold,
            warm
          }))
        }
      : null,
    regression,
    samples: samples.map(({ cold, warm, kernelReady }) => ({
      kernelReady,
      cold,
      warm
    }))
  };
  printSummary(report, args);
  if (baseline) printComparison(report);
  if (args.check) reportGates(gates);
  if (regression) reportRegression(regression);
  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`report: ${args.out}\n`);
  }
  if (args.markdown) appendFileSync(args.markdown, markdownSection(report));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  Promise.resolve()
    .then(() => runBenchmark(parseArgs(process.argv.slice(2))))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
      process.exitCode = 1;
    });
}
