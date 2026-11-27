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

/** `value` moved up by `steps` units in the last place: exact bits. */
function ulpsAbove(value: number, steps: number): number {
  const bits = new BigUint64Array(new Float64Array([value]).buffer);
  bits[0] = bits[0]! + BigInt(steps);
  return new Float64Array(bits.buffer)[0]!;
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
    expectVec(oblique.origin, v(7.5, 2.5, 2.5));
  });

  it('takes parallel edges apart, and near-parallel ones', () => {
    // The block's bottom edge at x = 20 and its top edge at x = 0: x + z = 20,
    // through the four ends' centroid.
    const parallel = plane(
      [v(20, 0, 0), v(20, 20, 0)],
      [v(0, 0, 20), v(0, 20, 20)]
    );
    expectVec(parallel.normal, v(S, 0, S));
    expectVec(parallel.origin, v(10, 10, 10));
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
      expect(edgePairPlane(b, a)).toEqual({ ok: false, code: 'collinear' });
    }
    // An edge no longer than the tolerance has no line of its own.
    expect(edgePairPlane(a, [v(0, 5, 0), v(0, 5, 0)])).toEqual({
      ok: false,
      code: 'collinear'
    });
  });

  it('refuses side-by-side edges within 2t of one line and takes them past it', () => {
    // Side by side over the same span, h apart: the fitted line runs midway,
    // each end h / 2 off it, so h = 2t is the last offset that is one line.
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(10, 0, 0)];
    const beside = (h: number): [Vec3, Vec3] => [v(0, h, 0), v(10, h, 0)];
    expect(edgePairPlane(a, beside(2 * tol))).toEqual({
      ok: false,
      code: 'collinear'
    });
    const apart = plane(a, beside(2.2 * tol));
    expectVec(apart.normal, v(0, 0, 1));
    // Turned off the line by a rise of 0.5 t over the edge: still one line.
    expect(edgePairPlane(a, [v(20, 0, 0), v(30, 0.5 * tol, 0)])).toEqual({
      ok: false,
      code: 'collinear'
    });
  });

  it('refuses skew edges just past the linear tolerance and takes them at it', () => {
    // Crossing at right angles, h apart along z: each end sits h / 2 off the
    // fitted plane, so h = 2t is the last height taken. Two lines up to 2t
    // apart therefore count as meeting: the three-point plane's
    // point-to-plane tolerance, kept on purpose (re-check #3).
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(10, 0, 0)];
    const at = (h: number): [Vec3, Vec3] => [v(5, -5, h), v(5, 5, h)];
    expect(edgePairPlane(a, at(2 * tol)).ok).toBe(true);
    expect(edgePairPlane(a, at(2.2 * tol))).toEqual({
      ok: false,
      code: 'skew'
    });
    expect(edgePairPlane(at(2.2 * tol), a)).toEqual({
      ok: false,
      code: 'skew'
    });
    // Plainly skew: the block's bottom edge along y and top edge along x.
    expect(
      edgePairPlane([v(20, 0, 0), v(20, 20, 0)], [v(0, 0, 20), v(20, 0, 20)])
    ).toEqual({ ok: false, code: 'skew' });
  });

  it('gives a deterministic origin and a normal signed by its largest part', () => {
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(10, 0, 0)];
    const b: [Vec3, Vec3] = [v(0, -5, 0), v(10, -5, 0)];
    const forward = plane(a, b);
    expectVec(forward.normal, v(0, 0, 1));
    expectVec(forward.origin, v(5, -2.5, 0));
    // Neither the pick order nor either edge's direction changes a bit.
    expect(plane([a[1], a[0]], [b[1], b[0]])).toEqual(forward);
    expect(plane(b, a)).toEqual(forward);
    expect(plane([b[1], b[0]], a)).toEqual(forward);
  });

  // Review of #2261 at 3aeb4cd: each pair gave a different answer in the
  // other pick order before the edges were put in a canonical order. Two
  // answers changed again with the re-check's plane fit (2099cc5): see each.
  it('takes a 10 µm edge 0.005 off a long one as the plane its ends fit (review 1)', () => {
    // The short edge's ends lie within 5e-8 of the plane z = 0.005 y through
    // the long edge: over 10 µm its 0.005 rad tilt from that plane rises
    // 5e-8, well inside t, so the four ends fit one plane. The answer is the
    // same in either order, which the review asked for.
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(20, 0, 0)];
    const b: [Vec3, Vec3] = [v(0, 1, 0.005), v(0, 1.00001, 0.005)];
    const forward = plane(a, b);
    expect(plane(b, a)).toEqual(forward);
    const lean = Math.hypot(1, 0.005);
    expectVec(forward.normal, v(0, -0.005 / lean, 1 / lean), 7);
  });

  it('gives one normal sign for a component at the direction quantum (review 2)', () => {
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(0, 0, 1)];
    // 1.0000000000000005e-6, as the review wrote it.
    const b: [Vec3, Vec3] = [v(0, 0, 2), v(1, ulpsAbove(1e-6, 3), 2)];
    const forward = plane(a, b);
    expect(plane(b, a)).toEqual(forward);
    expect(plane([a[1], a[0]], [b[1], b[0]])).toEqual(forward);
    expect(forward.normal.y).toBeCloseTo(1, 9);
  });

  it('refuses a 1.6 µm edge across a 20 mm one as on its line (review 3)', () => {
    // Its ends lie 8e-7 from the long edge's line, inside t: every plane
    // through that line holds all four ends, so none is the plane. The
    // first review asked for +Z here; the re-check's rule (every end within
    // t of one line is collinear) decides it, the same in either order.
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(20, 0, 0)];
    const b: [Vec3, Vec3] = [v(10, -8e-7, 0), v(10, 8e-7, 0)];
    expect(edgePairPlane(a, b)).toEqual({ ok: false, code: 'collinear' });
    expect(edgePairPlane(b, a)).toEqual({ ok: false, code: 'collinear' });
  });

  // Re-check of #2261 at 2099cc5.
  it('takes an exactly coplanar, nearly parallel pair 4e4 mm long (re-check 1)', () => {
    // Every end lies exactly on z = x + y; the lines are not parallel.
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(10000, 20000, 30000)];
    const b: [Vec3, Vec3] = [
      v(1250, 10000, 11250),
      v(11250, 30000 + 2 ** -16, 41250 + 2 ** -16)
    ];
    const forward = plane(a, b);
    const third = 1 / Math.sqrt(3);
    expectVec(forward.normal, v(third, third, -third), 12);
    expect(plane(b, a)).toEqual(forward);
    for (const point of [...a, ...b]) {
      const height =
        (point.x - forward.origin.x) * forward.normal.x +
        (point.y - forward.origin.y) * forward.normal.y +
        (point.z - forward.origin.z) * forward.normal.z;
      expect(Math.abs(height)).toBeLessThan(1e-9);
    }
  });

  it('answers the same when both edges turn 180° about Z (re-check 2)', () => {
    const a: [Vec3, Vec3] = [v(0, 0, 0), v(1, 5e-8, 0)];
    const b: [Vec3, Vec3] = [v(30, 0, 0), v(40, 0, 0)];
    const turn = ([p, q]: [Vec3, Vec3]): [Vec3, Vec3] => [
      v(-p.x, -p.y, p.z),
      v(-q.x, -q.y, q.z)
    ];
    // All four ends lie within 5e-8 of the x axis: one line, either way.
    expect(edgePairPlane(a, b)).toEqual({ ok: false, code: 'collinear' });
    expect(edgePairPlane(turn(a), turn(b))).toEqual({
      ok: false,
      code: 'collinear'
    });
  });

  it('keeps a near-axis normal’s sign across the old quantum (re-check 4)', () => {
    const pair = (y: number) =>
      plane([v(0, 0, 0), v(0, 0, 1)], [v(0, 0, 2), v(1, y, 2)]);
    const at = pair(1e-6);
    const past = pair(1.0000000000005e-6);
    // Signed by the largest part (+y), so neither flips at x = ±1e-6.
    expect(at.normal.y).toBeGreaterThan(0.999);
    expect(past.normal.y).toBeGreaterThan(0.999);
    expect(Math.sign(at.normal.x)).toBe(Math.sign(past.normal.x));
    expectVec(at.normal, past.normal, 12);
  });

  it('answers the same in either order for random pairs, near-degenerate ones included', () => {
    // A seeded generator, so a failure names the pair that broke.
    let seed = 0x2261;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const point = (scale: number) =>
      v(
        (random() - 0.5) * scale,
        (random() - 0.5) * scale,
        (random() - 0.5) * scale
      );
    const along = (from: Vec3, direction: Vec3, length: number): Vec3 => {
      const size = Math.hypot(direction.x, direction.y, direction.z) || 1;
      return v(
        from.x + (direction.x / size) * length,
        from.y + (direction.y / size) * length,
        from.z + (direction.z / size) * length
      );
    };
    const statuses = new Set<string>();
    for (let index = 0; index < 4000; index += 1) {
      const kind = index % 5;
      const a0 = point(40);
      const direction = point(2);
      const a: [Vec3, Vec3] = [a0, along(a0, direction, 1 + random() * 30)];
      let b: [Vec3, Vec3];
      const shortLength = tol * (0.5 + random() * 20);
      const nudge = () => (random() - 0.5) * 4 * tol;
      if (kind === 0) {
        // Anything.
        const b0 = point(40);
        b = [b0, along(b0, point(2), random() * 30)];
      } else if (kind === 1) {
        // Short beside long, in a plane through the long one or just off it.
        const b0 = along(a0, direction, random() * 10);
        b = [
          v(b0.x + nudge(), b0.y + nudge(), b0.z + nudge()),
          along(b0, point(2), shortLength)
        ];
      } else if (kind === 2) {
        // Near-parallel, nearly on one line.
        const b0 = along(a0, direction, 5 + random() * 10);
        const tilted = v(
          direction.x + nudge(),
          direction.y + nudge(),
          direction.z + nudge()
        );
        b = [b0, along(b0, tilted, 1 + random() * 10)];
      } else if (kind === 3) {
        // Parallel and apart by a few tolerances.
        const b0 = v(a0.x + nudge(), a0.y + nudge(), a0.z + 5 * nudge());
        b = [b0, along(b0, direction, 1 + random() * 10)];
      } else {
        // Crossing, lifted by about the tolerance.
        const b0 = along(a0, direction, random() * 10);
        const lifted = v(b0.x + nudge(), b0.y + nudge(), b0.z + nudge());
        b = [lifted, along(lifted, point(2), random() * 10)];
      }
      const forward = edgePairPlane(a, b);
      const context = JSON.stringify({ a, b });
      expect(edgePairPlane(b, a), context).toEqual(forward);
      expect(edgePairPlane([a[1], a[0]], [b[1], b[0]]), context).toEqual(
        forward
      );
      statuses.add(forward.ok ? 'ok' : forward.code);
    }
    // The generator reaches every outcome.
    expect([...statuses].sort()).toEqual(['collinear', 'ok', 'skew']);
  });

  it('meets known answers for pairs built coplanar, skew or collinear, in any rigid pose and at any scale', () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    /** A uniform random rotation (unit quaternion) and a shift, at a scale. */
    const pose = (scale: number) => {
      const [u1, u2, u3] = [random(), random(), random()];
      const [qx, qy, qz, qw] = [
        Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
        Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
        Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
        Math.sqrt(u1) * Math.cos(2 * Math.PI * u3)
      ];
      const shift = v(
        (random() - 0.5) * 20 * scale,
        (random() - 0.5) * 20 * scale,
        (random() - 0.5) * 20 * scale
      );
      const turn = (p: Vec3): Vec3 => {
        // q p q⁻¹ for a unit quaternion.
        const tx = 2 * (qy * p.z - qz * p.y);
        const ty = 2 * (qz * p.x - qx * p.z);
        const tz = 2 * (qx * p.y - qy * p.x);
        return v(
          p.x + qw * tx + (qy * tz - qz * ty),
          p.y + qw * ty + (qz * tx - qx * tz),
          p.z + qw * tz + (qx * ty - qy * tx)
        );
      };
      return {
        place: (p: Vec3) => {
          const turned = turn(p);
          return v(turned.x + shift.x, turned.y + shift.y, turned.z + shift.z);
        },
        up: turn(v(0, 0, 1))
      };
    };
    const kinds = ['coplanar', 'nearly-parallel', 'skew', 'collinear'] as const;
    for (let index = 0; index < 2000; index += 1) {
      const kind = kinds[index % kinds.length]!;
      const scale = 10 ** (-3 + random() * 8);
      const length = scale * (0.5 + random() * 0.5);
      // Built in the local frame: edge A along x in z = 0.
      const a: [Vec3, Vec3] = [v(0, 0, 0), v(length, 0, 0)];
      let b: [Vec3, Vec3];
      const bLength = scale * (0.3 + random() * 0.7);
      const from = v(
        (random() - 0.5) * 2 * scale,
        scale * (0.2 + random() * 0.8) * (random() < 0.5 ? -1 : 1),
        0
      );
      const toward = (angle: number, z = 0): [Vec3, Vec3] => [
        v(from.x, from.y, z),
        v(
          from.x + bLength * Math.cos(angle),
          from.y + bLength * Math.sin(angle),
          z
        )
      ];
      if (kind === 'coplanar') {
        b = toward(random() * Math.PI);
      } else if (kind === 'nearly-parallel') {
        // 1e-6 to 1e-2 rad off A, either way round.
        const angle = 10 ** (-6 + random() * 4) * (random() < 0.5 ? -1 : 1);
        b = toward(random() < 0.5 ? angle : Math.PI + angle);
      } else if (kind === 'skew') {
        // Well across A, 5% of the scale above it.
        b = toward(0.2 + random() * (Math.PI - 0.4), 0.05 * scale);
      } else {
        const start = (random() * 3 - 1) * length;
        b = [v(start, 0, 0), v(start + bLength, 0, 0)];
      }
      for (let round = 0; round < 2; round += 1) {
        const { place, up } = pose(scale);
        const placedA: [Vec3, Vec3] = [place(a[0]), place(a[1])];
        const placedB: [Vec3, Vec3] = [place(b[0]), place(b[1])];
        const result = edgePairPlane(placedA, placedB);
        const context = JSON.stringify({ kind, scale, placedA, placedB });
        expect(edgePairPlane(placedB, placedA), context).toEqual(result);
        if (kind === 'skew') {
          expect(result, context).toEqual({ ok: false, code: 'skew' });
        } else if (kind === 'collinear') {
          expect(result, context).toEqual({ ok: false, code: 'collinear' });
        } else {
          expect(result.ok, context).toBe(true);
          if (!result.ok) continue;
          const along =
            result.normal.x * up.x +
            result.normal.y * up.y +
            result.normal.z * up.z;
          expect(Math.abs(along), context).toBeGreaterThan(1 - 1e-9);
        }
      }
    }
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
    expectVec(picked.origin, v(10, 10, 10));
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

  // Preview check of #2261 at 2099cc5: picked edges were not lit, since the
  // viewport's picked-edge highlight matches an edge by its topology id and
  // the pick did not carry one.
  it('carries each picked edge’s topology id for the picked-edge highlight', async () => {
    const start = block(blank());
    const derived = await adapter.syncDocument(start.document);
    const topology = derived.bodyRepresentations[start.bodyId]!.topology!;
    const pick = edgeBetween(derived, start.bodyId, bottom[0], bottom[1]);
    const edge = topology.edges.find(
      (candidate) => candidate.hash === pick.hash
    )!;
    expect(edge.topologyId).toBeTruthy();
    expect(pick.topologyId).toBe(edge.topologyId);
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
