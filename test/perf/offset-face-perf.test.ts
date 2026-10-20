/**
 * Kernel timing harness for one offset-face direct edit on an imported STEP
 * body. Not a regression test: it prints where the wall time of each
 * `syncDocument` goes, and it is skipped unless OFFSET_PERF_STEP is set, so
 * CI never runs it.
 *
 * It imports the file through the real exact adapter, plans an offset of one
 * +X planar face with the app's own planner, and times the cold import sync
 * and the edited sync. Each report lists:
 *
 * - wall, kernel and remaining JS time, and every `RemusKernel` method by
 *   total time and call count (each prototype method is wrapped in a timer);
 * - the adapter's own stage timings, from the `syncDocument` progress events;
 * - with OFFSET_PERF_TRACE=1, the calling frames of the expensive methods in
 *   `TRACED_METHODS`. Off by default: capturing a stack per call is noisy and
 *   inflates the methods it attributes.
 *
 * Environment:
 *
 *   OFFSET_PERF_STEP      STEP file to import. Required; the test skips without it.
 *   OFFSET_PERF_DISTANCE  Offset in document units (default -6).
 *   OFFSET_PERF_AREA      Offset the +X planar face whose area is nearest this;
 *                         default is the largest +X planar face.
 *   OFFSET_PERF_TRACE=1   Attribute traced kernel calls to their callers.
 *   OFFSET_PERF_KERNEL_PHASES=1  Drain opt-in kernel substage timings.
 *   OFFSET_PERF_PREVIEW=1 Time geometry-only previews where supported; legacy
 *                         builds use their complete-sync preview path.
 *   OFFSET_PERF_PREVIEW_TICKS  Warm previews after the first (default 3). Each
 *                         is source-relative, like a drag tick. Distances walk
 *                         0.2 apart away from the offset and back every 20
 *                         ticks, so long drags revisit values as real ones do.
 *                         With more than 3, a drag summary reports per-tick
 *                         wall/kernel quantiles, per-method medians and the
 *                         kernel's slot and linear-memory growth.
 *   OFFSET_PERF_DEFER_TOPOLOGY=1 Use the drag path with display faces and
 *                         deferred edge topology/recognition/output naming.
 *   OFFSET_PERF_BACKGROUND_BODIES  Unrelated box bodies created before the
 *                         import (default 0), to expose work that grows with
 *                         the document rather than with the edit.
 *   OFFSET_PERF_CALLS_OUT Optional JSONL of each report's ordered kernel calls,
 *                         consecutive repeats of a method merged into one
 *                         `{ method, count, ms }` run.
 *   OFFSET_PERF_BROADCAST=1  After the edited sync, time the app's follow-up
 *                         broadcast sync of the same document (empty lineage
 *                         demand).
 *   OFFSET_PERF_FULL=1    Also time a second edit from the same base and the
 *                         undo back to the import.
 *   OFFSET_PERF_SAMPLES  Alternating warm edits (default 0). A fresh exact
 *                         rebuild checks the final sample outside timed work.
 *   OFFSET_PERF_OUT      Optional JSONL timing output.
 *   REMUS_WASM_PKG, REMUS_WASM_IO_PKG
 *                         Run against a local Remus build instead of the
 *                         pinned packages (the `vitest.config.ts` overlay).
 *
 * Run against the pinned kernel:
 *
 *   OFFSET_PERF_STEP=/path/to/part.step \
 *     pnpm vitest run test/perf/offset-face-perf.test.ts --reporter=verbose
 *
 * Against a local kernel, after `cargo xtask wasm-build` in a Remus checkout:
 *
 *   REMUS_WASM_PKG=<remus>/crates/wasm/pkg \
 *   REMUS_WASM_IO_PKG=<remus>/crates/wasm-io/pkg \
 *   OFFSET_PERF_STEP=/path/to/part.step \
 *     pnpm vitest run test/perf/offset-face-perf.test.ts --reporter=verbose
 *
 * The public Remus fixture `crates/io/tests/data/shapr3d_hammer_holder.step`
 * (160 faces, 42 of them NURBS) is the body the 2026-10-04 offset-face
 * measurements used. Keep fixtures out of this repository.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { sanitizeStepHeaderPrivacy } from '@openzcad/io-step';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type FaceTopology,
  type GeometryReadyState,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type RebuildProgress
} from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { planFaceOffset } from '../../apps/web/src/lib/interaction/faceOffsetPlan';

const stepPath = process.env.OFFSET_PERF_STEP;
const offset = Number(process.env.OFFSET_PERF_DISTANCE ?? -6);
const targetArea =
  process.env.OFFSET_PERF_AREA === undefined
    ? undefined
    : Number(process.env.OFFSET_PERF_AREA);
const traceCallers = process.env.OFFSET_PERF_TRACE === '1';
const fullRun = process.env.OFFSET_PERF_FULL === '1';
const kernelPhases = process.env.OFFSET_PERF_KERNEL_PHASES === '1';
const previewTicks = Number(process.env.OFFSET_PERF_PREVIEW_TICKS ?? 3);
const backgroundBodies = Number(process.env.OFFSET_PERF_BACKGROUND_BODIES ?? 0);
const callsOut = process.env.OFFSET_PERF_CALLS_OUT;
let phaseProbe:
  | (RemusKernel & {
      setPerformanceTracing?: (enabled: boolean) => void;
      drainPerformanceTrace?: () => string;
    })
  | undefined;

/** Kernel methods whose callers OFFSET_PERF_TRACE=1 attributes. */
const TRACED_METHODS = new Set([
  'validateSolid',
  'validateSolidDetailed',
  'faceArea',
  'classifyPoint',
  'volume',
  'intersectDetailed',
  'recognizeFeatures',
  'solidEdgeRelations',
  'moveFacesJournaled',
  'tessellateSolidGroupedBinary',
  'edgeLength'
]);
/** Stack frames kept per attributed call, nearest first. */
const TRACE_DEPTH = 4;
const METHOD_ROWS = 30;
const CALLER_ROWS = 40;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface Tally {
  time: number;
  count: number;
}

interface CallRun {
  method: string;
  count: number;
  ms: number;
}

const methodTotals = new Map<string, Tally>();
const callerTotals = new Map<string, Tally>();
/** Ordered calls since the last report, repeats merged into runs. */
const callRuns: CallRun[] = [];
/** The adapter kernel that last restored or took a history checkpoint. */
let adapterKernel: RemusKernel | undefined;
/** Set while the harness itself queries the kernel, so it goes untallied. */
let untallied = false;

function tally(map: Map<string, Tally>, key: string, elapsed: number) {
  const entry = map.get(key) ?? { time: 0, count: 0 };
  entry.time += elapsed;
  entry.count += 1;
  map.set(key, entry);
}

function recordCall(method: string, elapsed: number) {
  const last = callRuns.at(-1);
  if (last?.method === method) {
    last.count += 1;
    last.ms += elapsed;
  } else {
    callRuns.push({ method, count: 1, ms: elapsed });
  }
}

function resetTallies() {
  methodTotals.clear();
  callerTotals.clear();
  callRuns.length = 0;
}

interface KernelMemory {
  allocatedSlots: number;
  retiredSlots: number;
  linearMemoryBytes: number;
  estimatedBytes: number;
  checkpoints: number;
}

/** The adapter kernel's accounted arena state, read outside any report. */
function kernelMemory(): KernelMemory | undefined {
  if (!adapterKernel) return undefined;
  untallied = true;
  try {
    return JSON.parse(adapterKernel.checkpointMemoryStats()) as KernelMemory;
  } finally {
    untallied = false;
  }
}

/** Nearest-rank percentile of an unsorted sample. */
function percentile(values: readonly number[], percent: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((sorted.length * percent) / 100) - 1)]!;
}

/** `name <- caller < caller ...`, with paths relative to the repository. */
function callerKey(name: string): string {
  const frames = (new Error().stack ?? '')
    .split('\n')
    // Error line, then this function and the timing wrapper.
    .slice(3, 3 + TRACE_DEPTH)
    .map((line) =>
      line
        .replace(/^\s+at\s+/, '')
        .replaceAll('file://', '')
        .replaceAll(REPO_ROOT, '')
        .replace(/\?[^:)]*/, '')
    );
  return `${name} <- ${frames.join(' < ')}`;
}

/**
 * Wraps every `RemusKernel` prototype method in a timer. Returns the undo.
 * Kernel calls are synchronous, so wall time inside the call is kernel time.
 */
function instrumentKernel(): () => void {
  if (kernelPhases) {
    phaseProbe = new RemusKernel();
    phaseProbe.setPerformanceTracing?.(true);
  }
  const proto = RemusKernel.prototype as unknown as Record<string, unknown>;
  const originals = new Map<string, PropertyDescriptor>();
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor' || name === 'free') continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || typeof descriptor.value !== 'function') continue;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    originals.set(name, descriptor);
    Object.defineProperty(proto, name, {
      ...descriptor,
      value(this: unknown, ...args: unknown[]) {
        if (untallied) return original.apply(this, args);
        // The adapter can also run short-lived kernels; the one that keeps
        // the history checkpoints is the session whose arena a drag grows.
        if (name === 'restore' || name === 'checkpoint') {
          adapterKernel = this as RemusKernel;
        }
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          const elapsed = performance.now() - start;
          tally(methodTotals, name, elapsed);
          recordCall(name, elapsed);
          if (traceCallers && TRACED_METHODS.has(name)) {
            tally(callerTotals, callerKey(name), elapsed);
          }
        }
      }
    });
  }
  return () => {
    for (const [name, descriptor] of originals) {
      Object.defineProperty(proto, name, descriptor);
    }
    phaseProbe?.setPerformanceTracing?.(false);
    phaseProbe?.free();
    phaseProbe = undefined;
    adapterKernel = undefined;
  };
}

/** Collects the adapter's completed stages for one sync. */
function stageRecorder() {
  const stages: { at: number; progress: RebuildProgress }[] = [];
  let origin = performance.now();
  return {
    listener: (progress: RebuildProgress) => {
      if (progress.status === 'completed') {
        stages.push({ at: performance.now() - origin, progress });
      }
    },
    reset() {
      stages.length = 0;
      origin = performance.now();
    },
    lines(): string[] {
      return stages.map(({ at, progress }) => {
        // `index` is already one-based ("feature 2 of 2").
        const position =
          progress.total > 0 ? ` ${progress.index}/${progress.total}` : '';
        const duration = (progress.durationMs ?? 0).toFixed(1);
        return `${at.toFixed(0).padStart(7)} ms  ${progress.stage}${position} ${progress.name}: ${duration} ms`;
      });
    }
  };
}

interface Report {
  wall: number;
  kernel: number;
  methods: Map<string, Tally>;
}

function report(
  label: string,
  wall: number,
  stages: string[],
  geometryReadyMs: number | null,
  derived: DerivedState | GeometryReadyState
): Report {
  const methods = [...methodTotals.entries()].sort(
    (a, b) => b[1].time - a[1].time
  );
  const kernel = methods.reduce((sum, [, entry]) => sum + entry.time, 0);
  if (callsOut) {
    appendFileSync(
      callsOut,
      `${JSON.stringify({ label, wallMs: wall, kernelMs: kernel, calls: callRuns })}\n`
    );
  }
  if (process.env.OFFSET_PERF_OUT) {
    appendFileSync(
      process.env.OFFSET_PERF_OUT,
      `${JSON.stringify({
        label,
        wallMs: wall,
        geometryReadyMs,
        kernelMs: kernel,
        jsMs: wall - kernel,
        warnings: derived.warnings,
        bodies: Object.values(derived.bodyRepresentations).map((body) => ({
          volume: 'volume' in body ? body.volume : null,
          bbox: body.bbox,
          faces: body.topology?.faces.length,
          vertices: body.mesh.vertices.length / 3,
          triangles: body.mesh.indices.length / 3
        })),
        methods: Object.fromEntries(methods),
        stages
      })}\n`
    );
  }
  const lines = [
    `=== ${label}: wall ${wall.toFixed(0)} ms, kernel ${kernel.toFixed(0)} ms, JS ${(wall - kernel).toFixed(0)} ms ===`,
    ...methods
      .slice(0, METHOD_ROWS)
      .map(
        ([name, { time, count }]) =>
          `${name.padEnd(40)} ${time.toFixed(1).padStart(9)} ms  x${count}`
      ),
    '--- adapter stages (completed, ms since sync start) ---',
    ...stages
  ];
  if (traceCallers) {
    lines.push(
      '--- callers of traced methods ---',
      ...[...callerTotals.entries()]
        .sort((a, b) => b[1].time - a[1].time)
        .slice(0, CALLER_ROWS)
        .map(
          ([key, { time, count }]) =>
            `${time.toFixed(0).padStart(7)} ms x${String(count).padEnd(5)} ${key}`
        )
    );
  }
  console.log(`\n${lines.join('\n')}`);
  const result = { wall, kernel, methods: new Map(methods) };
  resetTallies();
  return result;
}

/** Times one sync and prints its report. */
async function timedSync(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  label: string,
  stages: ReturnType<typeof stageRecorder>,
  lineageDemand?: readonly BodyId[]
): Promise<DerivedState> {
  resetTallies();
  stages.reset();
  const start = performance.now();
  let geometryReadyMs: number | null = null;
  const derived = await adapter.syncDocument(
    document,
    stages.listener,
    undefined,
    undefined,
    {
      ...(lineageDemand ? { lineageDemand } : {}),
      onGeometryReady: (geometry) => {
        geometryReadyMs = performance.now() - start;
        console.log(
          `geometry ready ${label}: ${(performance.now() - start).toFixed(1)} ms`
        );
        expect(
          Object.values(geometry.bodyRepresentations).every(
            (body) => !('volume' in body)
          )
        ).toBe(true);
      }
    }
  );
  report(
    label,
    performance.now() - start,
    stages.lines(),
    geometryReadyMs,
    derived
  );
  console.log(`warnings: ${JSON.stringify(derived.warnings)}`);
  if (phaseProbe?.drainPerformanceTrace) {
    const phases = JSON.parse(phaseProbe.drainPerformanceTrace()) as {
      name: string;
      duration_ms: number;
    }[];
    const totals = new Map<string, { time: number; count: number }>();
    for (const phase of phases) tally(totals, phase.name, phase.duration_ms);
    console.log(
      `--- kernel substages ${label} (inclusive) ---\n${[...totals]
        .sort((a, b) => b[1].time - a[1].time)
        .map(
          ([name, value]) =>
            `${name}: ${value.time.toFixed(1)} ms x${value.count}`
        )
        .join('\n')}`
    );
  }
  return derived;
}

/** Match the app's preview API; older baselines used a complete sync. */
async function timedFacePreview(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  label: string,
  stages: ReturnType<typeof stageRecorder>,
  allowRefusal = false
): Promise<Report & { refused: boolean }> {
  resetTallies();
  stages.reset();
  const start = performance.now();
  const result =
    typeof adapter.previewGeometry === 'function'
      ? await adapter.previewGeometry(document, {
          deferTopology: process.env.OFFSET_PERF_DEFER_TOPOLOGY === '1'
        })
      : await adapter.syncDocument(document, stages.listener);
  const elapsed = performance.now() - start;
  const timing = report(label, elapsed, stages.lines(), elapsed, result);
  // A drag keeps the last accepted shape through kernel refusals, so warm
  // ticks record them instead of failing.
  if (!allowRefusal) expect(result.warnings).toEqual([]);
  return { ...timing, refused: result.warnings.length > 0 };
}

/** Per-tick quantiles of a drag, and the kernel's arena growth across it. */
function summarizeDrag(
  ticks: readonly (Report & { refused: boolean })[],
  before: KernelMemory | undefined,
  after: KernelMemory | undefined
): void {
  // Refused ticks skip display work, so they are summarized apart from the
  // accepted ones rather than pulling their quantiles down.
  const accepted = ticks.filter((tick) => !tick.refused);
  const refused = ticks.filter((tick) => tick.refused);
  const quantiles = (values: readonly number[]) =>
    values.length === 0
      ? null
      : {
          p50: percentile(values, 50),
          p95: percentile(values, 95),
          max: Math.max(...values)
        };
  const names = new Set(accepted.flatMap((tick) => [...tick.methods.keys()]));
  const methods = [...names]
    .map((name) => {
      const per = accepted.map((tick) => tick.methods.get(name));
      return {
        name,
        p50: percentile(
          per.map((entry) => entry?.time ?? 0),
          50
        ),
        calls: percentile(
          per.map((entry) => entry?.count ?? 0),
          50
        )
      };
    })
    .sort((a, b) => b.p50 - a.p50);
  const summary = {
    label: 'drag summary',
    ticks: ticks.length,
    refused: refused.length,
    wallMs: quantiles(accepted.map((tick) => tick.wall)),
    kernelMs: quantiles(accepted.map((tick) => tick.kernel)),
    refusedWallMs: quantiles(refused.map((tick) => tick.wall)),
    methodsP50: methods,
    memoryBefore: before,
    memoryAfter: after
  };
  if (process.env.OFFSET_PERF_OUT) {
    appendFileSync(process.env.OFFSET_PERF_OUT, `${JSON.stringify(summary)}\n`);
  }
  const line = (label: string, value: ReturnType<typeof quantiles>): string =>
    value
      ? `${label} p50 ${value.p50.toFixed(1)}  p95 ${value.p95.toFixed(1)}  max ${value.max.toFixed(1)} ms`
      : `${label} none`;
  const growth = (key: keyof KernelMemory) =>
    before && after ? `${before[key]} -> ${after[key]}` : 'n/a';
  console.log(
    [
      `\n=== drag summary: ${accepted.length} accepted, ${refused.length} refused warm ticks ===`,
      line('accepted wall  ', summary.wallMs),
      line('accepted kernel', summary.kernelMs),
      line('refused wall   ', summary.refusedWallMs),
      `allocated slots ${growth('allocatedSlots')}, retired slots ${growth('retiredSlots')}, linear memory ${growth('linearMemoryBytes')} bytes`,
      '--- accepted per-tick method medians ---',
      ...methods
        .slice(0, METHOD_ROWS)
        .map(
          ({ name, p50, calls }) =>
            `${name.padEnd(40)} ${p50.toFixed(1).padStart(9)} ms  x${calls}`
        )
    ].join('\n')
  );
}

/** Distance of warm tick `index`: away from `offset` and back every 20. */
function dragDistance(index: number): number {
  const phase = (index + 1) % 20;
  return offset - 0.2 * (phase <= 10 ? phase : 20 - phase);
}

/** The +X planar face nearest `area` in area, else the largest. */
function pickFace(faces: readonly FaceTopology[]): FaceTopology | undefined {
  const candidates = faces
    .filter(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.x ?? 0) > 0.99
    )
    .map((face) => ({ face, area: face.geometry?.area ?? 0 }));
  candidates.sort((a, b) =>
    targetArea === undefined
      ? b.area - a.area
      : Math.abs(a.area - targetArea) - Math.abs(b.area - targetArea)
  );
  for (const { face, area } of candidates.slice(0, 5)) {
    console.log(`+X plane face ${face.topologyId} area ${area.toFixed(3)}`);
  }
  return candidates[0]?.face;
}

it('records SDK calls made by the selected exact adapter', async () => {
  const restoreKernel = instrumentKernel();
  let adapter: ExactKernelAdapter | undefined;
  resetTallies();
  try {
    adapter = await createExactKernelAdapter();
    const document = addPrimitiveFeature(
      createProjectDocument('Probe ownership', toUserId('probe_owner')),
      {
        name: 'Probe box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 8, depth: 6 }
      }
    );
    const derived = await adapter.syncDocument(document);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(1);
    expect(methodTotals.get('makeBox')?.count).toBeGreaterThan(0);
    expect(methodTotals.get('volume')?.count).toBeGreaterThan(0);
  } finally {
    adapter?.dispose();
    restoreKernel();
    resetTallies();
  }
});

it.skipIf(!stepPath)(
  'times one offset-face direct edit on an imported STEP body',
  async () => {
    const restoreKernel = instrumentKernel();
    let adapter: ExactKernelAdapter | undefined;
    try {
      adapter = await createExactKernelAdapter();
      const stages = stageRecorder();
      let initial = createProjectDocument(
        'Offset perf',
        toUserId('local_offset_perf')
      );
      for (let index = 0; index < backgroundBodies; index++) {
        initial = addPrimitiveFeature(initial, {
          name: `Background box ${index + 1}`,
          primitiveKind: 'box',
          dimensions: { width: 10, height: 8, depth: 6 }
        });
      }
      const manager = new CommandManager(initial);
      const sourceName = 'offset-perf.step';
      manager.execute(
        commandFactories.importStep({
          name: 'Offset perf source',
          artifactId: 'offset_perf_source',
          sourceName,
          stepText: sanitizeStepHeaderPrivacy(
            readFileSync(stepPath!, 'utf8'),
            sourceName
          )
        })
      );
      const imported = manager.document;

      const derived0 = await timedSync(
        adapter,
        imported,
        'cold import sync',
        stages
      );
      expect(derived0.warnings).toEqual([]);
      // The edited body is the one the import added, not a background box.
      const background = new Set<BodyId>(initial.bodyOrder);
      const bodyId = derived0.exportableBodyIds.find(
        (id) => !background.has(id)
      ) as BodyId;
      const body0 = derived0.bodyRepresentations[bodyId]!;
      const faces = body0.topology?.faces ?? [];
      const bspline = faces.filter(
        (face) => face.geometry?.surfaceType === 'bspline'
      ).length;
      const pairs = body0.topology?.opposingPlanarFacePairs?.length ?? 0;
      console.log(
        `body volume ${body0.volume} faces ${faces.length} (bspline ${bspline}), proven planar face pairs ${pairs}`
      );

      const face = pickFace(faces);
      expect(face).toBeDefined();
      const base: ProjectDocument = { ...imported, derived: derived0 };
      const planAt = (distance: number) =>
        planFaceOffset({
          document: base,
          bodyId,
          face: face!,
          faceHash: face!.hash,
          offset: distance
        });
      const plan = planAt(offset);
      expect(plan?.kind).toBe('direct-edit');

      const edited = new CommandManager(base).runTransaction('Offset', [
        plan!.command
      ]);
      if (process.env.OFFSET_PERF_PREVIEW === '1') {
        await timedFacePreview(adapter, edited, 'first face preview', stages);
        const memoryBefore = kernelMemory();
        const ticks: (Report & { refused: boolean })[] = [];
        for (let index = 0; index < previewTicks; index++) {
          const previewPlan = planAt(dragDistance(index));
          expect(previewPlan?.kind).toBe('direct-edit');
          ticks.push(
            await timedFacePreview(
              adapter,
              new CommandManager(base).runTransaction('Offset', [
                previewPlan!.command
              ]),
              `warm face preview ${index + 1}`,
              stages,
              previewTicks > 3
            )
          );
        }
        if (previewTicks > 3) {
          summarizeDrag(ticks, memoryBefore, kernelMemory());
        }
      }
      const derived1 = await timedSync(
        adapter,
        edited,
        `offset ${offset} sync`,
        stages
      );
      if (process.env.OFFSET_PERF_BROADCAST === '1') {
        // The app commits with a full-lineage sync, then the new document
        // version triggers a broadcast sync that carries a lineage demand.
        await timedSync(
          adapter,
          edited,
          `offset ${offset} broadcast sync`,
          stages,
          []
        );
      }
      const body1 = derived1.bodyRepresentations[bodyId]!;
      let lastDocument = edited;
      let lastDerived = derived1;
      console.log(
        `body volume ${body1.volume} (delta ${body1.volume - body0.volume}) faces ${body1.topology?.faces.length}`
      );

      if (fullRun) {
        const second = planAt(offset - 1);
        expect(second?.kind).toBe('direct-edit');
        await timedSync(
          adapter,
          new CommandManager(base).runTransaction('Offset', [second!.command]),
          `offset ${offset - 1} sync (second edit)`,
          stages
        );
        await timedSync(adapter, imported, 'undo to import sync', stages);
      }
      // Opt-in repeated edits use the same exact fixture and pinned WASM. No
      // display deflection, validation, tolerance or volume shortcut is applied.
      for (
        let index = 0;
        index < Number(process.env.OFFSET_PERF_SAMPLES ?? 0);
        index++
      ) {
        const distance = offset - (index % 2);
        const next = planAt(distance);
        expect(next?.kind).toBe('direct-edit');
        const document = new CommandManager(base).runTransaction('Offset', [
          next!.command
        ]);
        const result = await timedSync(
          adapter,
          document,
          `warm offset sample ${index + 1}`,
          stages
        );
        expect(result.warnings).toEqual([]);
        const actual = result.bodyRepresentations[bodyId]!;
        expect(actual.topology?.faces.length).toBe(
          body1.topology?.faces.length
        );
        expect(actual.volume).toBeGreaterThan(0);
        lastDocument = document;
        lastDerived = result;
      }
      if (Number(process.env.OFFSET_PERF_SAMPLES ?? 0) > 0) {
        const fresh = await createExactKernelAdapter({
          historyCheckpointLimit: 0
        });
        try {
          const reference = await fresh.syncDocument(lastDocument);
          expect(reference.warnings).toEqual(lastDerived.warnings);
          const actual = lastDerived.bodyRepresentations[bodyId]!;
          const expected = reference.bodyRepresentations[bodyId]!;
          if (process.env.OFFSET_PERF_PARITY_OUT) {
            writeFileSync(
              process.env.OFFSET_PERF_PARITY_OUT,
              JSON.stringify({ actual, expected })
            );
          }
          expect(actual.volume).toBeCloseTo(expected.volume, 6);
          expect(actual.bbox).toEqual(expected.bbox);
          // Display tessellation holds the previous body's deflection during
          // small edits. A fresh adapter selects it from the new bounds, so
          // triangle ranges can differ even on the unchanged baseline. Compare
          // every exact topology field, and exports at one explicit accuracy.
          const exactTopology = (body: typeof actual) => ({
            ...body.topology,
            faces: body.topology?.faces.map(
              ({ triangleStart: _start, triangleCount: _count, ...face }) =>
                face
            )
          });
          expect(exactTopology(actual)).toEqual(exactTopology(expected));
          for (const body of [actual, expected]) {
            expect(body.mesh.vertices.every(Number.isFinite)).toBe(true);
            expect(
              body.mesh.indices.every(
                (index) =>
                  Number.isInteger(index) &&
                  index < body.mesh.vertices.length / 3
              )
            ).toBe(true);
            expect(
              body.topology?.faces.reduce(
                (sum, face) => sum + face.triangleCount,
                0
              )
            ).toBe(body.mesh.indices.length / 3);
          }
          const stepData = (text: string) => text.slice(text.indexOf('DATA;'));
          expect(
            stepData(await adapter.exportStep(lastDocument, [bodyId]))
          ).toBe(stepData(await fresh.exportStep(lastDocument, [bodyId])));
          expect(await adapter.exportStl(lastDocument, [bodyId], 0.08)).toBe(
            await fresh.exportStl(lastDocument, [bodyId], 0.08)
          );
          console.log(
            'fresh exact parity: topology, STEP data and fixed-deflection STL identical'
          );
        } finally {
          fresh.dispose();
        }
      }
    } finally {
      adapter?.dispose();
      restoreKernel();
    }
  },
  900_000
);
