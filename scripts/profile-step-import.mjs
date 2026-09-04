#!/usr/bin/env node
/**
 * Remus STEP-import memory/time profiling harness.
 *
 * Answers: how large a STEP file can the shipped remus-wasm kernel import,
 * and what does peak wasm linear memory look like as file size grows? This is
 * the measurement behind raising the 12 MB import gate in App.tsx.
 *
 * Method
 *  - Synthesizes STEP files of target sizes by tiling a real seed file
 *    (samples/parametric-bracket.step): the DATA section is repeated with all
 *    `#N` entity ids offset per copy, so entity density and record shapes match
 *    real exports rather than one giant pathological entity.
 *  - Runs each rung in a fresh child process. Wasm linear memory never
 *    shrinks, so `memory.buffer.byteLength` after the import IS the high-water
 *    mark — but only if the instance starts cold.
 *  - The child captures the wasm memory object by wrapping
 *    `WebAssembly.Instance` before requiring the package's Node entry point.
 *  - Remus enforces hostile-input budgets (128 MiB input / 2M entities by
 *    default). When the default-budget call fails, the child retries with
 *    explicit maxInputBytes/maxEntities to learn whether the wasm API allows
 *    raising them or clamps to the production defaults.
 *
 * Usage
 *   node scripts/profile-step-import.mjs                  # default ladder
 *   node scripts/profile-step-import.mjs --sizes 25,100,250 --mesh
 *   node scripts/profile-step-import.mjs --out profile.json
 *
 * Flags
 *   --sizes <MB,MB,...>  ladder rungs in megabytes (default 12,25,50,100,128,200,250)
 *   --seed <path>        seed STEP file (default samples/parametric-bracket.step)
 *   --workdir <path>     where generated files live (default: os tmpdir; files are
 *                        cached by seed+size and reused across runs)
 *   --mesh               also tessellate every imported solid (viewer-shaped load)
 *   --out <path>         write full JSON results
 *   --child <path>       internal: run one measurement (spawned by the parent)
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const REMUS_PACKAGE_JSON = path.join(
  repoRoot,
  'packages/kernel-adapter/node_modules/remus-wasm/package.json'
);
// STEP parsing lives in the translator module; the kernel only restores the
// arena document it hands back.
const REMUS_IO_PACKAGE_JSON = path.join(
  repoRoot,
  'packages/kernel-adapter/node_modules/remus-wasm-io/package.json'
);

function nodeEntry(packageJson, name) {
  const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  if (typeof manifest.main !== 'string' || manifest.main.length === 0) {
    throw new Error(`${name} does not declare a Node entry point.`);
  }
  return path.join(path.dirname(packageJson), manifest.main);
}

function remusNodeEntry() {
  return nodeEntry(REMUS_PACKAGE_JSON, 'remus-wasm');
}

function remusIoNodeEntry() {
  return nodeEntry(REMUS_IO_PACKAGE_JSON, 'remus-wasm-io');
}

// Matches the app's display tessellation for a bracket-sized (~60 mm) part:
// linear = extent * DISPLAY_LINEAR_DEFLECTION_RATIO (2e-4), angular = 0.06.
// See packages/kernel-adapter/src/display-tessellation.ts.
const MESH_LINEAR_DEFLECTION = 0.012;
const MESH_ANGULAR_DEFLECTION = 0.06;

const CHILD_TIMEOUT_MS = 15 * 60 * 1000;
const CHILD_HEAP_MB = 8192;

const MiB = 1024 * 1024;

function parseArgs(argv) {
  const args = {
    sizesMb: [12, 25, 50, 100, 128, 200, 250],
    seed: path.join(repoRoot, 'samples/parametric-bracket.step'),
    workdir: path.join(os.tmpdir(), 'openzcad-step-profile'),
    mesh: false,
    out: null,
    child: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sizes') {
      args.sizesMb = argv[++i].split(',').map(Number);
    } else if (arg === '--seed') {
      args.seed = path.resolve(argv[++i]);
    } else if (arg === '--workdir') {
      args.workdir = path.resolve(argv[++i]);
    } else if (arg === '--mesh') {
      args.mesh = true;
    } else if (arg === '--out') {
      args.out = path.resolve(argv[++i]);
    } else if (arg === '--child') {
      args.child = path.resolve(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.sizesMb.some((size) => !Number.isFinite(size) || size <= 0)) {
    throw new Error('--sizes expects a comma-separated list of megabytes.');
  }
  return args;
}

/* ------------------------------------------------------------------ */
/* Synthetic STEP generation                                          */
/* ------------------------------------------------------------------ */

function splitSeed(seedText) {
  const dataStart = seedText.indexOf('\nDATA;');
  const dataEnd = seedText.lastIndexOf('ENDSEC;');
  if (dataStart === -1 || dataEnd === -1 || dataEnd < dataStart) {
    throw new Error('Seed STEP file has no parsable DATA section.');
  }
  const header = seedText.slice(0, dataStart + '\nDATA;\n'.length);
  const data = seedText.slice(dataStart + '\nDATA;\n'.length, dataEnd);
  const footer = 'ENDSEC;\nEND-ISO-10303-21;\n';
  let maxId = 0;
  for (const match of data.matchAll(/#(\d+)/g)) {
    const id = Number(match[1]);
    if (id > maxId) {
      maxId = id;
    }
  }
  if (maxId === 0) {
    throw new Error('Seed DATA section contains no entity ids.');
  }
  return { header, data, footer, stride: maxId + 1 };
}

function renumberedCopy(data, offset) {
  // `#N` inside STEP strings (e.g. 'Context #1') gets shifted too; that only
  // changes a label's text, never the entity graph, and keeps this a plain
  // linear scan over an ~1 MB chunk.
  return data.replace(/#(\d+)/g, (_, id) => `#${Number(id) + offset}`);
}

function generateRung(seed, targetBytes, outPath) {
  if (fs.existsSync(outPath)) {
    const existing = fs.statSync(outPath).size;
    if (existing >= targetBytes * 0.97) {
      return { path: outPath, bytes: existing, cached: true };
    }
  }
  const { header, data, footer, stride } = seed;
  const copyBytes = Buffer.byteLength(data);
  const copies = Math.max(
    1,
    Math.ceil((targetBytes - header.length) / copyBytes)
  );
  const fd = fs.openSync(outPath, 'w');
  try {
    fs.writeSync(fd, header);
    for (let copy = 0; copy < copies; copy += 1) {
      fs.writeSync(fd, renumberedCopy(data, copy * stride));
    }
    fs.writeSync(fd, footer);
  } finally {
    fs.closeSync(fd);
  }
  return { path: outPath, bytes: fs.statSync(outPath).size, cached: false };
}

/* ------------------------------------------------------------------ */
/* Child: one cold-instance measurement                               */
/* ------------------------------------------------------------------ */

function runChild(filePath, withMesh) {
  const result = {
    file: filePath,
    fileBytes: fs.statSync(filePath).size,
    ok: false,
    solids: 0,
    importMs: null,
    wasmMemBaseBytes: null,
    wasmMemPeakBytes: null,
    budget: 'default',
    raisedBudgetError: null,
    error: null,
    mesh: null,
    rssBytes: null
  };

  // Capture the wasm linear memory: the node build instantiates at require
  // time and keeps the instance private, so intercept construction.
  const memories = [];
  const OriginalInstance = WebAssembly.Instance;
  WebAssembly.Instance = class extends OriginalInstance {
    constructor(module, imports) {
      super(module, imports);
      if (this.exports?.memory instanceof WebAssembly.Memory) {
        memories.push(this.exports.memory);
      }
    }
  };
  const require = createRequire(import.meta.url);
  let remus;
  let remusIo;
  try {
    remus = require(remusNodeEntry());
    remusIo = require(remusIoNodeEntry());
  } finally {
    WebAssembly.Instance = OriginalInstance;
  }
  const memory = memories[0] ?? null;
  const memBytes = () => memory?.buffer.byteLength ?? null;

  const bytes = fs.readFileSync(filePath);
  const kernel = new remus.BrepKernel();
  const io = new remusIo.RemusIo();
  const importStep = (...budget) =>
    kernel.deserializeSolids(io.importStep(bytes, ...budget));
  result.wasmMemBaseBytes = memBytes();

  let handles = null;
  const start = performance.now();
  try {
    handles = importStep();
  } catch (error) {
    result.error = String(error?.message ?? error);
    const panic = remus.lastPanicMessage?.();
    if (panic) {
      result.error += ` [panic: ${panic}]`;
      remus.clearLastPanicMessage?.();
    }
    // Learn whether the wasm API accepts budgets above the production
    // defaults (docs say "tighten", implying a clamp — verify it).
    try {
      handles = importStep(bytes.length, 100_000_000);
      result.budget = 'raised';
      result.error = null;
    } catch (retryError) {
      result.raisedBudgetError = String(retryError?.message ?? retryError);
      const retryPanic = remus.lastPanicMessage?.();
      if (retryPanic) {
        result.raisedBudgetError += ` [panic: ${retryPanic}]`;
        remus.clearLastPanicMessage?.();
      }
    }
  }
  result.importMs = Math.round(performance.now() - start);

  if (handles) {
    result.ok = true;
    result.solids = handles.length;
  }
  result.wasmMemPeakBytes = memBytes();

  if (result.ok && withMesh) {
    const meshStart = performance.now();
    let triangles = 0;
    let meshError = null;
    for (const solid of handles) {
      try {
        const mesh = kernel.tessellateSolidGroupedBinary(
          solid,
          MESH_LINEAR_DEFLECTION,
          MESH_ANGULAR_DEFLECTION
        );
        triangles += mesh.indices.length / 3;
        mesh.free?.();
      } catch (error) {
        meshError = String(error?.message ?? error);
        break;
      }
    }
    result.mesh = {
      ms: Math.round(performance.now() - meshStart),
      triangles,
      wasmMemPeakBytes: memBytes(),
      error: meshError
    };
  }

  result.rssBytes = process.memoryUsage().rss;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/* ------------------------------------------------------------------ */
/* Parent: ladder orchestration                                       */
/* ------------------------------------------------------------------ */

function formatMb(bytes) {
  return bytes == null ? '—' : `${(bytes / MiB).toFixed(1)} MB`;
}

function runLadder(args) {
  if (!fs.existsSync(REMUS_PACKAGE_JSON)) {
    throw new Error(
      `remus-wasm not installed at ${REMUS_PACKAGE_JSON} — run pnpm install first.`
    );
  }
  fs.mkdirSync(args.workdir, { recursive: true });
  const seedText = fs.readFileSync(args.seed, 'utf8');
  const seed = splitSeed(seedText);
  const seedStem = path.basename(args.seed).replace(/\.[^.]+$/, '');

  const results = [];
  for (const sizeMb of args.sizesMb) {
    const rungPath = path.join(args.workdir, `${seedStem}-${sizeMb}mb.step`);
    process.stderr.write(`\n[${sizeMb} MB] generating…`);
    const generated = generateRung(seed, sizeMb * MiB, rungPath);
    process.stderr.write(
      generated.cached ? ' (cached)' : ` ${formatMb(generated.bytes)}`
    );
    process.stderr.write(' importing…');
    const childArgs = [
      `--max-old-space-size=${CHILD_HEAP_MB}`,
      fileURLToPath(import.meta.url),
      '--child',
      generated.path
    ];
    if (args.mesh) {
      childArgs.push('--mesh');
    }
    const child = spawnSync(process.execPath, childArgs, {
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 64 * MiB
    });
    let parsed;
    const lastLine = child.stdout?.trim().split('\n').at(-1);
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      parsed = {
        file: generated.path,
        fileBytes: generated.bytes,
        ok: false,
        error:
          child.signal === 'SIGTERM'
            ? `timed out after ${CHILD_TIMEOUT_MS / 1000}s`
            : `child crashed (${child.signal ?? child.status}): ${
                (child.stderr ?? '').trim().split('\n').at(-1) ?? 'no output'
              }`
      };
    }
    parsed.sizeMb = sizeMb;
    results.push(parsed);
    process.stderr.write(
      parsed.ok
        ? ` ok: ${parsed.solids} solids, ${parsed.importMs} ms, peak wasm ${formatMb(parsed.wasmMemPeakBytes)}${parsed.budget === 'raised' ? ' (raised budget)' : ''}\n`
        : ` FAILED: ${parsed.error}\n`
    );
  }
  return results;
}

function printReport(results, withMesh) {
  const rows = [
    [
      'size',
      'result',
      'solids',
      'import',
      'wasm peak',
      ...(withMesh ? ['mesh', 'triangles'] : []),
      'note'
    ]
  ];
  for (const r of results) {
    rows.push([
      `${r.sizeMb} MB`,
      r.ok ? 'ok' : 'FAIL',
      r.ok ? String(r.solids) : '—',
      r.importMs != null && r.ok ? `${(r.importMs / 1000).toFixed(1)} s` : '—',
      formatMb(r.wasmMemPeakBytes),
      ...(withMesh
        ? [
            r.mesh ? `${(r.mesh.ms / 1000).toFixed(1)} s` : '—',
            r.mesh ? String(r.mesh.triangles) : '—'
          ]
        : []),
      r.ok
        ? r.budget === 'raised'
          ? 'needed raised budget'
          : ''
        : `${r.error ?? ''}${r.raisedBudgetError ? ` | raised-budget retry: ${r.raisedBudgetError}` : ''}`
    ]);
  }
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((row) => row[col].length))
  );
  process.stdout.write('\n');
  for (const [index, row] of rows.entries()) {
    process.stdout.write(
      `${row
        .map((cell, col) => cell.padEnd(widths[col]))
        .join('  ')
        .trimEnd()}\n`
    );
    if (index === 0) {
      process.stdout.write(
        `${widths.map((width) => '-'.repeat(width)).join('  ')}\n`
      );
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.child) {
  runChild(args.child, args.mesh);
} else {
  const results = runLadder(args);
  printReport(results, args.mesh);
  if (args.out) {
    fs.writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
    process.stderr.write(`\nResults written to ${args.out}\n`);
  }
}
