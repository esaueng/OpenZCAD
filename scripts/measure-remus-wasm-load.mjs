#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  KERNEL_WASM_ASSET_PATTERN,
  measureKernelWasm
} from './bundle-size-policy.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const DEFAULT_RUNS = 20;

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
    assetPath,
    absolutePath,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizes,
    openzcadCommit: metadata.commit,
    remusCommit: metadata.remus.commit,
    remusVersion: metadata.remus.version
  };
}

function parseArgs(argv) {
  const args = {
    dist: path.join(repoRoot, 'apps/web/dist'),
    runs: DEFAULT_RUNS,
    out: null,
    executablePath: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--dist') {
      args.dist = path.resolve(argv[++index]);
    } else if (arg === '--runs') {
      args.runs = Number(argv[++index]);
    } else if (arg === '--out') {
      args.out = path.resolve(argv[++index]);
    } else if (arg === '--browser-executable') {
      args.executablePath = path.resolve(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    throw new Error('--runs expects a positive integer.');
  }
  return args;
}

function startServer(artifact) {
  let assetRequests = 0;
  const etag = `"${artifact.sha256}"`;
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (request.url === '/') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8'
      });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>WASM baseline</title>'
      );
      return;
    }
    if (request.url === `/${artifact.assetPath}`) {
      assetRequests += 1;
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, {
          'Cache-Control': 'public, max-age=31536000, immutable',
          ETag: etag
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': artifact.bytes.byteLength,
        'Content-Type': 'application/wasm',
        ETag: etag
      });
      response.end(artifact.bytes);
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
        requestCount: () => assetRequests
      });
    });
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

      const instantiateStart = performance.now();
      const instance = new WebAssembly.Instance(module, imports);
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

async function runSample(server, artifact, executablePath) {
  const launchOptions = {
    headless: true,
    args: ['--enable-precise-memory-info']
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  const context = await chromium.launchPersistentContext('', launchOptions);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
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

function printSummary(report) {
  const rows = [['phase', 'metric', 'median', 'p95']];
  for (const phase of ['cold', 'warm']) {
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
        phase,
        metric,
        printable(values.median, unit),
        printable(values.p95, unit)
      ]);
    }
  }
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

export async function runBenchmark(args) {
  const artifact = resolveKernelArtifact(args.dist);
  const server = await startServer(artifact);
  const samples = [];
  const loadAverageBefore = os.loadavg();
  const freeMemoryBeforeBytes = os.freemem();
  try {
    for (let index = 0; index < args.runs; index += 1) {
      process.stderr.write(`sample ${index + 1}/${args.runs}\r`);
      samples.push(await runSample(server, artifact, args.executablePath));
    }
  } finally {
    process.stderr.write('\n');
    await server.close();
  }

  const first = samples[0];
  const report = {
    format: 'openzcad-remus-wasm-load-baseline',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    provenance: {
      openzcadCommit: artifact.openzcadCommit,
      remusCommit: artifact.remusCommit,
      remusVersion: artifact.remusVersion,
      assetPath: artifact.assetPath,
      assetSha256: artifact.sha256,
      ...artifact.sizes
    },
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
      crossOriginIsolated: samples.every((sample) => sample.crossOriginIsolated)
    },
    protocol: {
      runs: args.runs,
      statistics: 'midpoint median; nearest-rank p95',
      cold: 'fresh Chromium process, empty browser cache, fetch cache mode default',
      warm: 'same Chromium process after releasing the cold instance, fetch cache mode default',
      retainedMemory:
        'post-GC delta while retaining asset bytes, compiled module, and instance',
      imports:
        'signature-compatible no-op function imports; wasm-bindgen start and kernel construction are excluded'
    },
    summary: {
      cold: summarizePhase(samples, 'cold'),
      warm: summarizePhase(samples, 'warm')
    },
    samples: samples.map(({ cold, warm }) => ({ cold, warm }))
  };
  printSummary(report);
  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`report: ${args.out}\n`);
  }
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
