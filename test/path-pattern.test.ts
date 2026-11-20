import { beforeAll, describe, expect, it } from 'vitest';
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
  type PatternInput
} from '@openzcad/document-core';
import {
  chainPathCurves,
  pathPatternFitProblem,
  pathStationAt,
  pathTurnDeg,
  type PathChain,
  type PathCurve2
} from '@openzcad/geometry';
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
  type SketchId,
  type SketchObjectData
} from '@openzcad/shared';

/**
 * M02 patterns along a sketch path (schema v112): copies spaced by arc
 * length along joined sketch lines and arcs, moved or also turned with the
 * path. Every expectation is a closed form on a 100 × 40 × 10 plate or a
 * 20 × 4 × 5 block.
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

/** A sketch of curves on XY at `z`, and their ids in drawing order. */
function pathSketch(
  document: ProjectDocument,
  z: number,
  objects: readonly SketchObjectData[]
): { document: ProjectDocument; sketchId: SketchId; ids: string[] } {
  const sketched = addSketchFeature(document, {
    name: 'Path',
    planeRef: { type: 'canonical', plane: 'XY', offset: z },
    objects: [...objects]
  });
  const sketch = findSketch(sketched.document, sketched.sketchId)!;
  return {
    document: sketched.document,
    sketchId: sketched.sketchId,
    ids: sketch.objectIds.map(String)
  };
}

const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number
): SketchObjectData => ({ objectKind: 'line', x1, y1, x2, y2 });

const arc = (
  centerX: number,
  centerY: number,
  radius: number,
  startAngleDeg: number,
  endAngleDeg: number
): SketchObjectData => ({
  objectKind: 'arc',
  centerX,
  centerY,
  radius,
  startAngleDeg,
  endAngleDeg
});

function alongPath(
  document: ProjectDocument,
  sketchId: SketchId,
  ids: string[],
  extra: Partial<PatternInput> = {}
): ProjectDocument {
  return patternBody(document, {
    name: 'Along path',
    targetBodyId: last(document),
    patternKind: 'path',
    count: 3,
    spacing: 20,
    axis: 'x',
    path: { sketchId, entityIds: ids },
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

/** World (x, y) of every Ø6 bore's axis, sorted by x. */
function bores(derived: DerivedState, bodyId: BodyId): [number, number][] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs(face.geometry.area - 2 * Math.PI * HOLE_R * PLATE.z) < 1e-6
  )
    .map((face) => {
      const at = face.geometry!.axisStart!;
      return [at.x, at.y] as [number, number];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function expectPoints(
  actual: readonly [number, number][],
  expected: readonly [number, number][]
): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach(([x, y], index) => {
    expect(x).toBeCloseTo(expected[index]![0], 6);
    expect(y).toBeCloseTo(expected[index]![1], 6);
  });
}

function chain(curves: PathCurve2[], reversed = false): PathChain {
  const chained = chainPathCurves(curves, reversed);
  if (typeof chained === 'string') throw new Error(chained);
  return chained;
}

const HALF_PI = Math.PI / 2;

describe('M02 patterns along a path: stations', () => {
  const lShape: PathCurve2[] = [
    // Listed out of order and the line drawn backwards: chaining finds the
    // joint, not the list.
    {
      kind: 'arc',
      id: 'a',
      center: { x: 50, y: 20 },
      radius: 10,
      startAngle: -HALF_PI,
      sweep: HALF_PI
    },
    { kind: 'line', id: 'l', start: { x: 50, y: 10 }, end: { x: 10, y: 10 } }
  ];

  it('chains a line and an arc and measures the path in closed form', () => {
    const path = chain(lShape);
    expect(path.closed).toBe(false);
    expect(path.length).toBeCloseTo(40 + 5 * Math.PI, 12);
    // The earliest-listed end curve is the arc, so the path starts at its
    // free end, (60, 20), and runs back down it onto the line.
    const start = pathStationAt(path, 0)!;
    expect(start.point.x).toBeCloseTo(60, 12);
    expect(start.point.y).toBeCloseTo(20, 12);
    const end = pathStationAt(path, path.length)!;
    expect(end.point.x).toBeCloseTo(10, 12);
    expect(end.point.y).toBeCloseTo(10, 12);
    // Heading −y down the arc, then −x along the line: a right turn.
    expect(pathTurnDeg(start, end)).toBeCloseTo(-90, 9);
  });

  it('starts at the other end when reversed, and turns the other way', () => {
    const path = chain(lShape, true);
    const at = pathStationAt(path, 50)!;
    // 40 along the line, then 10 into the arc: 1 radian from -90°.
    expect(at.point.x).toBeCloseTo(50 + 10 * Math.cos(1 - HALF_PI), 12);
    expect(at.point.y).toBeCloseTo(20 + 10 * Math.sin(1 - HALF_PI), 12);
    expect(pathTurnDeg(pathStationAt(path, 0)!, at)).toBeCloseTo(
      (1 * 180) / Math.PI,
      9
    );
  });

  it('refuses curves that branch or do not join', () => {
    expect(
      chainPathCurves([
        { kind: 'line', id: 'a', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { kind: 'line', id: 'b', start: { x: 20, y: 0 }, end: { x: 30, y: 0 } }
      ])
    ).toMatch(/join end to end in one chain/);
    expect(
      chainPathCurves([
        { kind: 'line', id: 'a', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { kind: 'line', id: 'b', start: { x: 10, y: 0 }, end: { x: 20, y: 0 } },
        { kind: 'line', id: 'c', start: { x: 10, y: 0 }, end: { x: 10, y: 9 } }
      ])
    ).toMatch(/branches/);
  });

  it('fits copies on an open path to its end, on a closed one short of it', () => {
    const open = chain([
      { kind: 'line', id: 'a', start: { x: 0, y: 0 }, end: { x: 40, y: 0 } }
    ]);
    expect(pathPatternFitProblem(open, 5, 10)).toBeNull();
    expect(pathPatternFitProblem(open, 6, 10)).toMatch(
      /6 copies 10 apart need 50 of path, and the path is 40 long/
    );
    const ring = chain([
      {
        kind: 'arc',
        id: 'c',
        center: { x: 0, y: 0 },
        radius: 10,
        startAngle: 0,
        sweep: 2 * Math.PI
      }
    ]);
    expect(ring.closed).toBe(true);
    expect(pathPatternFitProblem(ring, 4, (20 * Math.PI) / 4)).toBeNull();
    expect(pathPatternFitProblem(ring, 5, (20 * Math.PI) / 4)).toMatch(
      /all the way round/
    );
  });
});

describe('M02 patterns along a path: document contract', () => {
  it('stores the sketch, its curves and the orientation at schema v112', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(112);
    const { document, sketchId, ids } = pathSketch(
      box('Block', { x: 10, y: 10, z: 10 }),
      0,
      [line(0, 0, 80, 0)]
    );
    const patterned = alongPath(document, sketchId, ids, {
      targetBodyId: document.bodyOrder[0]!,
      path: {
        sketchId,
        entityIds: ids,
        reversed: true,
        orientation: 'tangent'
      }
    });
    expect(listFeaturesInOrder(patterned).at(-1)!.data).toMatchObject({
      patternKind: 'path',
      path: { sketchId, entityIds: ids, reversed: true, orientation: 'tangent' }
    });
  });

  it.each([
    [
      'no path on a path pattern',
      () => ({ path: undefined }),
      /needs its sketch and curves/
    ],
    [
      'a path on a linear pattern',
      () => ({ patternKind: 'linear' as const }),
      /Only a pattern along a path/
    ],
    [
      'a curve named twice',
      (ids: string[], sketchId: SketchId) => ({
        path: { sketchId, entityIds: [ids[0]!, ids[0]!] }
      }),
      /names each curve once/
    ],
    [
      'an unknown orientation',
      (ids: string[], sketchId: SketchId) => ({
        path: {
          sketchId,
          entityIds: ids.slice(0, 1),
          orientation: 'sideways' as never
        }
      }),
      /not a path pattern orientation/
    ],
    [
      'a point of the sketch as a curve',
      (ids: string[], sketchId: SketchId) => ({
        path: { sketchId, entityIds: [ids[1]!] }
      }),
      /no longer a line or arc of Path/
    ]
  ])('refuses %s', (_label, patch, message) => {
    const { document, sketchId, ids } = pathSketch(
      box('Block', { x: 10, y: 10, z: 10 }),
      0,
      [line(0, 0, 80, 0), { objectKind: 'point', x: 5, y: 30 }]
    );
    expect(() =>
      alongPath(document, sketchId, ids.slice(0, 1), {
        targetBodyId: document.bodyOrder[0]!,
        ...patch(ids, sketchId)
      })
    ).toThrow(message);
  });

  it('refuses a path pattern on a document that declares schema v111', () => {
    const { document, sketchId, ids } = pathSketch(
      box('Block', { x: 10, y: 10, z: 10 }),
      0,
      [line(0, 0, 80, 0)]
    );
    const old = {
      ...document,
      schemaVersion: 111
    } as unknown as ProjectDocument;
    expect(() =>
      alongPath(old, sketchId, ids, { targetBodyId: document.bodyOrder[0]! })
    ).toThrow(/require project schema v112/);
  });
});

describe('M02 patterns along a path: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  /** The plate drilled with a Ø6 through hole at (x, y). */
  async function drilled(
    x: number,
    y: number
  ): Promise<{ document: ProjectDocument; holeId: FeatureId }> {
    const document = box('Plate', PLATE);
    const derived = await adapter.syncDocument(document);
    const face = topFace(derived, last(document));
    const body = derived.bodyRepresentations[last(document)]!;
    const next = holeBody(document, {
      name: 'Hole',
      targetBodyId: last(document),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 2 * HOLE_R,
      depthMode: 'through',
      position: {
        // The face's u runs along −y.
        u: (body.bbox.min.y + body.bbox.max.y) / 2 - y,
        v: x - (body.bbox.min.x + body.bbox.max.x) / 2
      },
      positionAnchor: 'centroid'
    }).document;
    return { document: next, holeId: lastFeature(next) };
  }

  it('repeats a hole along a line, each copy named by its place', async () => {
    const { document: holed, holeId } = await drilled(10, 20);
    const { document, sketchId, ids } = pathSketch(holed, PLATE.z, [
      line(10, 20, 90, 20)
    ]);
    const patterned = alongPath(document, sketchId, ids, {
      targetBodyId: last(holed),
      sourceFeatureIds: [holeId],
      count: 4,
      spacing: 20
    });
    const derived = await adapter.syncDocument(patterned);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(patterned)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 4 * HOLE_VOLUME,
      6
    );
    expectPoints(bores(derived, last(patterned)), [
      [10, 20],
      [30, 20],
      [50, 20],
      [70, 20]
    ]);
    const names = derived.bodyRepresentations[
      last(patterned)
    ]!.topology!.faces.flatMap((face) => face.reference?.lineageName ?? [])
      .filter((name) => name.includes('hole.face.bore'))
      .sort();
    expect(names).toEqual(
      [
        'hole.face.bore',
        ...[1, 2, 3].map(
          (index) =>
            `pattern.face.instance.${index}.source.${holeId}.hole.face.bore`
        )
      ].sort()
    );
  }, 120_000);

  it('carries copies round an arc where the path bends', async () => {
    const { document: holed, holeId } = await drilled(10, 10);
    // Drawn arc-first so the path's natural start is the arc's free end;
    // reversed, it starts at the line's (10, 10), under the hole.
    const { document, sketchId, ids } = pathSketch(holed, PLATE.z, [
      arc(50, 20, 10, -90, 0),
      line(50, 10, 10, 10)
    ]);
    const patterned = alongPath(document, sketchId, ids, {
      targetBodyId: last(holed),
      sourceFeatureIds: [holeId],
      count: 3,
      spacing: 25,
      path: { sketchId, entityIds: ids, reversed: true }
    });
    const derived = await adapter.syncDocument(patterned);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(patterned)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 3 * HOLE_VOLUME,
      6
    );
    // 50 along: the 40 mm line, then 10 mm (1 radian) round the arc.
    expectPoints(bores(derived, last(patterned)), [
      [10, 10],
      [35, 10],
      [50 + 10 * Math.cos(1 - HALF_PI), 20 + 10 * Math.sin(1 - HALF_PI)]
    ]);
  }, 120_000);

  it('turns whole-body copies with the path, or only moves them', async () => {
    const block = box('Block', { x: 20, y: 4, z: 5 });
    const built = await adapter.syncDocument(block);
    const min = built.bodyRepresentations[last(block)]!.bbox.min;
    // A quarter turn about (60, -50) from 180°: it starts at (10, 0) heading
    // −y and ends at (60, −50) heading +x, a 90° turn left.
    const { document, sketchId, ids } = pathSketch(block, 0, [
      arc(min.x + 60, min.y, 50, 180, 270)
    ]);
    const quarter = (50 * Math.PI) / 2;
    const moved = alongPath(document, sketchId, ids, {
      targetBodyId: last(block),
      count: 2,
      spacing: quarter
    });
    const turned = alongPath(document, sketchId, ids, {
      targetBodyId: last(block),
      count: 2,
      spacing: quarter,
      path: { sketchId, entityIds: ids, orientation: 'tangent' }
    });
    const [plain, rotated] = [
      await adapter.syncDocument(moved),
      await adapter.syncDocument(turned)
    ];
    for (const derived of [plain, rotated]) {
      expect(derived.warnings).toEqual([]);
    }
    const box1 = plain.bodyRepresentations[last(moved)]!;
    const box2 = rotated.bodyRepresentations[last(turned)]!;
    expect(box1.volume).toBeCloseTo(800, 6);
    expect(box2.volume).toBeCloseTo(800, 6);
    // Moved only: the copy lies along x at (60, −50) from the start.
    expect(box1.bbox.max.x - min.x).toBeCloseTo(70, 6);
    expect(box1.bbox.min.y - min.y).toBeCloseTo(-50, 6);
    // Turned a quarter about the start, then moved: it lies along y.
    expect(box2.bbox.max.x - min.x).toBeCloseTo(60, 6);
    expect(box2.bbox.min.y - min.y).toBeCloseTo(-60, 6);
  }, 120_000);

  it('refuses copies past the end, and a deleted curve, by name', async () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const { document, sketchId, ids } = pathSketch(block, 0, [
      line(0, 0, 40, 0),
      line(40, 0, 40, 40)
    ]);
    const tooMany = alongPath(document, sketchId, ids, {
      targetBodyId: last(block),
      count: 6,
      spacing: 20
    });
    const long = await adapter.syncDocument(tooMany);
    expect(
      long.featureWarnings?.map((warning) => warning.message).join('\n')
    ).toMatch(/6 copies 20 apart need 100 of path, and the path is 80 long/);
    const patterned = alongPath(document, sketchId, ids, {
      targetBodyId: last(block),
      count: 2,
      spacing: 20
    });
    const gone = deleteSketchObject(patterned, {
      sketchId,
      objectId: ids[1] as never
    });
    const derived = await adapter.syncDocument(gone);
    expect(
      derived.featureWarnings?.map((warning) => warning.message).join('\n')
    ).toMatch(/no longer a line or arc of Path/);
  }, 120_000);

  it('edits the count and spacing through a feature update', async () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const { document, sketchId, ids } = pathSketch(block, 0, [
      line(0, 0, 100, 0)
    ]);
    const patterned = alongPath(document, sketchId, ids, {
      targetBodyId: last(block),
      count: 2,
      spacing: 20
    });
    const grown = updateFeature(patterned, {
      featureId: lastFeature(patterned),
      data: { featureKind: 'pattern', count: 4, spacing: 30 }
    });
    const derived = await adapter.syncDocument(grown);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(grown)]!.volume).toBeCloseTo(
      4000,
      6
    );
  }, 120_000);
});
