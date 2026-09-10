/**
 * Perf harness for the growing hammer holder (OpenZCAD PR #275).
 * Runs the real adapter pipeline (syncDocument) in node WASM and records
 * per-stage wall time plus per-kernel-method call counts and time, keyed by
 * the rebuild stage that issued the call.
 *
 * Env:
 *   OPENZCAD_HAMMER_STEP   private/in-repo source STEP (required)
 *   HAMMER_PERF_OUT        JSON report path
 *   HAMMER_PERF_WIDTHS     comma list, default 16.1,20,35,46,50,55,1000
 *   HAMMER_PERF_MODE       "warm" (one adapter, sequence + repeat + undo) | "cold" (fresh adapter per width) | "both"
 *   HAMMER_PERF_OPERANDS   dir; when set, exports operand arena bytes per width (no union)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { createExactKernelAdapter } from '../../packages/kernel-adapter/src/exact';
import { buildDocumentHistory } from '../../packages/kernel-adapter/src/exact-build-loop';
import { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import type { RebuildProgress } from '../../packages/kernel-adapter/src/rebuild-progress';
import { buildHammerDocument, precutEnds, setWidth } from './hammer-growing-document';

const sourcePath = process.env.OPENZCAD_HAMMER_STEP;
const outPath = process.env.HAMMER_PERF_OUT ?? '/tmp/hammer-perf.json';
const widths = (process.env.HAMMER_PERF_WIDTHS ?? '16.1,20,35,46,50,55,1000')
  .split(',')
  .map(Number);
const mode = process.env.HAMMER_PERF_MODE ?? 'warm';
const operandDir = process.env.HAMMER_PERF_OPERANDS;

// ---- kernel method instrumentation -------------------------------------
type Acc = Record<string, { calls: number; ms: number }>;
let currentStage = 'idle';
let stageAcc: Record<string, Acc> = {};
function resetAcc() {
  stageAcc = {};
}
function record(method: string, ms: number) {
  const acc = (stageAcc[currentStage] ??= {});
  const entry = (acc[method] ??= { calls: 0, ms: 0 });
  entry.calls += 1;
  entry.ms += ms;
}
let wrapped = false;
function wrapKernel() {
  if (wrapped) return;
  wrapped = true;
  const proto = RemusKernel.prototype as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor' || name === 'free' || name.startsWith('__')) continue;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.value !== 'function') continue;
    const original = desc.value as (...args: unknown[]) => unknown;
    proto[name] = function (this: unknown, ...args: unknown[]) {
      const t0 = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        record(name, performance.now() - t0);
      }
    };
  }
}

// ---- stage timing from the adapter's own reporter ----------------------
interface StageRow { stage: string; name: string; ms: number }
function progressRecorder(rows: StageRow[]) {
  return (p: RebuildProgress) => {
    if (p.status === 'started') {
      currentStage = `${p.stage}:${p.name}`;
    } else {
      rows.push({ stage: p.stage, name: p.name, ms: p.durationMs ?? 0 });
      currentStage = 'between-stages';
    }
  };
}

function summarize(acc: Record<string, Acc>) {
  // top methods overall
  const total: Acc = {};
  for (const stage of Object.values(acc)) {
    for (const [m, e] of Object.entries(stage)) {
      const t = (total[m] ??= { calls: 0, ms: 0 });
      t.calls += e.calls;
      t.ms += e.ms;
    }
  }
  const top = Object.entries(total)
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 25)
    .map(([m, e]) => ({ method: m, calls: e.calls, ms: Math.round(e.ms) }));
  const byStage = Object.fromEntries(
    Object.entries(acc).map(([stage, a]) => [
      stage,
      Object.entries(a)
        .sort((x, y) => y[1].ms - x[1].ms)
        .slice(0, 12)
        .map(([m, e]) => ({ method: m, calls: e.calls, ms: Math.round(e.ms) }))
    ])
  );
  return { top, byStage };
}

it.skipIf(!sourcePath)('profiles growing-holder rebuilds', async () => {
  wrapKernel();
  const { leftText, rightText } = await precutEnds(sourcePath!);
  const report: Record<string, unknown>[] = [];

  if (operandDir) {
    mkdirSync(operandDir, { recursive: true });
    for (const width of widths) {
      const built = buildHammerDocument(width, leftText, rightText, false);
      const kernel = new RemusKernel();
      try {
        const result = buildDocumentHistory(kernel, built.document);
        if (result.warnings.length) throw new Error(result.warnings.join('\n'));
        for (const [tag, bodyId] of [
          ['left', built.leftBodyId],
          ['bridge', built.bridgeBodyId],
          ['right', built.rightBodyId]
        ] as const) {
          const solid = result.shapes.get(bodyId)!.solids[0]!;
          writeFileSync(
            join(operandDir, `w${width}-${tag}.arena`),
            kernel.serializeSolid(solid)
          );
        }
      } finally {
        kernel.free();
      }
    }
  }

  const runSync = async (
    adapter: Awaited<ReturnType<typeof createExactKernelAdapter>>,
    document: ReturnType<typeof buildHammerDocument>['document'],
    holderBodyId: string,
    label: string,
    cacheEvents: unknown[]
  ) => {
    resetAcc();
    const rows: StageRow[] = [];
    const t0 = performance.now();
    const derived = await adapter.syncDocument(document, progressRecorder(rows));
    const total = performance.now() - t0;
    const holder = derived.bodyRepresentations[holderBodyId as never];
    const entry = {
      label,
      totalMs: Math.round(total),
      cacheEvent: cacheEvents.at(-1) ?? null,
      warnings: derived.warnings,
      holder: holder
        ? {
            faces: holder.faceCount,
            edges: holder.topology?.edges.length,
            triangles: holder.mesh.kind === 'mesh' ? holder.mesh.indices.length / 3 : null,
            volume: holder.volume,
            bbox: holder.bbox
          }
        : null,
      stages: rows.filter((r) => r.ms >= 1).map((r) => ({ ...r, ms: Math.round(r.ms) })),
      kernel: summarize(stageAcc)
    };
    report.push(entry);
    console.log(`[perf] ${label}: ${entry.totalMs} ms`, JSON.stringify(entry.cacheEvent));
    writeFileSync(outPath, JSON.stringify(report, null, 2));
  };

  if (mode === 'warm' || mode === 'both') {
    const cacheEvents: unknown[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (e) => cacheEvents.push(e)
    });
    const base = buildHammerDocument(46, leftText, rightText);
    const docs: Array<ReturnType<typeof buildHammerDocument>['document']> = [];
    let doc = base.document;
    await runSync(adapter, doc, base.holderBodyId!, 'warm-adapter cold sync w=46', cacheEvents);
    docs.push(doc);
    for (const width of widths) {
      doc = setWidth(doc, width);
      await runSync(adapter, doc, base.holderBodyId!, `warm change -> w=${width}`, cacheEvents);
      docs.push(doc);
    }
    // repeated change to the same value (no-op edit)
    await runSync(adapter, doc, base.holderBodyId!, `repeat same document w=${widths.at(-1)}`, cacheEvents);
    // undo: previous document object
    const undo = docs.at(-2)!;
    await runSync(adapter, undo, base.holderBodyId!, `undo -> w=${widths.at(-2)}`, cacheEvents);
    // redo
    await runSync(adapter, doc, base.holderBodyId!, `redo -> w=${widths.at(-1)}`, cacheEvents);
    adapter.dispose?.();
  }
  if (mode === 'cold' || mode === 'both') {
    for (const width of widths) {
      const cacheEvents: unknown[] = [];
      const adapter = await createExactKernelAdapter({
        onRebuildCacheEvent: (e) => cacheEvents.push(e)
      });
      const built = buildHammerDocument(width, leftText, rightText);
      await runSync(adapter, built.document, built.holderBodyId!, `cold w=${width}`, cacheEvents);
      adapter.dispose?.();
    }
  }
}, 7_200_000);
