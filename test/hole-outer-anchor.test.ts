import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  holeBody,
  HOLE_OUTER_CENTROID_SCHEMA_VERSION,
  listFeaturesInOrder,
  normalizeDocument,
  updateFeature,
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
  type ProjectDocument
} from '@openzcad/shared';

/**
 * QA15-2D-01 (M01): a typed hole position is measured from the centroid of
 * the entry face's OUTER boundary loop, so drilling or resizing another hole
 * in that face never moves it.
 *
 * It used to be measured from the face's full area centroid, which every
 * earlier hole pulls away from itself: four holes typed at 10 mm insets on a
 * 100 × 60 plate landed up to a quarter of a millimetre off. Holes saved
 * before the outer anchor existed keep the anchor they were drilled against,
 * drift and all, because moving them on load would change saved parts.
 *
 * Every expectation is a closed form on a plate whose corner stands at the
 * origin, so its top face's outer centroid is (50, 30). On that face U runs
 * along world −Y and V along +X (see `holePositionAxes`).
 */

const PLATE = { x: 100, y: 60, z: 10 };
const HOLE_R = 3;
const INSET = 10;
/** The four corner holes, in the order they are typed. */
const CORNERS: readonly [number, number][] = [
  [INSET, INSET],
  [PLATE.x - INSET, INSET],
  [PLATE.x - INSET, PLATE.y - INSET],
  [INSET, PLATE.y - INSET]
];
const MIDDLE: [number, number] = [PLATE.x / 2, PLATE.y / 2];

/** The typed (u, v) of a world (x, y) measured from `from` on the top face. */
function typed([x, y]: [number, number], from: [number, number]) {
  return { u: from[1] - y, v: x - from[0] };
}

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;

function plate(): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Plate', toUserId('user_hole_outer_anchor')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: PLATE.x, height: PLATE.y, depth: PLATE.z }
    }
  );
}

function topFace(derived: DerivedState, bodyId: BodyId) {
  const body = derived.bodyRepresentations[bodyId]!;
  return body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      (face.geometry.normal?.z ?? 0) > 0.999 &&
      Math.abs(face.geometry.center.z - body.bbox.max.z) < 1e-6
  )!;
}

/** World (x, y) of every bore of `radius`, nearest-first to each of `near`. */
function boresNear(
  derived: DerivedState,
  bodyId: BodyId,
  near: readonly [number, number][],
  radius = HOLE_R
): [number, number][] {
  const found = derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs((face.geometry.radius ?? 0) - radius) < 1e-6
  ).map((face) => {
    const at = face.geometry!.axisStart!;
    return [at.x, at.y] as [number, number];
  });
  expect(found).toHaveLength(near.length);
  return near.map(([x, y]) =>
    found.reduce((best, candidate) =>
      Math.hypot(candidate[0] - x, candidate[1] - y) <
      Math.hypot(best[0] - x, best[1] - y)
        ? candidate
        : best
    )
  );
}

function warningText(derived: DerivedState): string {
  return [
    ...derived.warnings,
    ...(derived.featureWarnings ?? []).map((warning) => warning.message)
  ].join('\n');
}

describe('QA15-2D-01: hole positions measured from the outer boundary', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  /**
   * Drills the four corner holes one after another, each on the top face of
   * the body the previous one left, typed as `position` says.
   */
  async function drillCorners(
    anchor: HoleInput['positionAnchor'],
    position: (
      corner: [number, number],
      index: number
    ) => {
      u: number;
      v: number;
    }
  ): Promise<{ document: ProjectDocument; holeIds: FeatureId[] }> {
    let document = plate();
    const holeIds: FeatureId[] = [];
    for (const [index, corner] of CORNERS.entries()) {
      const derived = await adapter.syncDocument(document);
      expect(warningText(derived)).toBe('');
      const face = topFace(derived, last(document));
      document = holeBody(document, {
        name: `Hole ${index + 1}`,
        targetBodyId: last(document),
        faceHash: face.hash,
        ...(face.reference ? { faceReference: face.reference } : {}),
        style: 'simple',
        diameter: 2 * HOLE_R,
        depthMode: 'through',
        position: position(corner, index),
        ...(anchor ? { positionAnchor: anchor } : {})
      }).document;
      holeIds.push(lastFeature(document));
    }
    return { document, holeIds };
  }

  it('reports the outer loop centroid, unmoved by a hole in the face', async () => {
    const { document } = await drillCorners('outer-centroid', (corner) =>
      typed(corner, MIDDLE)
    );
    const derived = await adapter.syncDocument(document);
    const geometry = topFace(derived, last(document)).geometry!;
    expect(geometry.outerCentroid!.x).toBeCloseTo(MIDDLE[0], 9);
    expect(geometry.outerCentroid!.y).toBeCloseTo(MIDDLE[1], 9);
    expect(geometry.outerCentroid!.z).toBeCloseTo(PLATE.z, 9);
  });

  it('drills four 10 mm-inset holes exactly where they were typed', async () => {
    const { document } = await drillCorners('outer-centroid', (corner) =>
      typed(corner, MIDDLE)
    );
    expect(document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(() => assertDocumentContentSchema(document)).not.toThrow();
    const derived = await adapter.syncDocument(document);
    expect(warningText(derived)).toBe('');
    const at = boresNear(derived, last(document), CORNERS);
    for (const [index, [x, y]] of CORNERS.entries()) {
      expect(at[index]![0]).toBeCloseTo(x, 6);
      expect(at[index]![1]).toBeCloseTo(y, 6);
    }
  });

  it('leaves later holes where they are when an earlier one is resized', async () => {
    const { document, holeIds } = await drillCorners(
      'outer-centroid',
      (corner) => typed(corner, MIDDLE)
    );
    const resized = updateFeature(document, {
      featureId: holeIds[0]!,
      data: { featureKind: 'hole', diameter: 10 }
    });
    const derived = await adapter.syncDocument(resized);
    expect(warningText(derived)).toBe('');
    const [first] = boresNear(derived, last(resized), [CORNERS[0]!], 5);
    expect(first![0]).toBeCloseTo(CORNERS[0]![0], 6);
    expect(first![1]).toBeCloseTo(CORNERS[0]![1], 6);
    const later = CORNERS.slice(1);
    const at = boresNear(derived, last(resized), later);
    for (const [index, [x, y]] of later.entries()) {
      expect(at[index]![0]).toBeCloseTo(x, 6);
      expect(at[index]![1]).toBeCloseTo(y, 6);
    }
  });

  it('refuses the outer anchor on a document older than its schema', async () => {
    const { document } = await drillCorners('outer-centroid', (corner) =>
      typed(corner, MIDDLE)
    );
    expect(() =>
      assertDocumentContentSchema({
        ...document,
        schemaVersion: HOLE_OUTER_CENTROID_SCHEMA_VERSION - 1
      } as unknown as ProjectDocument)
    ).toThrow(
      new RegExp(
        `require project schema v${HOLE_OUTER_CENTROID_SCHEMA_VERSION}`
      )
    );
  });

  it('keeps holes saved before the outer anchor exactly where they were', async () => {
    // Byte-for-byte what the app saved before this schema: every new hole
    // marked `centroid`, typed from the plate's middle, so each later one
    // lands off by the pull of the holes drilled before it.
    const { document: drilled } = await drillCorners('centroid', (corner) =>
      typed(corner, MIDDLE)
    );
    const saved = JSON.parse(
      JSON.stringify({
        ...drilled,
        derived: undefined,
        schemaVersion: HOLE_OUTER_CENTROID_SCHEMA_VERSION - 1
      })
    ) as ProjectDocument;
    const opened = normalizeDocument(saved);
    expect(opened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    // Opening never rewrites the anchor a hole was drilled against.
    for (const feature of listFeaturesInOrder(opened)) {
      if (feature.data.featureKind !== 'hole') continue;
      expect(feature.data.positionAnchor).toBe('centroid');
    }

    // Where each hole was drilled: the plate's area centroid with every
    // earlier hole taken out of it, plus the typed offset.
    const area = PLATE.x * PLATE.y;
    const bore = Math.PI * HOLE_R ** 2;
    const expected: [number, number][] = [];
    for (const corner of CORNERS) {
      const removed = expected.length * bore;
      const anchor: [number, number] = [0, 1].map(
        (axis) =>
          (area * MIDDLE[axis]! -
            bore * expected.reduce((sum, point) => sum + point[axis]!, 0)) /
          (area - removed)
      ) as [number, number];
      expected.push([
        anchor[0] + (corner[0] - MIDDLE[0]),
        anchor[1] + (corner[1] - MIDDLE[1])
      ]);
    }
    // The drift is real, so this proves the legacy anchor is still read.
    expect(
      Math.hypot(
        expected[3]![0] - CORNERS[3]![0],
        expected[3]![1] - CORNERS[3]![1]
      )
    ).toBeGreaterThan(0.05);

    const derived = await adapter.syncDocument(opened);
    expect(warningText(derived)).toBe('');
    const at = boresNear(derived, last(opened), expected);
    for (const [index, [x, y]] of expected.entries()) {
      // The circles are inscribed polygons in the centroid integral, which
      // leaves a residual far below this.
      expect(at[index]![0]).toBeCloseTo(x, 4);
      expect(at[index]![1]).toBeCloseTo(y, 4);
    }
  });
});
