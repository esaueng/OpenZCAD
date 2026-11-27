import { beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumPlane,
  addPrimitiveFeature,
  addSplitFeature,
  createProjectDocument,
  listFeaturesInOrder,
  normalizeDocument,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  edgePairPlane,
  GEOMETRY_LINEAR_TOLERANCE,
  type Vec3
} from '@openzcad/geometry';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeVertexPointSource,
  type ProjectDocument
} from '@openzcad/shared';
import {
  planeEdgeFromTopology,
  splitPlaneFromEdges,
  type PlaneEdgePick
} from '../apps/web/src/lib/inPlace/splitEdgePlane';

/**
 * M11 with R01, slice 1b (owner decision D2): Split's plane picked as two
 * straight edges, computed once at pick time and stored as Split's existing
 * numeric plane (origin and normal). No new plane kind, no link to the
 * edges, no schema change. Every fixture is a synthetic block.
 */

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const S = Math.SQRT1_2;
const tol = GEOMETRY_LINEAR_TOLERANCE;

function expectVec(actual: Vec3, expected: Vec3, digits = 12) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

function plane(first: [Vec3, Vec3], second: [Vec3, Vec3]) {
  const result = edgePairPlane(first, second);
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result;
}

describe('edgePairPlane (pure)', () => {
  it('takes crossing edges, at an end or not', () => {
    // Crossing at (5, 0, 0), away from either edge's ends.
    const flat = plane([v(0, 0, 0), v(10, 0, 0)], [v(5, -5, 0), v(5, 5, 0)]);
    expectVec(flat.normal, v(0, 0, 1));
    expectVec(flat.origin, v(5, 0, 0));
    // Meeting at the shared end (10, 0, 0), in the oblique plane x + z = 10.
    const oblique = plane(
      [v(10, 0, 0), v(10, 10, 0)],
      [v(10, 0, 0), v(0, 0, 10)]
    );
    expectVec(oblique.normal, v(S, 0, S));
    expectVec(oblique.origin, v(10, 5, 0));
  });

  it('takes parallel edges apart, and near-parallel ones', () => {
    // The block's bottom edge at x = 20 and its top edge at x = 0: x + z = 20.
    const parallel = plane(
      [v(20, 0, 0), v(20, 20, 0)],
      [v(0, 0, 20), v(0, 20, 20)]
    );
    expectVec(parallel.normal, v(S, 0, S));
    expectVec(parallel.origin, v(20, 10, 0));
    // Turned 1e-4 within z = 0: their lines meet far away, still in z = 0.
    const near = plane(
      [v(0, 0, 0), v(10, 0, 0)],
      [v(0, 5, 0), v(10, 5 + 1e-3, 0)]
    );
    expectVec(near.normal, v(0, 0, 1));
    // The same, tilted into x + z = 20.
    const tilted = plane(
      [v(20, 0, 0), v(20, 20, 0)],
      [v(0, 0, 20), v(1e-3, 20, 20 - 1e-3)]
    );
    expectVec(tilted.normal, v(S, 0, S), 9);
  });

  it('refuses edges on one line: apart, overlapping, coincident or reversed', () => {
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(10, 0, 0)];
    for (const b of [
      [v(20, 0, 0), v(30, 0, 0)],
      [v(5, 0, 0), v(15, 0, 0)],
      [v(0, 0, 0), v(10, 0, 0)],
      [v(10, 0, 0), v(0, 0, 0)]
    ] as [Vec3, Vec3][]) {
      expect(edgePairPlane(a, b)).toEqual({ ok: false, code: 'collinear' });
    }
    // An edge with no length has no line of its own.
    expect(edgePairPlane(a, [v(0, 5, 0), v(0, 5, 0)])).toEqual({
      ok: false,
      code: 'collinear'
    });
  });

  it('refuses collinear at the linear tolerance and takes just past it', () => {
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(10, 0, 0)];
    expect(edgePairPlane(a, [v(20, tol, 0), v(30, tol, 0)])).toEqual({
      ok: false,
      code: 'collinear'
    });
    const apart = edgePairPlane(a, [v(20, 2 * tol, 0), v(30, 2 * tol, 0)]);
    expect(apart.ok).toBe(true);
  });

  it('refuses skew edges just past the linear tolerance and takes them at it', () => {
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(10, 0, 0)];
    // The second edge's far end lifted out of z = 0.
    const at = edgePairPlane(a, [v(0, 10, 0), v(10, 10, tol)]);
    expect(at.ok).toBe(true);
    expect(edgePairPlane(a, [v(0, 10, 0), v(10, 10, 1.1 * tol)])).toEqual({
      ok: false,
      code: 'skew'
    });
    // Plainly skew: the block's bottom edge along y and top edge along x.
    expect(
      edgePairPlane([v(20, 0, 0), v(20, 20, 0)], [v(0, 0, 20), v(20, 0, 20)])
    ).toEqual({ ok: false, code: 'skew' });
    // A tilt shows as its rise over the edge: 1e-6 rad over 10 is 1e-5.
    expect(
      edgePairPlane(a, [v(0, 10, 0), v(10, 10, 10 * Math.sin(1e-6))]).ok
    ).toBe(false);
  });

  it('gives a deterministic origin and a canonical normal', () => {
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(10, 0, 0)];
    const b: [Vec3, Vec3] = [v(0, -5, 0), v(10, -5, 0)];
    const forward = plane(a, b);
    // The raw cross product points down -z; the stored normal is canonical.
    expectVec(forward.normal, v(0, 0, 1));
    // Neither edge's own direction matters.
    const flipped = plane([a[1], a[0]], [b[1], b[0]]);
    expect(flipped).toEqual(forward);
    // The pick order moves only the origin, to the first edge's middle.
    const swapped = plane(b, a);
    expectVec(swapped.normal, forward.normal);
    expectVec(forward.origin, v(5, 0, 0));
    expectVec(swapped.origin, v(5, -5, 0));
  });

  it('throws on a point that is not finite', () => {
    expect(() =>
      edgePairPlane([v(0, 0, 0), v(Number.NaN, 0, 0)], [v(0, 1, 0), v(1, 1, 0)])
    ).toThrow(/finite/);
  });
});

function blank(): ProjectDocument {
  return createProjectDocument('Edge planes', toUserId('user_edge_planes'));
}

function block(document: ProjectDocument, depth = 20) {
  const next = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth }
  });
  return { document: next, bodyId: next.bodyOrder.at(-1)! };
}

const close = (a: Vec3, b: Vec3) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-9;

/** The straight edge between two corners, read as the viewport pick reads it. */
function edgeBetween(
  derived: DerivedState,
  bodyId: BodyId,
  from: Vec3,
  to: Vec3
): PlaneEdgePick {
  const topology = derived.bodyRepresentations[bodyId]!.topology;
  for (const edge of topology?.edges ?? []) {
    const pick = planeEdgeFromTopology(topology, bodyId, edge.hash);
    if (!pick || 'refused' in pick) continue;
    const [a, b] = pick.ends;
    if ((close(a, from) && close(b, to)) || (close(a, to) && close(b, from))) {
      return pick;
    }
  }
  throw new Error('No such edge.');
}

/** End `end` of the edge between two corners, as an R01 vertex source. */
function vertexOf(
  derived: DerivedState,
  bodyId: BodyId,
  point: Vec3,
  other: Vec3
): EdgeVertexPointSource {
  const pick = edgeBetween(derived, bodyId, point, other);
  const edge = derived.bodyRepresentations[bodyId]!.topology!.edges.find(
    (candidate) => candidate.hash === pick.hash
  )!;
  const reference = edge.reference!;
  const quantum = (value: number) =>
    Math.round(value / GEOMETRY_LINEAR_TOLERANCE);
  const [a, b] = [point, other].map((value) =>
    [value.x, value.y, value.z].map(quantum)
  ) as [number[], number[]];
  let order = 0;
  for (let index = 0; index < 3 && order === 0; index += 1)
    order = Math.sign(a[index]! - b[index]!);
  return {
    type: 'edge-vertex',
    bodyId,
    edgeReference: reference,
    end: order < 0 ? 0 : 1
  };
}

function volumes(
  derived: DerivedState,
  split: { bodyId: BodyId; secondBodyId: BodyId }
): [number, number] {
  return [
    derived.bodyRepresentations[split.bodyId]!.volume,
    derived.bodyRepresentations[split.secondBodyId]!.volume
  ];
}

describe('Split on the plane through two block edges (exact)', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  // The 20 mm block [0, 20]³. Its bottom edge at x = 20 (along y) and its
  // top edge at x = 0 (along y) are parallel and apart: the plane x + z = 20
  // halves it into two triangular prisms of 20 · 20²/2 = 4000 each.
  const bottom = [v(20, 0, 0), v(20, 20, 0)] as const;
  const top = [v(0, 0, 20), v(0, 20, 20)] as const;

  it('splits on the R01 three-point plane through those edges into 4000 and 4000', async () => {
    const start = block(blank());
    const derived = await adapter.syncDocument(start.document);
    const planed = addDatumPlane(start.document, {
      name: 'Diagonal',
      definition: {
        kind: 'three-point',
        points: [
          vertexOf(derived, start.bodyId, bottom[0], bottom[1]),
          vertexOf(derived, start.bodyId, bottom[1], bottom[0]),
          vertexOf(derived, start.bodyId, top[0], top[1])
        ]
      }
    });
    const split = addSplitFeature(planed.document, {
      name: 'Split',
      targetBodyId: start.bodyId,
      plane: { type: 'datum', datumFeatureId: planed.featureId }
    });
    const built = await adapter.syncDocument(split.document);
    expect(built.warnings).toEqual([]);
    expectVec(built.datumFrames![planed.featureId]!.normal, v(S, 0, S));
    const [first, second] = volumes(built, split);
    expect(first).toBeCloseTo(4000, 6);
    expect(second).toBeCloseTo(4000, 6);
  });

  it('stores the picked pair as plain numbers and splits into 4000 and 4000', async () => {
    const start = block(blank());
    const derived = await adapter.syncDocument(start.document);
    const picked = splitPlaneFromEdges(
      edgeBetween(derived, start.bodyId, bottom[0], bottom[1]),
      edgeBetween(derived, start.bodyId, top[0], top[1])
    );
    if ('refused' in picked) throw new Error(picked.refused);
    expectVec(picked.normal, v(S, 0, S));
    expectVec(picked.origin, v(20, 10, 0));
    const split = addSplitFeature(start.document, {
      name: 'Split',
      targetBodyId: start.bodyId,
      plane: picked
    });
    // Split's existing numeric plane: no datum, no edge, the current schema.
    const data = listFeaturesInOrder(split.document).at(-1)!.data;
    expect(data).toMatchObject({
      featureKind: 'split',
      plane: { origin: picked.origin, normal: picked.normal }
    });
    expect(JSON.stringify(data)).not.toMatch(/edge/i);
    expect(split.document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const saved = JSON.parse(JSON.stringify(split.document)) as ProjectDocument;
    expect(normalizeDocument(saved)).toEqual(split.document);

    const built = await adapter.syncDocument(split.document);
    expect(built.warnings).toEqual([]);
    const [first, second] = volumes(built, split);
    expect(first).toBeCloseTo(4000, 6);
    expect(second).toBeCloseTo(4000, 6);
  });

  it('keeps the normal’s side: slid 5√2 along it, the plane x + z = 30 leaves 1000 and 7000', async () => {
    const start = block(blank());
    const derived = await adapter.syncDocument(start.document);
    const picked = splitPlaneFromEdges(
      edgeBetween(derived, start.bodyId, top[0], top[1]),
      edgeBetween(derived, start.bodyId, bottom[0], bottom[1])
    );
    if ('refused' in picked) throw new Error(picked.refused);
    // Picked the other way round: the same canonical normal.
    expectVec(picked.normal, v(S, 0, S));
    const slide = 5 * Math.SQRT2;
    const split = addSplitFeature(start.document, {
      name: 'Split',
      targetBodyId: start.bodyId,
      plane: {
        origin: {
          x: picked.origin.x + picked.normal.x * slide,
          y: picked.origin.y + picked.normal.y * slide,
          z: picked.origin.z + picked.normal.z * slide
        },
        normal: picked.normal
      }
    });
    const built = await adapter.syncDocument(split.document);
    expect(built.warnings).toEqual([]);
    // The feature's own body is the half the normal points into: x + z ≥ 30,
    // a prism of 20 · 10²/2.
    const [positive, negative] = volumes(built, split);
    expect(positive).toBeCloseTo(1000, 6);
    expect(negative).toBeCloseTo(7000, 6);
  });

  it('does not follow the edges: deepening the block keeps the stored plane', async () => {
    const start = block(blank());
    const derived = await adapter.syncDocument(start.document);
    const picked = splitPlaneFromEdges(
      edgeBetween(derived, start.bodyId, bottom[0], bottom[1]),
      edgeBetween(derived, start.bodyId, top[0], top[1])
    );
    if ('refused' in picked) throw new Error(picked.refused);
    const split = addSplitFeature(start.document, {
      name: 'Split',
      targetBodyId: start.bodyId,
      plane: picked
    });
    const primitive = listFeaturesInOrder(split.document)[0]!;
    const deeper = updateFeature(split.document, {
      featureId: primitive.featureId,
      data: {
        featureKind: 'primitive',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 30 }
      }
    });
    const built = await adapter.syncDocument(deeper);
    expect(built.warnings).toEqual([]);
    // Still x + z = 20 on the 20 × 20 × 30 block: x + z ≥ 20 is the 20 × 30
    // rectangle less the 20²/2 corner, times 20: 8000, and 4000 below.
    const [positive, negative] = volumes(built, split);
    expect(positive).toBeCloseTo(8000, 6);
    expect(negative).toBeCloseTo(4000, 6);
  });

  it('refuses a skew pair and a curved edge on real topology', async () => {
    const start = block(blank());
    const withPost = addPrimitiveFeature(start.document, {
      name: 'Post',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 10 }
    });
    const postId = withPost.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(withPost);
    // Bottom edge along y at x = 20, top edge along x at y = 0: skew.
    expect(
      splitPlaneFromEdges(
        edgeBetween(derived, start.bodyId, bottom[0], bottom[1]),
        edgeBetween(derived, start.bodyId, v(0, 0, 20), v(20, 0, 20))
      )
    ).toEqual({ refused: 'skew' });
    const topology = derived.bodyRepresentations[postId]!.topology!;
    const rim = topology.edges.find(
      (edge) => edge.curve?.type?.toUpperCase() === 'CIRCLE'
    );
    expect(rim).toBeDefined();
    expect(planeEdgeFromTopology(topology, postId, rim!.hash)).toEqual({
      refused: 'curved-edge'
    });
  });
});
