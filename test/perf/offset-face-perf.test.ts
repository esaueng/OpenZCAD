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

const methodTotals = new Map<string, Tally>();
const callerTotals = new Map<string, Tally>();

function tally(map: Map<string, Tally>, key: string, elapsed: number) {
  const entry = map.get(key) ?? { time: 0, count: 0 };
  entry.time += elapsed;
  entry.count += 1;
  map.set(key, entry);
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
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          const elapsed = performance.now() - start;
          tally(methodTotals, name, elapsed);
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

function report(label: string, wall: number, stages: string[]): void {
  const methods = [...methodTotals.entries()].sort(
    (a, b) => b[1].time - a[1].time
  );
  const kernel = methods.reduce((sum, [, entry]) => sum + entry.time, 0);
  if (process.env.OFFSET_PERF_OUT) {
    appendFileSync(
      process.env.OFFSET_PERF_OUT,
      `${JSON.stringify({
        label,
        wallMs: wall,
        kernelMs: kernel,
        jsMs: wall - kernel,
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
  methodTotals.clear();
  callerTotals.clear();
}

/** Times one sync and prints its report. */
async function timedSync(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  label: string,
  stages: ReturnType<typeof stageRecorder>
): Promise<DerivedState> {
  methodTotals.clear();
  callerTotals.clear();
  stages.reset();
  const start = performance.now();
  const derived = await adapter.syncDocument(document, stages.listener);
  report(label, performance.now() - start, stages.lines());
  console.log(`warnings: ${JSON.stringify(derived.warnings)}`);
  return derived;
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
  methodTotals.clear();
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
    methodTotals.clear();
    callerTotals.clear();
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
      const manager = new CommandManager(
        createProjectDocument('Offset perf', toUserId('local_offset_perf'))
      );
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
      const bodyId = derived0.exportableBodyIds[0] as BodyId;
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
      const derived1 = await timedSync(
        adapter,
        edited,
        `offset ${offset} sync`,
        stages
      );
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
