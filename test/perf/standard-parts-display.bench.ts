/**
 * M17 simplified thread display: what about 100 fasteners cost, modeled
 * against simplified (ROADMAP M17, budgets H02/W01). Not part of CI's
 * suites: run deliberately, on a quiet machine:
 *
 *   FASTENER_PERF_RUN=1 pnpm exec vitest run \
 *     --config test/perf/standard-parts-display.config.ts
 *
 * Each sample opens a fresh exact adapter and syncs a box beside the
 * fastener grid (`test/support/fastener-grid.ts`), as a reload builds it
 * (cold), then edits the box's width, as the W01 browser probe does (warm):
 * the box stands first in History, so every fastener after it is either
 * rebuilt or reused.
 * It records both times, the display triangles and mesh bytes the scene
 * hands the viewer, and the replay counts of the warm edit.
 *
 * Environment:
 * - FASTENER_PERF_COUNT: fasteners, default 100.
 * - FASTENER_PERF_THREADS: `modeled,simplified` (default) or either one.
 * - FASTENER_PERF_SAMPLES: rounds, default 3 (modes interleave per round).
 * - FASTENER_PERF_OUT: JSONL file to append each sample to.
 * - FASTENER_PERF_PROFILE: a `.cpuprofile` path to keep the last warm
 *   edit's CPU profile in.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type DerivedState,
  type StandardPartThread
} from '@openzcad/shared';
import { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { addFastenerGrid } from '../support/fastener-grid';
import { hostSnapshot } from '../../scripts/perf-host.mjs';

const run = process.env.FASTENER_PERF_RUN === '1';
const count = Math.max(1, Number(process.env.FASTENER_PERF_COUNT ?? 100));
const modes = (process.env.FASTENER_PERF_THREADS ?? 'modeled,simplified')
  .split(',')
  .map((mode) => mode.trim() as StandardPartThread);
const samples = Math.max(1, Number(process.env.FASTENER_PERF_SAMPLES ?? 3));
const out = process.env.FASTENER_PERF_OUT;
const profilePath = process.env.FASTENER_PERF_PROFILE;

const kernelCalls = new Map<string, { ms: number; calls: number }>();

/** Times every synchronous `RemusKernel` method. Returns the undo. */
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
          const tally = kernelCalls.get(name) ?? { ms: 0, calls: 0 };
          tally.ms += performance.now() - start;
          tally.calls += 1;
          kernelCalls.set(name, tally);
        }
      }
    });
  }
  return () => {
    for (const [name, descriptor] of originals)
      Object.defineProperty(proto, name, descriptor);
  };
}

/** The kernel methods that took longest since the last clear. */
function kernelTop(limit = 8) {
  return [...kernelCalls.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, limit)
    .map(([method, { ms, calls }]) => ({
      method,
      ms: Number(ms.toFixed(1)),
      calls
    }));
}

/**
 * What the scene hands the viewer: display triangles, mesh bytes, and the
 * topology a sync result carries beside them (faces, edges and their
 * polylines), as JSON bytes, with its face and edge counts.
 */
function sceneSize(derived: DerivedState) {
  let triangles = 0;
  let bytes = 0;
  let topologyBytes = 0;
  let faces = 0;
  let edges = 0;
  for (const body of Object.values(derived.bodyRepresentations)) {
    const mesh = body.mesh;
    if (mesh) {
      triangles += mesh.indices.length / 3;
      bytes += mesh.vertices.byteLength + mesh.indices.byteLength;
    }
    if (body.topology) {
      topologyBytes += JSON.stringify(body.topology).length;
      faces += body.topology.faces.length;
      edges += body.topology.edges?.length ?? 0;
    }
  }
  return { triangles, bytes, topologyBytes, faces, edges };
}

it.skipIf(!run)(
  `times ${count} standard fasteners, modeled against simplified`,
  { timeout: 3_600_000 },
  async () => {
    const restore = instrumentKernel();
    const results: Record<string, { coldMs: number[]; editMs: number[] }> = {};
    for (let round = 0; round < samples; round += 1) {
      for (const thread of modes) {
        const hostBefore = hostSnapshot();
        const events: RebuildCacheEvent[] = [];
        // As the browser's geometry worker makes it.
        const adapter = await createExactKernelAdapter({
          shareRetainedMeasurements: true,
          onRebuildCacheEvent: (event) => events.push(event)
        });
        try {
          // The edited box first and the fasteners after it in History,
          // as the browser probe's project stands.
          const document = addFastenerGrid(
            addPrimitiveFeature(
              createProjectDocument('Fasteners', toUserId('user_e2e')),
              {
                name: 'Box 0',
                primitiveKind: 'box',
                dimensions: { width: 30, height: 18, depth: 24 }
              }
            ),
            count,
            thread
          );
          kernelCalls.clear();
          let started = performance.now();
          const cold = await adapter.syncDocument(document);
          const coldMs = performance.now() - started;
          const coldKernel = kernelTop();
          const scene = sceneSize(cold);

          const box = listFeaturesInOrder(document)[0]!;
          const widened = (width: number) =>
            commandFactories
              .updateFeature({
                featureId: box.featureId,
                data: {
                  featureKind: 'primitive',
                  dimensions: { width, height: 18, depth: 24 }
                }
              })
              .apply(document);
          // The first edit settles what a cold build leaves to its first
          // reuse; the second is timed, as every later one runs.
          started = performance.now();
          await adapter.syncDocument(widened(31));
          const firstEditMs = performance.now() - started;
          const edited = widened(32);
          events.length = 0;
          kernelCalls.clear();
          const session = profilePath ? new Session() : undefined;
          if (session) {
            session.connect();
            await session.post('Profiler.enable');
            await session.post('Profiler.setSamplingInterval', {
              interval: 100
            });
            await session.post('Profiler.start');
          }
          started = performance.now();
          const warm = await adapter.syncDocument(edited);
          const editMs = performance.now() - started;
          if (session) {
            const { profile } = await session.post('Profiler.stop');
            writeFileSync(profilePath!, JSON.stringify(profile));
            session.disconnect();
          }
          const editKernel = kernelTop();
          const editCache = events.at(-1);

          const sample = {
            probe: 'standard-parts-display',
            recordedAt: new Date().toISOString(),
            round,
            thread,
            fasteners: count,
            coldMs,
            firstEditMs,
            editMs,
            triangles: scene.triangles,
            meshBytes: scene.bytes,
            topologyBytes: scene.topologyBytes,
            faces: scene.faces,
            edges: scene.edges,
            trianglesPerFastener: scene.triangles / count,
            editCache,
            coldKernel,
            editKernel,
            warnings: cold.warnings.length + warm.warnings.length,
            host: { before: hostBefore, after: hostSnapshot() },
            node: process.version
          };
          if (out) {
            mkdirSync(dirname(out), { recursive: true });
            appendFileSync(out, `${JSON.stringify(sample)}\n`);
          }
          console.log(
            `[standard-parts-display] ${thread} round ${round}: cold ${coldMs.toFixed(0)} ms, ` +
              `edit ${editMs.toFixed(0)} ms, ${scene.triangles} triangles ` +
              `(${(scene.bytes / 2 ** 20).toFixed(1)} MiB), load ${hostBefore.loadAverage1m.toFixed(2)}`
          );
          expect(cold.warnings).toEqual([]);
          expect(warm.warnings).toEqual([]);
          (results[thread] ??= { coldMs: [], editMs: [] }).coldMs.push(coldMs);
          results[thread].editMs.push(editMs);
        } finally {
          adapter.dispose();
        }
      }
    }
    restore();
    const median = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    console.log(
      '[standard-parts-display] medians',
      JSON.stringify(
        Object.fromEntries(
          Object.entries(results).map(([thread, { coldMs, editMs }]) => [
            thread,
            { coldMs: median(coldMs), editMs: median(editMs) }
          ])
        )
      )
    );
  }
);
