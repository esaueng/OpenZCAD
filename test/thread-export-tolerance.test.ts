import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  holeBody,
  listFeaturesInOrder,
  threadBody,
  updateFeature,
  type ThreadInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import { readThreeMfPackage } from '../packages/kernel-adapter/src/three-mf-package';
import {
  exportSolids,
  reimportSolids,
  type SolidExchangeFormat
} from './support/exchange-harness';

/**
 * A threaded part must export. A Printable M12×1.75 thread chamfered at both
 * ends, on a boss and in a tapped bore, once left edges whose stored
 * tolerance (about 2.3e-4 mm) exceeded the 1e-4 mm the kernel's own arena
 * reader accepts. Every export serializes the solids and re-reads them, so
 * every mesh format and STEP failed with "arena edge N has invalid
 * tolerance". Each format must now write a non-empty file.
 *
 * Issue #1625 reported the same failure for an ISO M12 thread 20 mm long on
 * a Ø12 boss, chamfered at the face's start and run out where it stops
 * short, at boss heights 28 and 32 mm. Remus #1806 (2026.1.145) keeps a
 * default thread's stored tolerances within the reader's cap.
 */

const FORMATS: SolidExchangeFormat[] = [
  '3mf',
  'stl-binary',
  'obj',
  'glb',
  'ply',
  'step'
];

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

/** Everything the build said but its print advice. */
function failures(derived: DerivedState): string {
  const advice = (derived.featureWarnings ?? [])
    .filter((warning) => warning.kind === 'advisory')
    .map((warning) => warning.message);
  return [
    ...derived.warnings.filter(
      (warning) => !advice.some((message) => warning.includes(message))
    ),
    ...(derived.featureWarnings ?? [])
      .filter((warning) => warning.kind !== 'advisory')
      .map((warning) => warning.message)
  ].join('\n');
}

function cylinderFace(derived: DerivedState, bodyId: BodyId) {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
    (face) => face.geometry?.surfaceType === 'cylinder'
  ).sort((a, b) => (a.geometry!.radius ?? 0) - (b.geometry!.radius ?? 0))[0]!;
}

function topFace(derived: DerivedState, bodyId: BodyId) {
  const body = derived.bodyRepresentations[bodyId]!;
  return body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      (face.geometry.normal?.z ?? 0) > 0.999 &&
      Math.abs(
        (face.geometry.centroid ?? face.geometry.center).z - body.bbox.max.z
      ) < 1e-6
  )!;
}

describe('exports of modeled threads', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  /** Threads the smallest cylindrical face of the last body and syncs it. */
  async function threaded(
    document: ProjectDocument,
    chamfered = true,
    fields: Partial<ThreadInput> = {
      profile: 'printable',
      chamferStart: chamfered,
      chamferEnd: chamfered
    }
  ) {
    const face = cylinderFace(
      await adapter.syncDocument(document),
      last(document)
    );
    const next = threadBody(document, {
      name: 'Thread',
      targetBodyId: last(document),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      profile: 'printable',
      clearance: 0.1,
      ...fields
    }).document;
    const derived = await adapter.syncDocument(next);
    expect(failures(derived)).toBe('');
    return { ...next, derived };
  }

  async function expectEveryFormatExports(document: ProjectDocument) {
    const bodyIds = [...document.derived.exportableBodyIds];
    expect(bodyIds).toEqual([last(document)]);
    // Every format is tried, so a failure names each one that broke.
    const failed: Partial<Record<SolidExchangeFormat, string>> = {};
    for (const format of FORMATS) {
      try {
        const bytes = await exportSolids(adapter, document, bodyIds, format);
        if (bytes.byteLength === 0) failed[format] = 'empty file';
      } catch (error) {
        failed[format] = error instanceof Error ? error.message : String(error);
      }
    }
    expect(failed).toEqual({});
  }

  it('exports an external M12 thread on a Ø12 × 28 boss', async () => {
    const boss = addPrimitiveFeature(
      createProjectDocument('Bolt', toUserId('user_thread_export')),
      {
        name: 'Boss',
        primitiveKind: 'cylinder',
        dimensions: { radius: 6, height: 28 }
      }
    );
    await expectEveryFormatExports(await threaded(boss));
  }, 300_000);

  it('exports a plain M24×3 thread on a Ø24 × 30 boss', async () => {
    const boss = addPrimitiveFeature(
      createProjectDocument('Bolt', toUserId('user_thread_export')),
      {
        name: 'Boss',
        primitiveKind: 'cylinder',
        dimensions: { radius: 12, height: 30 }
      }
    );
    await expectEveryFormatExports(await threaded(boss, false));
  }, 300_000);

  it('exports an internal M12 thread through a 30 × 18 × 24 block', async () => {
    const block = addPrimitiveFeature(
      createProjectDocument('Nut', toUserId('user_thread_export')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );
    const top = topFace(await adapter.syncDocument(block), last(block));
    const drilled = holeBody(block, {
      name: 'Tap drill',
      targetBodyId: last(block),
      faceHash: top.hash,
      ...(top.reference ? { faceReference: top.reference } : {}),
      style: 'simple',
      diameter: 10.2,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid'
    }).document;
    await expectEveryFormatExports(await threaded(drilled));
  }, 300_000);

  it('exports the ISO M12 thread of #1625 at boss heights 28 and 32', async () => {
    // The issue's recipe: Ø12 × 28 boss, ISO profile at the size the face
    // gives (M12 × 1.75), Print fit (0.1 mm), 20 mm long from the face's
    // start with both ends finished: a chamfer at the start, a runout where
    // the thread stops short of the far end. Then the boss is made 32 tall.
    const boss = addPrimitiveFeature(
      createProjectDocument('Bolt', toUserId('user_thread_export')),
      {
        name: 'Boss',
        primitiveKind: 'cylinder',
        dimensions: { radius: 6, height: 28 }
      }
    );
    const short = await threaded(boss, true, {
      profile: 'iso-metric',
      length: 20,
      chamferStart: true,
      runoutEnd: true
    });
    const cylinder = listFeaturesInOrder(short).find(
      (feature) => feature.name === 'Boss'
    )!;
    const edited = updateFeature(short, {
      featureId: cylinder.featureId,
      data: { dimensions: { radius: 6, height: 32 } }
    });
    const editedDerived = await adapter.syncDocument(edited);
    expect(failures(editedDerived)).toBe('');
    const tall = { ...edited, derived: editedDerived };

    for (const [document, height] of [
      [short, 28],
      [tall, 32]
    ] as const) {
      await expectEveryFormatExports(document);
      const bodyIds = [...document.derived.exportableBodyIds];
      const blank = Math.PI * 6 * 6 * height;
      // The exact file: one valid solid, in millimetres, the boss's size,
      // with the thread's grooves cut out of the blank cylinder.
      const step = await reimportSolids(
        'step',
        await exportSolids(adapter, document, bodyIds, 'step')
      );
      expect(step.bodyCount).toBe(1);
      expect(step.fileObjects).toBe(1);
      expect(step.watertight).toBe(true);
      expect(step.declaredUnits).toBe('mm');
      expect(step.bounds.min[2]).toBeCloseTo(0, 6);
      expect(step.bounds.max[2]).toBeCloseTo(height, 6);
      expect(step.bounds.max[0] - step.bounds.min[0]).toBeLessThan(12 + 1e-6);
      expect(step.bounds.max[0] - step.bounds.min[0]).toBeGreaterThan(11);
      // About 2π · 5.7 · 0.64 · 20 ≈ 460 mm³ leaves: the clearance plus
      // half the M12 thread depth, around the boss, over 20 mm.
      expect(step.volume).toBeLessThan(blank - 300);
      expect(step.volume).toBeGreaterThan(blank - 600);
      // The 3MF package: one object placed once, in millimetres. At the
      // default deflection the thread has more triangles than the app's own
      // mesh import reads back, so the same tessellation is measured through
      // binary STL: closed, and the same part as the exact file.
      const pack = await readThreeMfPackage(
        await exportSolids(adapter, document, bodyIds, '3mf')
      );
      expect(pack.unit.name).toBe('millimeter');
      expect(pack.meshObjectCount).toBe(1);
      expect(pack.placements).toHaveLength(1);
      const mesh = await reimportSolids(
        'stl-binary',
        await exportSolids(adapter, document, bodyIds, 'stl-binary')
      );
      expect(mesh.watertight).toBe(true);
      expect(mesh.bounds.min[2]).toBeCloseTo(0, 3);
      expect(mesh.bounds.max[2]).toBeCloseTo(height, 3);
      expect(Math.abs(mesh.volume - step.volume) / step.volume).toBeLessThan(
        0.01
      );
    }
  }, 600_000);
});
