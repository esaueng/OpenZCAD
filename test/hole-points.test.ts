import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  deleteSketchObject,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  patternBody,
  updateFeature,
  updateSketchObject,
  type HoleInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
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
 * M01 holes on sketch points (schema v64): one bore at each picked I01
 * point entity, read on its sketch plane and dropped onto the hole's entry
 * face. Every expectation is a closed form on a 100 × 40 × 10 plate whose
 * corner stands at the origin.
 */

const PLATE = { x: 100, y: 40, z: 10 };
const PLATE_VOLUME = PLATE.x * PLATE.y * PLATE.z;
const HOLE_R = 3;
const BORE_VOLUME = Math.PI * HOLE_R ** 2 * PLATE.z;

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;

function plate(): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Plate', toUserId('user_m01')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: PLATE.x, height: PLATE.y, depth: PLATE.z }
    }
  );
}

/** A sketch of points on `plane` at `offset`, and their ids in order. */
function pointsSketch(
  document: ProjectDocument,
  offset: number,
  points: readonly [number, number][],
  plane: 'XY' | 'XZ' = 'XY'
): { document: ProjectDocument; sketchId: SketchId; ids: string[] } {
  const sketched = addSketchFeature(document, {
    name: 'Points',
    planeRef: { type: 'canonical', plane, offset },
    objects: points.map(([x, y]) => ({ objectKind: 'point' as const, x, y }))
  });
  const sketch = findSketch(sketched.document, sketched.sketchId)!;
  return {
    document: sketched.document,
    sketchId: sketched.sketchId,
    ids: sketch.objectIds.map(String)
  };
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

/** A Ø6 hole on the plate's top face, its position left to `extra`. */
function holeInput(
  document: ProjectDocument,
  derived: DerivedState,
  extra: Partial<HoleInput> = {}
): HoleInput {
  const face = topFace(derived, last(document));
  return {
    name: 'Hole',
    targetBodyId: last(document),
    faceHash: face.hash,
    ...(face.reference ? { faceReference: face.reference } : {}),
    style: 'simple',
    diameter: 2 * HOLE_R,
    depthMode: 'through',
    position: { u: 0, v: 0 },
    positionAnchor: 'centroid',
    ...extra
  };
}

/** World (x, y) of every bore of radius `radius`, sorted. */
function bores(
  derived: DerivedState,
  bodyId: BodyId,
  radius = HOLE_R
): [number, number][] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs((face.geometry.radius ?? 0) - radius) < 1e-6
  )
    .map((face) => {
      const at = face.geometry!.axisStart!;
      return [Math.round(at.x), Math.round(at.y)] as [number, number];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function lineageNames(derived: DerivedState, bodyId: BodyId): string[] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.flatMap(
    (face) => face.reference?.lineageName ?? []
  ).sort();
}

function warningText(derived: DerivedState): string {
  return [
    ...derived.warnings,
    ...(derived.featureWarnings ?? []).map((warning) => warning.message)
  ].join('\n');
}

describe('M01 holes on sketch points: document contract', () => {
  /** A plate, a points sketch on its top and a stand-in face hash. */
  function setup() {
    const base = plate();
    const { document, sketchId, ids } = pointsSketch(base, PLATE.z, [
      [20, 20],
      [80, 20]
    ]);
    const input: HoleInput = {
      name: 'Hole',
      targetBodyId: last(base),
      faceHash: 1,
      style: 'simple',
      diameter: 6,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      points: { sketchId, pointIds: ids }
    };
    return { document, sketchId, ids, input };
  }

  it('stores the sketch and its points at schema v64', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(64);
    const { document, sketchId, ids, input } = setup();
    const holed = holeBody(document, input).document;
    expect(listFeaturesInOrder(holed).at(-1)!.data).toMatchObject({
      featureKind: 'hole',
      points: { sketchId, pointIds: ids }
    });
    expect(() => assertDocumentContentSchema(holed)).not.toThrow();
  });

  it.each([
    [
      'no points',
      (_ids: string[], sketchId: SketchId) => ({
        points: { sketchId, pointIds: [] }
      }),
      /at least one point/
    ],
    [
      'a point named twice',
      (ids: string[], sketchId: SketchId) => ({
        points: { sketchId, pointIds: [ids[0]!, ids[0]!] }
      }),
      /each point once/
    ],
    [
      'a missing sketch',
      (ids: string[]) => ({
        points: { sketchId: 'sketch_gone' as SketchId, pointIds: ids }
      }),
      /no longer there/
    ],
    [
      'a point that is not in the sketch',
      (_ids: string[], sketchId: SketchId) => ({
        points: { sketchId, pointIds: ['node_elsewhere'] }
      }),
      /no longer a point of Points/
    ]
  ])('refuses %s', (_label, patch, message) => {
    const { document, sketchId, ids, input } = setup();
    expect(() =>
      holeBody(document, { ...input, ...patch(ids, sketchId) })
    ).toThrow(message);
  });

  it('refuses an entity of the sketch that is not a point', () => {
    const base = plate();
    const sketched = addSketchFeature(base, {
      name: 'Mixed',
      planeRef: { type: 'canonical', plane: 'XY', offset: PLATE.z },
      objects: [
        { objectKind: 'point', x: 20, y: 20 },
        { objectKind: 'line', x1: 0, y1: 30, x2: 10, y2: 30 }
      ]
    });
    const ids = findSketch(sketched.document, sketched.sketchId)!.objectIds.map(
      String
    );
    const { input } = setup();
    expect(() =>
      holeBody(sketched.document, {
        ...input,
        targetBodyId: last(base),
        points: { sketchId: sketched.sketchId, pointIds: ids }
      })
    ).toThrow(/no longer a point of Mixed/);
  });

  it('refuses a sketch later in History than the hole', () => {
    const { document, sketchId, ids, input } = setup();
    // Drilled at the sketch's points, then moved before it.
    const holed = holeBody(document, input).document;
    const holeId = lastFeature(holed);
    const reordered = {
      ...holed,
      featureOrder: [
        holed.featureOrder[0]!,
        holeId,
        ...holed.featureOrder.slice(1).filter((id) => id !== holeId)
      ]
    };
    expect(() =>
      updateFeature(reordered, {
        featureId: holeId,
        data: { featureKind: 'hole', points: { sketchId, pointIds: ids } }
      })
    ).toThrow(/comes later in History/);
  });

  it('refuses sketch points on a document that declares schema v63', () => {
    const { document, input } = setup();
    const old = {
      ...document,
      schemaVersion: 63
    } as unknown as ProjectDocument;
    expect(() => holeBody(old, input)).toThrow(
      /Holes on sketch points require project schema v64/
    );
    const holed = holeBody(document, input).document;
    expect(() =>
      assertDocumentContentSchema({
        ...holed,
        schemaVersion: 63
      } as unknown as ProjectDocument)
    ).toThrow(/require project schema v64/);
  });

  it('clears the points back to the one stored position', () => {
    const { document, input } = setup();
    const holed = holeBody(document, input).document;
    const cleared = updateFeature(holed, {
      featureId: lastFeature(holed),
      clearData: ['points']
    });
    expect(listFeaturesInOrder(cleared).at(-1)!.data).not.toHaveProperty(
      'points'
    );
  });
});

describe('M01 holes on sketch points: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function drill(
    points: readonly [number, number][],
    extra: Partial<HoleInput> = {},
    offset: number = PLATE.z
  ) {
    const base = plate();
    const derived = await adapter.syncDocument(base);
    const sketched = pointsSketch(base, offset, points);
    const document = holeBody(sketched.document, {
      ...holeInput(base, derived, extra),
      points: { sketchId: sketched.sketchId, pointIds: sketched.ids }
    }).document;
    return { ...sketched, document };
  }

  it('drills a through bore at every point, each named by its point', async () => {
    const { document, ids } = await drill([
      [10, 20],
      [40, 10],
      [70, 30],
      [90, 20]
    ]);
    const derived = await adapter.syncDocument(document);
    expect(warningText(derived)).toBe('');
    expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 4 * BORE_VOLUME,
      6
    );
    expect(bores(derived, last(document))).toEqual([
      [10, 20],
      [40, 10],
      [70, 30],
      [90, 20]
    ]);
    expect(
      lineageNames(derived, last(document)).filter((name) =>
        name.startsWith('hole.face.')
      )
    ).toEqual(ids.map((id) => `hole.face.at.${id}.bore`).sort());
  }, 120_000);

  it('drills blind counterbores at each point', async () => {
    const { document, ids } = await drill(
      [
        [25, 20],
        [75, 20]
      ],
      {
        style: 'counterbore',
        depthMode: 'blind',
        depth: 8,
        counterboreDiameter: 11,
        counterboreDepth: 3
      }
    );
    const derived = await adapter.syncDocument(document);
    expect(warningText(derived)).toBe('');
    // Each: a Ø11 × 3 counterbore over a Ø6 bore to 8 from the face.
    const one = Math.PI * 5.5 ** 2 * 3 + Math.PI * HOLE_R ** 2 * (8 - 3);
    expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 2 * one,
      6
    );
    expect(bores(derived, last(document), 5.5)).toEqual([
      [25, 20],
      [75, 20]
    ]);
    const names = lineageNames(derived, last(document));
    for (const id of ids) {
      expect(names).toContain(`hole.face.at.${id}.bore`);
      expect(names).toContain(`hole.face.at.${id}.counterbore`);
    }
    // The shoulders and floors share a plane each, so none is named.
    expect(names.some((name) => name.endsWith('.shoulder'))).toBe(false);
    expect(names.some((name) => name.endsWith('.floor'))).toBe(false);
  }, 120_000);

  it('drops points from a parallel sketch onto the face', async () => {
    // The sketch on the plate's bottom: the bores still enter at the top.
    const { document } = await drill(
      [
        [30, 15],
        [60, 25]
      ],
      { depthMode: 'blind', depth: 4 },
      0
    );
    const derived = await adapter.syncDocument(document);
    expect(warningText(derived)).toBe('');
    expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 2 * Math.PI * HOLE_R ** 2 * 4,
      6
    );
    expect(bores(derived, last(document))).toEqual([
      [30, 15],
      [60, 25]
    ]);
  }, 120_000);

  it('carries a moved point, and refuses a deleted one by name', async () => {
    const { document, sketchId, ids } = await drill([
      [20, 20],
      [80, 20]
    ]);
    const moved = updateSketchObject(document, {
      sketchId,
      objectId: ids[1] as never,
      data: { objectKind: 'point', x: 60, y: 10 }
    });
    const after = await adapter.syncDocument(moved);
    expect(warningText(after)).toBe('');
    expect(bores(after, last(moved))).toEqual([
      [20, 20],
      [60, 10]
    ]);
    const gone = deleteSketchObject(document, {
      sketchId,
      objectId: ids[1] as never
    });
    expect(warningText(await adapter.syncDocument(gone))).toMatch(
      /no longer a point of Points/
    );
  }, 120_000);

  it('refuses a point off the face by its id', async () => {
    const { document, ids } = await drill([
      [20, 20],
      [150, 20]
    ]);
    const derived = await adapter.syncDocument(document);
    expect(warningText(derived)).toContain(`At sketch point ${ids[1]}:`);
    expect(warningText(derived)).toMatch(/misses the body/);
  }, 120_000);

  it('refuses a sketch that is not parallel to the face', async () => {
    const base = plate();
    const derived = await adapter.syncDocument(base);
    const sketched = pointsSketch(base, 20, [[20, 5]], 'XZ');
    const document = holeBody(sketched.document, {
      ...holeInput(base, derived),
      points: { sketchId: sketched.sketchId, pointIds: sketched.ids }
    }).document;
    expect(warningText(await adapter.syncDocument(document))).toMatch(
      /Points is not parallel to the hole's entry face/
    );
  }, 120_000);

  it('switches between one position and sketch points by an edit', async () => {
    const { document, sketchId, ids } = await drill([
      [20, 20],
      [80, 20]
    ]);
    const single = updateFeature(document, {
      featureId: lastFeature(document),
      clearData: ['points']
    });
    const one = await adapter.syncDocument(single);
    expect(warningText(one)).toBe('');
    // The stored position: the face's centroid.
    expect(bores(one, last(single))).toEqual([[50, 20]]);
    expect(lineageNames(one, last(single))).toContain('hole.face.bore');
    const again = updateFeature(single, {
      featureId: lastFeature(single),
      data: { featureKind: 'hole', points: { sketchId, pointIds: ids } }
    });
    expect(bores(await adapter.syncDocument(again), last(again))).toEqual([
      [20, 20],
      [80, 20]
    ]);
  }, 120_000);

  it('is repeated whole by an M02 feature pattern', async () => {
    const { document, ids } = await drill([
      [10, 10],
      [10, 30]
    ]);
    const holeId = lastFeature(document);
    const patterned = patternBody(document, {
      name: 'Row',
      targetBodyId: last(document),
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 30,
      sourceFeatureIds: [holeId]
    }).document;
    const derived = await adapter.syncDocument(patterned);
    expect(warningText(derived)).toBe('');
    expect(derived.bodyRepresentations[last(patterned)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 6 * BORE_VOLUME,
      6
    );
    expect(bores(derived, last(patterned))).toEqual([
      [10, 10],
      [10, 30],
      [40, 10],
      [40, 30],
      [70, 10],
      [70, 30]
    ]);
    const names = lineageNames(derived, last(patterned));
    for (const label of ['1', '2']) {
      for (const id of ids) {
        expect(names).toContain(
          `pattern.face.instance.${label}.source.${holeId}.hole.face.at.${id}.bore`
        );
      }
    }
  }, 120_000);
});
