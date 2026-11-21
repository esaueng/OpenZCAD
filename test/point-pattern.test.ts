import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  deleteSketchObject,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  patternBody,
  updateFeature,
  updateSketchObject,
  type PatternInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { PointPatternMeshWorker } from '../packages/kernel-adapter/src/point-pattern-mesh-worker';
import { patternCutPrefix } from '../packages/kernel-adapter/src/exact-pattern-cut-prefix';
import * as cancellation from '../packages/kernel-adapter/src/exact-cancellation';
import * as cylinderOps from '../packages/kernel-adapter/src/exact-cylinder-ops';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureId,
  type ProjectDocument,
  type SketchId
} from '@openzcad/shared';

/**
 * M02 patterns driven by sketch points (schema v63): one copy at each picked
 * I01 point entity, moved there from the point the original stands on. Every
 * expectation is a closed form on a 100 × 40 × 10 plate or 10 mm blocks.
 */

const PLATE = { x: 100, y: 40, z: 10 };
const PLATE_VOLUME = PLATE.x * PLATE.y * PLATE.z;
const HOLE_R = 3;
const HOLE_VOLUME = Math.PI * HOLE_R ** 2 * PLATE.z;

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;

function box(
  name: string,
  size: { x: number; y: number; z: number }
): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_m02')),
    {
      name,
      primitiveKind: 'box',
      dimensions: { width: size.x, height: size.y, depth: size.z }
    }
  );
}

/** A sketch of points on XY at `z`, and their ids in drawing order. */
function pointsSketch(
  document: ProjectDocument,
  z: number,
  points: readonly [number, number][]
): { document: ProjectDocument; sketchId: SketchId; ids: string[] } {
  const sketched = addSketchFeature(document, {
    name: 'Points',
    planeRef: { type: 'canonical', plane: 'XY', offset: z },
    objects: points.map(([x, y]) => ({ objectKind: 'point' as const, x, y }))
  });
  const sketch = findSketch(sketched.document, sketched.sketchId)!;
  return {
    document: sketched.document,
    sketchId: sketched.sketchId,
    ids: sketch.objectIds.map(String)
  };
}

function onPoints(
  document: ProjectDocument,
  sketchId: SketchId,
  ids: string[],
  extra: Partial<PatternInput> = {}
): ProjectDocument {
  return patternBody(document, {
    name: 'On points',
    targetBodyId: last(document),
    patternKind: 'points',
    count: ids.length,
    axis: 'x',
    points: { sketchId, pointIds: ids, referencePointId: ids[0]! },
    ...extra
  }).document;
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

/** World (x, y) of every Ø6 bore, sorted. */
function bores(derived: DerivedState, bodyId: BodyId): [number, number][] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs(face.geometry.area - 2 * Math.PI * HOLE_R * PLATE.z) < 1e-6
  )
    .map((face) => {
      // On the bore's axis: its centre is a mean of rim vertices.
      const at = face.geometry!.axisStart!;
      return [Math.round(at.x), Math.round(at.y)] as [number, number];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

describe('M02 patterns on sketch points: document contract', () => {
  it('stores the sketch, its points and the reference at schema v63', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(63);
    const { document, sketchId, ids } = pointsSketch(
      box('Block', { x: 10, y: 10, z: 10 }),
      0,
      [
        [5, 5],
        [30, 5]
      ]
    );
    const patterned = onPoints(document, sketchId, ids, {
      targetBodyId: document.bodyOrder[0]!
    });
    expect(listFeaturesInOrder(patterned).at(-1)!.data).toMatchObject({
      patternKind: 'points',
      points: { sketchId, pointIds: ids, referencePointId: ids[0] }
    });
  });

  it.each([
    [
      'no points on a points pattern',
      (ids: string[]) => ({ points: undefined, count: ids.length }),
      /needs its sketch and points/
    ],
    [
      'points on a linear pattern',
      () => ({ patternKind: 'linear' as const, spacing: 20 }),
      /Only a pattern on sketch points/
    ],
    [
      'a reference that is not one of the points',
      (ids: string[], sketchId: SketchId) => ({
        points: { sketchId, pointIds: ids.slice(1), referencePointId: ids[0]! }
      }),
      /must be one of the pattern's points/
    ],
    [
      'only the reference',
      (ids: string[], sketchId: SketchId) => ({
        points: {
          sketchId,
          pointIds: ids.slice(0, 1),
          referencePointId: ids[0]!
        }
      }),
      /a point besides the original's/
    ],
    [
      'skipping the reference',
      (ids: string[]) => ({ skippedInstances: [ids[0]!] }),
      /cannot skip its original/
    ],
    [
      'skipping a point it does not stand on',
      () => ({ skippedInstances: ['node_elsewhere'] }),
      /not one of the pattern's points/
    ]
  ])('refuses %s', (_label, patch, message) => {
    const { document, sketchId, ids } = pointsSketch(
      box('Block', { x: 10, y: 10, z: 10 }),
      0,
      [
        [5, 5],
        [30, 5],
        [5, 30]
      ]
    );
    expect(() =>
      patternBody(document, {
        name: 'On points',
        targetBodyId: document.bodyOrder[0]!,
        patternKind: 'points',
        count: ids.length,
        axis: 'x',
        points: { sketchId, pointIds: ids, referencePointId: ids[0]! },
        ...patch(ids, sketchId)
      })
    ).toThrow(message);
  });

  it('refuses an entity of the sketch that is not a point', () => {
    let document = box('Block', { x: 10, y: 10, z: 10 });
    const sketched = addSketchFeature(document, {
      name: 'Mixed',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'point', x: 5, y: 5 },
        { objectKind: 'line', x1: 0, y1: 20, x2: 10, y2: 20 }
      ]
    });
    document = sketched.document;
    const ids = findSketch(document, sketched.sketchId)!.objectIds.map(String);
    expect(() =>
      onPoints(document, sketched.sketchId, ids, {
        targetBodyId: document.bodyOrder[0]!
      })
    ).toThrow(/no longer a point of Mixed/);
  });

  it('refuses a points pattern on a document that declares schema v62', () => {
    const { document, sketchId, ids } = pointsSketch(
      box('Block', { x: 10, y: 10, z: 10 }),
      0,
      [
        [5, 5],
        [30, 5]
      ]
    );
    const old = {
      ...document,
      schemaVersion: 62
    } as unknown as ProjectDocument;
    expect(() =>
      onPoints(old, sketchId, ids, { targetBodyId: document.bodyOrder[0]! })
    ).toThrow(/require project schema v63/);
  });
});

describe('M02 patterns on sketch points: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  /** A Ø6 through hole at x = 10 on the plate’s middle y coordinate. */
  async function drilled(
    style: 'simple' | 'counterbore' = 'simple',
    stock = PLATE
  ): Promise<{
    document: ProjectDocument;
    holeId: FeatureId;
  }> {
    const document = box('Plate', stock);
    const derived = await adapter.syncDocument(document);
    const face = topFace(derived, last(document));
    const body = derived.bodyRepresentations[last(document)]!;
    const next = holeBody(document, {
      name: 'Hole',
      targetBodyId: last(document),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style,
      ...(style === 'counterbore'
        ? { counterboreDiameter: 10, counterboreDepth: 2 }
        : {}),
      diameter: 2 * HOLE_R,
      depthMode: 'through',
      position: { u: 0, v: 10 - (body.bbox.min.x + body.bbox.max.x) / 2 },
      positionAnchor: 'centroid'
    }).document;
    return { document: next, holeId: lastFeature(next) };
  }

  async function pointPlate() {
    const { document: holed, holeId } = await drilled();
    const coords: [number, number][] = [[10, 20]];
    for (const y of [10, 20, 30])
      for (let x = 10; x <= 80; x += 10)
        if (x !== 10 || y !== 20) coords.push([x, y]);
    const { document, sketchId, ids } = pointsSketch(holed, PLATE.z, coords);
    const plate = onPoints(document, sketchId, ids, {
      targetBodyId: last(holed),
      sourceFeatureIds: [holeId]
    });
    return { plate, sketchId, ids };
  }

  it('stops a superseded build while waiting for the exact pattern mesh', async () => {
    const { plate } = await pointPlate();
    const candidate = await createExactKernelAdapter();
    let cancelled = false;
    let waiting!: () => void;
    const started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const terminate = vi.fn();
    class SilentWorker {
      terminate = terminate;
      postMessage() {}
    }
    const original = PointPatternMeshWorker.prototype.wait;
    const wait = vi
      .spyOn(PointPatternMeshWorker.prototype, 'wait')
      .mockImplementation(function (this: PointPatternMeshWorker, solids) {
        const ready = original.call(this, solids);
        if (ready) waiting();
        return ready;
      });
    vi.stubGlobal('Worker', SilentWorker);
    const stage = vi.fn();
    const measure = vi.spyOn(
      RemusKernel.prototype,
      'tessellateSolidGroupedBinary'
    );
    try {
      const pending = candidate.syncDocument(
        plate,
        undefined,
        undefined,
        undefined,
        {
          onPatternMesh: stage,
          cancellation: { isCancelled: () => cancelled }
        }
      );
      await started;
      cancelled = true;
      await expect(pending).rejects.toThrow(/rebuild was cancelled/i);
      // Superseding an edit releases the build before the silent helper's
      // response timeout. The next edit can still use the same helper.
      expect(terminate).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(
        measure.mock.invocationCallOrder.every(
          (order) => order < wait.mock.invocationCallOrder.at(-1)!
        )
      ).toBe(true);
    } finally {
      measure.mockRestore();
      wait.mockRestore();
      vi.unstubAllGlobals();
      candidate.dispose();
    }
  });

  it('draws the exact checked plate with the helper and preserves a later refusal', async () => {
    const { plate, sketchId, ids } = await pointPlate();
    const bad = updateSketchObject(plate, {
      sketchId,
      objectId: ids[1] as never,
      data: { objectKind: 'point', x: 200, y: 10 }
    });
    const reference = await createExactKernelAdapter();
    const candidate = await createExactKernelAdapter();
    const baseline = await reference.syncDocument(plate);
    const refused = await reference.syncDocument(bad);
    expect(refused.warnings.join(' ')).toMatch(/misses/);
    const stage = vi.fn();
    let calls = 0;
    class MeshWorker {
      onmessage?: (event: { data: unknown }) => void;
      terminate() {}
      postMessage(data: {
        init?: boolean;
        id: number;
        bytes: Uint8Array;
        options: [number, number];
      }) {
        if (data.init) return;
        queueMicrotask(() => {
          const workerKernel = new RemusKernel();
          try {
            const [id] = workerKernel.deserializeSolids(data.bytes);
            const mesh = workerKernel.tessellateSolidGroupedBinary(
              id!,
              ...data.options
            );
            try {
              calls++;
              this.onmessage?.({
                data: {
                  id: data.id,
                  mesh: {
                    positions: mesh.takePositions(),
                    indices: mesh.takeIndices(),
                    faceOffsets: mesh.takeFaceOffsets()
                  }
                }
              });
            } finally {
              mesh.free();
            }
          } finally {
            workerKernel.free();
          }
        });
      }
    }
    vi.stubGlobal('Worker', MeshWorker);
    const underlying = RemusKernel.prototype.tessellateSolidGroupedBinary;
    let plateMeshes = 0;
    const tessellate = vi
      .spyOn(RemusKernel.prototype, 'tessellateSolidGroupedBinary')
      .mockImplementation(function (this: RemusKernel, id, ...options) {
        if (this.getSolidFaces(id).length === 30) plateMeshes++;
        return underlying.call(this, id, ...options);
      });
    try {
      const result = await candidate.syncDocument(
        plate,
        undefined,
        undefined,
        undefined,
        { onPatternMesh: stage }
      );
      expect(calls).toBe(1);
      expect(stage).toHaveBeenCalledTimes(1);
      expect(result.bodyRepresentations).toEqual(baseline.bodyRepresentations);
      expect(result.warnings).toEqual(baseline.warnings);
      // Only the auxiliary kernel tessellated the complete, 30-face plate.
      const body = result.bodyRepresentations[last(plate)]!;
      expect(body.faceCount).toBe(
        baseline.bodyRepresentations[last(plate)]!.faceCount
      );
      expect(plateMeshes).toBe(1);
      const failed = await candidate.syncDocument(
        bad,
        undefined,
        undefined,
        undefined,
        { onPatternMesh: stage }
      );
      expect(failed.warnings).toEqual(refused.warnings);
      expect(failed.bodyRepresentations).toEqual(refused.bodyRepresentations);
      expect(stage).toHaveBeenCalledTimes(1);

      // A downstream hole consumes the pattern. Its intermediate mesh must
      // never occupy the helper or reach the viewport.
      const face = topFace(baseline, last(plate));
      const finished = holeBody(plate, {
        name: 'Finish plate',
        targetBodyId: last(plate),
        faceHash: face.hash,
        ...(face.reference ? { faceReference: face.reference } : {}),
        style: 'simple',
        diameter: 4,
        depthMode: 'through',
        position: { u: 0, v: 44 },
        positionAnchor: 'centroid'
      }).document;
      const nested = await createExactKernelAdapter();
      try {
        const expected = await reference.syncDocument(finished);
        expect(expected.warnings).toEqual([]);
        const actual = await nested.syncDocument(
          finished,
          undefined,
          undefined,
          undefined,
          { onPatternMesh: stage }
        );
        expect(actual.bodyRepresentations).toEqual(
          expected.bodyRepresentations
        );
        expect(actual.warnings).toEqual(expected.warnings);
        expect(calls).toBe(1);
        expect(stage).toHaveBeenCalledTimes(1);
      } finally {
        nested.dispose();
      }
    } finally {
      tessellate.mockRestore();
      vi.unstubAllGlobals();
      candidate.dispose();
      reference.dispose();
    }
  });

  it('restores only identical checked cuts when the last pattern holes are skipped', async () => {
    const { document: holed, holeId } = await drilled();
    const { document, sketchId, ids } = pointsSketch(holed, PLATE.z, [
      [10, 20],
      [40, 10],
      [70, 30],
      [90, 20],
      [20, 10],
      [55, 20],
      [80, 10],
      [30, 30],
      [60, 30],
      [12, 30],
      [48, 30],
      [90, 30]
    ]);
    let patterned = onPoints(document, sketchId, ids, {
      targetBodyId: last(holed),
      sourceFeatureIds: [holeId]
    });
    await adapter.syncDocument(patterned);
    const cuts = vi.spyOn(cancellation, 'exactCutWithCancellation');
    try {
      const coincident = updateSketchObject(patterned, {
        sketchId,
        objectId: findSketch(document, sketchId)!.objectIds.at(-1)!,
        data: { objectKind: 'point', x: 40, y: 10 }
      });
      const refused = await adapter.syncDocument(coincident);
      expect(cuts).toHaveBeenCalledTimes(3);
      expect(
        refused.featureWarnings?.map((warning) => warning.message).join(' ')
      ).toContain('removes nothing');
      const freshRefusal = await createExactKernelAdapter();
      try {
        const reference = await freshRefusal.syncDocument(coincident);
        expect(refused.warnings).toEqual(reference.warnings);
        expect(refused.featureWarnings).toEqual(reference.featureWarnings);
      } finally {
        freshRefusal.dispose();
      }
      for (let skipped = 1; skipped <= 3; skipped++) {
        patterned = updateFeature(patterned, {
          featureId: lastFeature(patterned),
          data: {
            featureKind: 'pattern',
            skippedInstances: ids.slice(-skipped)
          }
        });
        cuts.mockClear();
        const warm = await adapter.syncDocument(patterned);
        expect(cuts).toHaveBeenCalledTimes(3 - skipped);
        expect(warm.warnings).toEqual([]);
        const cold = await createExactKernelAdapter();
        try {
          const fresh = await cold.syncDocument(patterned);
          expect(warm.bodyRepresentations[last(patterned)]).toEqual(
            fresh.bodyRepresentations[last(patterned)]
          );
        } finally {
          cold.dispose();
        }
      }
      const changed = updateSketchObject(patterned, {
        sketchId,
        objectId: findSketch(document, sketchId)!.objectIds[1]!,
        data: { objectKind: 'point', x: 41, y: 10 }
      });
      cuts.mockClear();
      const rebuilt = await adapter.syncDocument(changed);
      expect(cuts).toHaveBeenCalledTimes(8);
      expect(rebuilt.warnings).toEqual([]);
      expect(bores(rebuilt, last(changed))).toContainEqual([41, 10]);
      const freshMove = await createExactKernelAdapter();
      try {
        const reference = await freshMove.syncDocument(changed);
        expect(rebuilt.bodyRepresentations[last(changed)]).toEqual(
          reference.bodyRepresentations[last(changed)]
        );
      } finally {
        freshMove.dispose();
      }
    } finally {
      cuts.mockRestore();
    }
  }, 120_000);

  it('replays all cuts when the serialized operands and result exceed the shared byte limit', () => {
    const kernel = new RemusKernel();
    try {
      const stock = kernel.makeBox(100, 100, 10);
      const tool = kernel.makeCylinder(3, 10);
      const copies = Array.from({ length: 12 }, () => [tool]);
      const open = () =>
        patternCutPrefix(kernel, 'large-prefix', stock, 100000, copies);
      const initial = open()!;
      const serialize = vi.spyOn(kernel, 'serializeSolids');
      const restore = vi.spyOn(kernel, 'deserializeSolids');
      serialize.mockReturnValue(new Uint8Array(200 * 1024));
      initial.capture(9, stock);
      initial.commit();
      expect(serialize).toHaveBeenCalledTimes(2);
      expect(open()?.count).toBe(0);
      expect(restore).not.toHaveBeenCalled();
    } finally {
      kernel.free();
    }
  });

  it('rebuilds only the final three cutters when moving the last of 100 holes', async () => {
    const { document: holed, holeId } = await drilled('simple', {
      ...PLATE,
      y: 100
    });
    const locations: [number, number][] = [[10, 50]];
    for (let y = 5; y < 100; y += 10) {
      for (let x = 5; x < 100 && locations.length < 100; x += 10)
        locations.push([x, y]);
    }
    const { document, sketchId, ids } = pointsSketch(holed, PLATE.z, locations);
    const original = onPoints(document, sketchId, ids, {
      targetBodyId: last(holed),
      sourceFeatureIds: [holeId]
    });
    expect((await adapter.syncDocument(original)).warnings).toEqual([]);
    const [x, y] = locations.at(-1)!;
    const moved = updateSketchObject(original, {
      sketchId,
      objectId: findSketch(document, sketchId)!.objectIds.at(-1)!,
      data: { objectKind: 'point', x: x + 0.25, y }
    });
    const cuts = vi.spyOn(cancellation, 'exactCutWithCancellation');
    try {
      const warm = await adapter.syncDocument(moved);
      expect(cuts).toHaveBeenCalledTimes(3);
      expect(warm.warnings).toEqual([]);
      const cold = await createExactKernelAdapter();
      try {
        const reference = await cold.syncDocument(moved);
        expect(warm.bodyRepresentations[last(moved)]).toEqual(
          reference.bodyRepresentations[last(moved)]
        );
      } finally {
        cold.dispose();
      }
    } finally {
      cuts.mockRestore();
    }
  }, 120_000);

  it('checks both counterbore radii on each kept point after a skip', async () => {
    const { document: holed, holeId } = await drilled('counterbore');
    const { document, sketchId, ids } = pointsSketch(holed, PLATE.z, [
      [10, 20],
      [40, 10],
      [70, 30],
      [90, 20]
    ]);
    const patterned = onPoints(document, sketchId, ids, {
      targetBodyId: last(holed),
      sourceFeatureIds: [holeId],
      skippedInstances: [ids[2]!]
    });
    const measure = vi.spyOn(cylinderOps, 'measureCylinderFaces');
    let derived: DerivedState;
    try {
      derived = await adapter.syncDocument(patterned);
      const solids = measure.mock.calls.map(([, solid]) => solid);
      expect(solids.length).toBeGreaterThan(0);
      expect(new Set(solids).size).toBe(solids.length);
    } finally {
      measure.mockRestore();
    }
    expect(derived.warnings).toEqual([]);
    const result = derived.bodyRepresentations[last(patterned)]!;
    const bores = result
      .topology!.faces.flatMap(({ geometry }) =>
        geometry?.surfaceType === 'cylinder' && geometry.axisStart
          ? [
              [
                Math.round(geometry.axisStart.x),
                Math.round(geometry.axisStart.y),
                Number(geometry.radius!.toFixed(9))
              ]
            ]
          : []
      )
      .sort(([x, , a], [y, , b]) => x! - y! || a! - b!);
    expect(bores).toEqual([
      [10, 20, 3],
      [10, 20, 5],
      [40, 10, 3],
      [40, 10, 5],
      [90, 20, 3],
      [90, 20, 5]
    ]);
  });

  it('repeats a hole at each point, from the point it stands on', async () => {
    const { document: holed, holeId } = await drilled();
    const { document, sketchId, ids } = pointsSketch(holed, PLATE.z, [
      [10, 20],
      [40, 10],
      [70, 30],
      [90, 20]
    ]);
    const patterned = onPoints(document, sketchId, ids, {
      targetBodyId: last(holed),
      sourceFeatureIds: [holeId]
    });
    const derived = await adapter.syncDocument(patterned);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(patterned)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 4 * HOLE_VOLUME,
      6
    );
    expect(bores(derived, last(patterned))).toEqual([
      [10, 20],
      [40, 10],
      [70, 30],
      [90, 20]
    ]);
    // Each copy is named by its point, so another point renames none.
    const names = derived.bodyRepresentations[
      last(patterned)
    ]!.topology!.faces.flatMap((face) => face.reference?.lineageName ?? [])
      .filter((name) => name.includes('hole.face.bore'))
      .sort();
    expect(names).toEqual(
      [
        'hole.face.bore',
        ...ids
          .slice(1)
          .map(
            (id) =>
              `pattern.face.instance.${id}.source.${holeId}.hole.face.bore`
          )
      ].sort()
    );
  }, 120_000);

  it('skips a point, and a moved point carries its copy', async () => {
    const { document: holed, holeId } = await drilled();
    const { document, sketchId, ids } = pointsSketch(holed, PLATE.z, [
      [10, 20],
      [40, 10],
      [70, 30]
    ]);
    const patterned = onPoints(document, sketchId, ids, {
      targetBodyId: last(holed),
      sourceFeatureIds: [holeId],
      skippedInstances: [ids[1]!]
    });
    const derived = await adapter.syncDocument(patterned);
    expect(derived.warnings).toEqual([]);
    expect(bores(derived, last(patterned))).toEqual([
      [10, 20],
      [70, 30]
    ]);
    const moved = updateSketchObject(patterned, {
      sketchId,
      objectId: ids[2] as never,
      data: { objectKind: 'point', x: 80, y: 15 }
    });
    const after = await adapter.syncDocument(moved);
    expect(after.warnings).toEqual([]);
    expect(bores(after, last(moved))).toEqual([
      [10, 20],
      [80, 15]
    ]);
  }, 120_000);

  it('places whole-body copies, fusing the ones that overlap', async () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const built = await adapter.syncDocument(block);
    const at = built.bodyRepresentations[last(block)]!.bbox.min;
    // The block's corner is the reference; one copy stands clear and one
    // overlaps it by half.
    const { document, sketchId, ids } = pointsSketch(block, 0, [
      [at.x, at.y],
      [at.x + 30, at.y],
      [at.x + 5, at.y]
    ]);
    const clear = onPoints(document, sketchId, ids.slice(0, 2), {
      targetBodyId: last(block)
    });
    const overlapping = onPoints(document, sketchId, ids, {
      targetBodyId: last(block)
    });
    const [apart, joined] = [
      await adapter.syncDocument(clear),
      await adapter.syncDocument(overlapping)
    ];
    expect(apart.warnings).toEqual([]);
    expect(apart.bodyRepresentations[last(clear)]!.volume).toBeCloseTo(2000, 6);
    expect(joined.warnings).toEqual([]);
    // 1000 + 1000 + 1000 − the two halves the overlapping copy shares.
    expect(joined.bodyRepresentations[last(overlapping)]!.volume).toBeCloseTo(
      2500,
      6
    );
  }, 120_000);

  it('refuses a deleted point by name', async () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const { document, sketchId, ids } = pointsSketch(block, 0, [
      [0, 0],
      [30, 0],
      [60, 0]
    ]);
    const patterned = onPoints(document, sketchId, ids, {
      targetBodyId: last(block)
    });
    const gone = deleteSketchObject(patterned, {
      sketchId,
      objectId: ids[2] as never
    });
    const derived = await adapter.syncDocument(gone);
    expect(
      derived.featureWarnings?.map((warning) => warning.message).join('\n')
    ).toMatch(/no longer a point of Points/);
  }, 120_000);

  it('edits the points through a feature update', async () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const { document, sketchId, ids } = pointsSketch(block, 0, [
      [0, 0],
      [30, 0],
      [60, 0]
    ]);
    const patterned = onPoints(document, sketchId, ids.slice(0, 2), {
      targetBodyId: last(block)
    });
    const grown = updateFeature(patterned, {
      featureId: lastFeature(patterned),
      data: {
        featureKind: 'pattern',
        points: { sketchId, pointIds: ids, referencePointId: ids[0]! }
      }
    });
    const derived = await adapter.syncDocument(grown);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(grown)]!.volume).toBeCloseTo(
      3000,
      6
    );
  }, 120_000);
});
