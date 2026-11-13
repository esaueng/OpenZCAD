// Opt-in characterization of the geometry worker's per-edit cost on a
// multi-body document; no wall-clock thresholds. It replays the worker's
// broadcast path outside the browser: content key, result cache, exact sync
// with its early geometry-ready publication, both projection encodes and the
// main-thread receiver. Each scenario runs with owned (copied) and shared
// retained measurements on the same document and requires every publication
// the receiver holds to be identical between the two.
//
//   MULTI_BODY_PERF_RUN=1 pnpm exec vitest run --config test/perf/multi-body-sync.config.ts
//
// MULTI_BODY_PERF_SCENARIOS=curved30,boxes100 (default both),
// MULTI_BODY_PERF_SAMPLES (default 15) and MULTI_BODY_PERF_OUT (default
// artifacts/multi-body-sync) select the run.
import { it, expect } from 'vitest';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  toUserId,
  type DerivedState,
  type GeometryReadyState,
  type ProjectDocument
} from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  ProjectionReceiver,
  ProjectionSender
} from '../../apps/web/src/lib/projectionStream';
import {
  ExactRebuildCache,
  cloneDerivedSharingBodyGeometry,
  geometryContentKey
} from '../../apps/web/src/worker/exactRebuildCache';

type Scenario = 'curved30' | 'boxes100';
const scenarios = (process.env.MULTI_BODY_PERF_SCENARIOS ?? 'curved30,boxes100')
  .split(',')
  .filter((name): name is Scenario => ['curved30', 'boxes100'].includes(name));
const samples = Math.max(1, Number(process.env.MULTI_BODY_PERF_SAMPLES ?? 15));
const output = resolve(
  process.env.MULTI_BODY_PERF_OUT ?? 'artifacts/multi-body-sync'
);

const curvedKinds = ['cylinder', 'sphere', 'box', 'torus', 'cone'] as const;
function dimensions(kind: string, size: number) {
  switch (kind) {
    case 'cylinder':
      return { radius: size / 2, height: 20 };
    case 'sphere':
      return { radius: size / 2 };
    case 'torus':
      return { majorRadius: size, minorRadius: 2 };
    case 'cone':
      return { bottomRadius: size / 2, topRadius: 1, height: 15 };
    default:
      return { width: size, height: 20, depth: 10 };
  }
}

/** Independent bodies; each sample edits only the last one, to a new size. */
function scenario(name: Scenario) {
  const count = name === 'curved30' ? 30 : 100;
  let document = createProjectDocument(name, toUserId('multi_body_perf'));
  for (let index = 0; index < count; index += 1) {
    const kind =
      name === 'boxes100' ? 'box' : curvedKinds[index % curvedKinds.length]!;
    document = addPrimitiveFeature(document, {
      name: `${kind} ${index}`,
      primitiveKind: kind,
      dimensions: dimensions(kind, 10) as never
    });
    document = transformBody(document, {
      name: 'Place',
      targetBodyId: document.bodyOrder.at(-1)!,
      translation: {
        x: (index % 10) * 25,
        y: Math.floor(index / 10) * 25,
        z: 0
      }
    }).document;
  }
  const features = listFeaturesInOrder(document);
  let last = features[features.length - 1]!;
  for (const feature of features)
    if (feature.data.featureKind === 'primitive') last = feature;
  const kind =
    last.data.featureKind === 'primitive' ? last.data.primitiveKind : 'box';
  return {
    document,
    edit: (sample: number) =>
      updateFeature(document, {
        featureId: last.featureId,
        // Unique sizes: no sample is a whole-document cache hit.
        data: { dimensions: dimensions(kind, 11 + sample * 0.01) as never }
      })
  };
}

/** The receiver's view of a publication, timestamps and revisions aside. */
function held(state: DerivedState | GeometryReadyState): string {
  const { updatedAt: _updatedAt, ...rest } = state;
  const bodies = Object.fromEntries(
    Object.entries(rest.bodyRepresentations).map(([bodyId, body]) => {
      const { projectionRevision: _revision, mesh, ...metadata } = body;
      const bits = (values: Float32Array | Uint32Array) =>
        Array.from(
          new Uint32Array(values.buffer, values.byteOffset, values.length)
        ).join(',');
      return [
        bodyId,
        {
          ...metadata,
          vertices: bits(mesh.vertices),
          indices: bits(mesh.indices)
        }
      ];
    })
  );
  return JSON.stringify({ ...rest, bodyRepresentations: bodies });
}

async function run(
  share: boolean,
  document: ProjectDocument,
  edit: (sample: number) => ProjectDocument
) {
  const adapter = await createExactKernelAdapter(
    share ? { shareRetainedMeasurements: true } : {}
  );
  const sender = new ProjectionSender('multi-body-perf');
  const receiver = new ProjectionReceiver();
  const cache = new ExactRebuildCache<ProjectDocument['derived']>({
    maxEntries: 8,
    maxBytes: 32 * 1024 * 1024,
    maxInFlight: 4,
    ...(share ? { clone: cloneDerivedSharingBodyGeometry } : {})
  });
  const publications: string[] = [];
  let heldMs = 0;
  const keep = (state: DerivedState | GeometryReadyState | null) => {
    const started = performance.now();
    if (!state) throw new Error('The receiver rejected a publication.');
    publications.push(held(state));
    heldMs += performance.now() - started;
  };
  const sync = async (next: ProjectDocument) => {
    heldMs = 0;
    const started = performance.now();
    let ready: number | undefined;
    const derived = await cache.get(geometryContentKey(next), () =>
      adapter.syncDocument(next, undefined, undefined, undefined, {
        onGeometryReady: (geometry) => {
          const packet = sender.encode(next.projectId, geometry);
          ready = performance.now() - started;
          keep(receiver.apply(structuredClone(packet)));
        }
      })
    );
    const packet = sender.encode(next.projectId, derived);
    const total = performance.now() - started - heldMs;
    keep(receiver.apply(structuredClone(packet)));
    return { readyMs: ready ?? total, totalMs: total, derived };
  };
  try {
    const first = await sync(document);
    for (let sample = 0; sample < 4; sample += 1) await sync(edit(sample));
    const timings = [];
    for (let sample = 0; sample < samples; sample += 1)
      timings.push(await sync(edit(sample)));
    return { first: first.derived, timings, publications };
  } finally {
    adapter.dispose();
  }
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

it('records multi-body edit cost with owned and shared measurements', async () => {
  if (!process.env.MULTI_BODY_PERF_RUN) return;
  mkdirSync(output, { recursive: true });
  for (const name of scenarios) {
    const { document, edit } = scenario(name);
    const [owned, shared] = [
      await run(false, document, edit),
      await run(true, document, edit)
    ];
    expect(shared.publications).toHaveLength(owned.publications.length);
    shared.publications.forEach((publication, index) =>
      expect(
        publication === owned.publications[index],
        `publication ${index}`
      ).toBe(true)
    );
    const triangles = Object.values(owned.first.bodyRepresentations).reduce(
      (sum, body) => sum + body.mesh.indices.length / 3,
      0
    );
    for (const [mode, result] of [
      ['owned', owned],
      ['shared', shared]
    ] as const) {
      appendFileSync(
        resolve(output, 'summary.jsonl'),
        JSON.stringify({
          scenario: name,
          mode,
          bodies: Object.keys(result.first.bodyRepresentations).length,
          triangles,
          samples,
          readyMedianMs: median(result.timings.map((t) => t.readyMs)),
          totalMedianMs: median(result.timings.map((t) => t.totalMs)),
          node: process.version
        }) + '\n'
      );
    }
  }
}, 1_800_000);
