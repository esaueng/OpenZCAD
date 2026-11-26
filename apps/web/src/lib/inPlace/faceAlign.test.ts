import { describe, expect, it } from 'vitest';
import type { BodyId, Vector3 } from '@openzcad/shared';
import {
  FACE_ALIGN_PARALLEL_SINE,
  FACE_ALIGN_REFUSALS,
  faceAlignPlacement,
  faceAlignSpec,
  halfTurnAxis,
  placeDirection,
  placePoint,
  rotationFromDegrees,
  committedFaceForPreviewPick,
  previewedMove,
  smallestTurn,
  unmovedFaceGeometry,
  type MatchableFace,
  type PlainMove
} from './faceAlign';
import {
  IN_PLACE_TOOL_SPECS,
  type FacePick,
  type InPlaceContext,
  type InPlaceSlots
} from './tools';

// Placements carry the stored turn: Move's Euler degrees, rounded to 1e-9°
// (about 2e-11 rad), so they agree to ten places, not twelve.
const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vector3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vector3): Vector3 => {
  const l = len(a);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const neg = (a: Vector3): Vector3 => ({ x: -a.x, y: -a.y, z: -a.z });
const apply = (r: readonly [Vector3, Vector3, Vector3], v: Vector3) => ({
  x: dot(r[0], v),
  y: dot(r[1], v),
  z: dot(r[2], v)
});

function expectVector(actual: Vector3, expected: Vector3, digits = 10) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

/** A proper rotation: orthonormal rows, determinant +1. */
function expectRotation(r: readonly [Vector3, Vector3, Vector3]) {
  for (const [i, a] of r.entries()) {
    for (const [j, b] of r.entries()) {
      expect(dot(a, b)).toBeCloseTo(i === j ? 1 : 0, 10);
    }
  }
  const det =
    r[0].x * (r[1].y * r[2].z - r[1].z * r[2].y) -
    r[0].y * (r[1].x * r[2].z - r[1].z * r[2].x) +
    r[0].z * (r[1].x * r[2].y - r[1].y * r[2].x);
  expect(det).toBeCloseTo(1, 12);
}

/** The angle a rotation turns by, from its trace. */
const turnAngle = (r: readonly [Vector3, Vector3, Vector3]) =>
  Math.acos(Math.max(-1, Math.min(1, (r[0].x + r[1].y + r[2].z - 1) / 2)));

const Z = { x: 0, y: 0, z: 1 };

/** The distance of a point from the plane through `on` along `normal`. */
const above = (point: Vector3, on: Vector3, normal: Vector3) =>
  dot(
    { x: point.x - on.x, y: point.y - on.y, z: point.z - on.z },
    unit(normal)
  );

describe('Align face to face: the transform (M10 slice 5b)', () => {
  it('does not turn a face whose normal already opposes the target', () => {
    // A box's bottom (−Z) onto another's top (+Z) 7 above it.
    const placement = faceAlignPlacement({
      moving: { normal: neg(Z), point: { x: 3, y: 4, z: 12 } },
      target: { normal: Z, point: { x: -20, y: 5, z: 7 } }
    })!;
    expect(placement.rotationDeg).toEqual({ x: 0, y: 0, z: 0 });
    // Straight down along the target normal only: x and y stay.
    expectVector(placement.translation, { x: 0, y: 0, z: -5 });
    const landed = placePoint(placement, { x: 3, y: 4, z: 12 });
    expectVector(landed, { x: 3, y: 4, z: 7 });
  });

  it('turns half a turn about a documented in-plane axis when the normals match', () => {
    // A top (+Z) onto another top (+Z): the face must turn over.
    const placement = faceAlignPlacement({
      moving: { normal: Z, point: { x: 1, y: 2, z: 3 } },
      target: { normal: Z, point: { x: 0, y: 0, z: 10 } }
    })!;
    expectRotation(placement.rotation);
    expect(turnAngle(placement.rotation)).toBeCloseTo(Math.PI, 9);
    // +Z turns about +Y: X flips, Y stays, Z flips.
    expectVector(placeDirection(placement, { x: 1, y: 0, z: 0 }), {
      x: -1,
      y: 0,
      z: 0
    });
    expectVector(placeDirection(placement, { x: 0, y: 1, z: 0 }), {
      x: 0,
      y: 1,
      z: 0
    });
    expectVector(placeDirection(placement, Z), neg(Z));
    // The face's own point lands on the target plane; nothing slides.
    expectVector(placePoint(placement, { x: 1, y: 2, z: 3 }), {
      x: 1,
      y: 2,
      z: 10
    });
  });

  it('pins the half-turn axis for each principal normal', () => {
    expectVector(halfTurnAxis(Z), { x: 0, y: 1, z: 0 });
    expectVector(halfTurnAxis(neg(Z)), { x: 0, y: -1, z: 0 });
    expectVector(halfTurnAxis({ x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: 1 });
    expectVector(halfTurnAxis({ x: 0, y: 1, z: 0 }), { x: 0, y: 0, z: -1 });
    // Always in the face's plane.
    const oblique = unit({ x: 0.3, y: -0.5, z: 0.8 });
    expect(dot(halfTurnAxis(oblique), oblique)).toBeCloseTo(0, 14);
  });

  it('takes the smallest turn between oblique normals and lands on the plane', () => {
    const moving = unit({ x: 1, y: 2, z: 2 });
    const target = unit({ x: -2, y: 1, z: 3 });
    const point = { x: 5, y: -1, z: 4 };
    const on = { x: 10, y: 20, z: -3 };
    const placement = faceAlignPlacement({
      moving: { normal: moving, point },
      target: { normal: target, point: on }
    })!;
    expectRotation(placement.rotation);
    // The turned normal opposes the target's.
    expectVector(placeDirection(placement, moving), neg(target));
    // Smallest: exactly the angle between the normal and the wanted one.
    expect(turnAngle(placement.rotation)).toBeCloseTo(
      Math.acos(dot(moving, neg(target))),
      10
    );
    // And about their common perpendicular, which it leaves alone.
    const axis = unit({
      x: moving.y * -target.z - moving.z * -target.y,
      y: moving.z * -target.x - moving.x * -target.z,
      z: moving.x * -target.y - moving.y * -target.x
    });
    expectVector(placeDirection(placement, axis), axis);
    // The motion is along the target normal only, and the face is flush.
    const t = placement.translation;
    expect(len(t)).toBeCloseTo(Math.abs(dot(t, target)), 12);
    expect(above(placePoint(placement, point), on, target)).toBeCloseTo(0, 12);
    // Another point of the moving face lands on the same plane.
    const inFace = { x: point.x + 2, y: point.y - 1, z: point.z };
    expect(dot({ x: 2, y: -1, z: 0 }, moving)).toBeCloseTo(0, 12);
    expect(above(placePoint(placement, inFace), on, target)).toBeCloseTo(0, 10);
  });

  it('stores a turn the kernel composes back to the same rotation', () => {
    const turn = smallestTurn(
      unit({ x: 1, y: 2, z: 2 }),
      unit({ x: 2, y: -1, z: -3 })
    );
    const placement = faceAlignPlacement({
      moving: { normal: unit({ x: 1, y: 2, z: 2 }), point: Z },
      target: { normal: unit({ x: -2, y: 1, z: 3 }), point: Z }
    })!;
    const recomposed = rotationFromDegrees(placement.rotationDeg);
    for (const i of [0, 1, 2] as const) {
      expectVector(recomposed[i], turn[i], 9);
    }
  });

  it('with Flip, makes the faces point the same way in one plane', () => {
    const point = { x: 0, y: 0, z: 5 };
    // A top onto a top with Flip: no turn at all.
    const same = faceAlignPlacement({
      moving: { normal: Z, point },
      target: { normal: Z, point: { x: 9, y: 9, z: 2 } },
      flip: true
    })!;
    expect(same.rotationDeg).toEqual({ x: 0, y: 0, z: 0 });
    expectVector(same.translation, { x: 0, y: 0, z: -3 });
    // A side (+X) onto a top with Flip: a quarter turn, facing +Z.
    const side = faceAlignPlacement({
      moving: { normal: { x: 1, y: 0, z: 0 }, point },
      target: { normal: Z, point: { x: 9, y: 9, z: 2 } },
      flip: true
    })!;
    expectVector(placeDirection(side, { x: 1, y: 0, z: 0 }), Z);
    expect(turnAngle(side.rotation)).toBeCloseTo(Math.PI / 2, 12);
    expect(placePoint(side, point).z).toBeCloseTo(2, 12);
  });

  it('leaves a signed gap out of the target face with Offset', () => {
    const base = {
      moving: { normal: neg(Z), point: { x: 0, y: 0, z: 30 } },
      target: { normal: Z, point: { x: 0, y: 0, z: 10 } }
    };
    for (const offset of [0, 2.5, -1.25]) {
      const placement = faceAlignPlacement({ ...base, offset })!;
      expect(placePoint(placement, base.moving.point).z).toBeCloseTo(
        10 + offset,
        12
      );
    }
    // With Flip the gap is still measured out of the target face.
    const flipped = faceAlignPlacement({
      moving: { normal: Z, point: { x: 0, y: 0, z: 30 } },
      target: base.target,
      flip: true,
      offset: 4
    })!;
    expect(placePoint(flipped, { x: 0, y: 0, z: 30 }).z).toBeCloseTo(14, 12);
  });

  it('snaps to the half turn only inside the tolerance at 180°', () => {
    const point = { x: 0, y: 0, z: 0 };
    const target = { normal: Z, point: { x: 0, y: 0, z: 1 } };
    // Just inside: within 1e-10 rad of the same direction as the target
    // (which is half a turn from where face to face wants it).
    const inside = 1e-10;
    expect(Math.sin(inside)).toBeLessThan(FACE_ALIGN_PARALLEL_SINE);
    const near = faceAlignPlacement({
      moving: {
        normal: { x: Math.sin(inside), y: 0, z: Math.cos(inside) },
        point
      },
      target
    })!;
    const exact = faceAlignPlacement({ moving: { normal: Z, point }, target })!;
    // The same half turn about +Y, to within the tilt.
    for (const i of [0, 1, 2] as const) {
      expectVector(near.rotation[i], exact.rotation[i], 9);
    }
    expectVector(placeDirection(near, { x: 0, y: 1, z: 0 }), {
      x: 0,
      y: 1,
      z: 0
    });
    // Just outside: the smallest turn, about the near-coincident pair's own
    // perpendicular, and still exact on the normal.
    const outside = 1e-7;
    expect(Math.sin(outside)).toBeGreaterThan(FACE_ALIGN_PARALLEL_SINE);
    const tilted = { x: 0, y: Math.sin(outside), z: Math.cos(outside) };
    const far = faceAlignPlacement({
      moving: { normal: tilted, point },
      target
    })!;
    expectRotation(far.rotation);
    // The turn itself is exact on the normal; the stored Euler form to 1e-11.
    expectVector(apply(smallestTurn(tilted, neg(Z)), tilted), neg(Z), 14);
    expectVector(placeDirection(far, tilted), neg(Z));
    // It turns about X (perpendicular to both), not the snapped Y axis.
    expectVector(
      placeDirection(far, { x: 1, y: 0, z: 0 }),
      {
        x: 1,
        y: 0,
        z: 0
      },
      9
    );
    // And the opposite case near 0°: no turn inside the tolerance.
    const almost = faceAlignPlacement({
      moving: {
        normal: { x: Math.sin(inside), y: 0, z: -Math.cos(inside) },
        point
      },
      target
    })!;
    expect(almost.rotationDeg).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('refuses a missing normal', () => {
    expect(
      faceAlignPlacement({
        moving: { normal: { x: 0, y: 0, z: 0 }, point: Z },
        target: { normal: Z, point: Z }
      })
    ).toBeNull();
  });
});

describe('the Align command', () => {
  const MOVING = 'body_moving' as BodyId;
  const TARGET = 'body_target' as BodyId;
  const face = (
    bodyId: BodyId,
    hash: number,
    normal: Vector3,
    centroid: Vector3,
    surfaceType = 'Plane'
  ): FacePick => ({
    bodyId,
    hash,
    topologyId: `${bodyId}:${hash}`,
    surfaceType,
    normal,
    centroid
  });
  const slots = (faces: FacePick[]): InPlaceSlots => ({
    profiles: [],
    axis: null,
    path: [],
    guide: [],
    faces,
    bodies: [],
    plane: null,
    edges: [],
    refs: [],
    image: null
  });
  const ctx = {
    liveBodyIds: () => [MOVING, TARGET]
  } as unknown as InPlaceContext;
  const bottom = face(MOVING, 1, neg(Z), { x: 5, y: 5, z: 20 });
  const top = face(TARGET, 2, Z, { x: 0, y: 0, z: 10 });

  it('is registered as an in-place tool that takes two faces', () => {
    expect(IN_PLACE_TOOL_SPECS.align).toBe(faceAlignSpec);
    expect(faceAlignSpec.faceMode).toBe('pair');
  });

  it('asks for the moving face, then the target, then the offset', () => {
    expect(faceAlignSpec.hint(slots([]), {}, ctx)).toMatch(/body to move/);
    expect(faceAlignSpec.hint(slots([bottom]), {}, ctx)).toMatch(/target/);
    expect(faceAlignSpec.ready(slots([bottom]), {}, ctx)).toBe(false);
    expect(faceAlignSpec.ready(slots([bottom, top]), {}, ctx)).toBe(true);
  });

  it('builds a Move of the moving body down onto the target', () => {
    const request = faceAlignSpec.request(
      slots([bottom, top]),
      { offset: 0 },
      { flip: 'no' },
      ctx,
      { offset: 0 }
    );
    expect(request).toEqual({
      tool: 'transform',
      targetBodyId: MOVING,
      translation: { x: 0, y: 0, z: -10 }
    });
    const gapped = faceAlignSpec.request(
      slots([bottom, top]),
      { offset: 1.5 },
      { flip: 'no' },
      ctx,
      { offset: 1.5 }
    );
    expect(gapped).toMatchObject({ translation: { x: 0, y: 0, z: -8.5 } });
  });

  it('stores a turn about the moving face when one is needed', () => {
    const side = face(MOVING, 3, { x: 1, y: 0, z: 0 }, { x: 8, y: 2, z: 15 });
    const request = faceAlignSpec.request(
      slots([side, top]),
      { offset: 0 },
      { flip: 'no' },
      ctx,
      { offset: 0 }
    );
    expect(request).toMatchObject({
      tool: 'transform',
      targetBodyId: MOVING,
      pivot: { x: 8, y: 2, z: 15 },
      translation: { x: 0, y: 0, z: -5 }
    });
    if (request?.tool !== 'transform') throw new Error('No transform.');
    const turned = apply(rotationFromDegrees(request.rotationDeg as Vector3), {
      x: 1,
      y: 0,
      z: 0
    });
    expectVector(turned, neg(Z), 9);
  });

  it('refuses a curved face, and a target on the moving body', () => {
    const wall = face(MOVING, 4, Z, Z, 'Cylinder');
    expect(faceAlignSpec.refuseFace!(slots([]), wall, ctx)).toBe(
      FACE_ALIGN_REFUSALS['not-planar']
    );
    const otherSide = face(MOVING, 5, Z, { x: 5, y: 5, z: 30 });
    expect(faceAlignSpec.refuseFace!(slots([bottom]), otherSide, ctx)).toBe(
      FACE_ALIGN_REFUSALS['same-body']
    );
    // The moving face clicked again is taken back, not refused.
    expect(faceAlignSpec.refuseFace!(slots([bottom]), bottom, ctx)).toBeNull();
    expect(faceAlignSpec.refuseFace!(slots([bottom]), top, ctx)).toBeNull();
    // A pair already on one body (a seeded selection) builds nothing.
    expect(faceAlignSpec.ready(slots([bottom, otherSide]), {}, ctx)).toBe(
      false
    );
    expect(faceAlignSpec.hint(slots([bottom, otherSide]), {}, ctx)).toBe(
      FACE_ALIGN_REFUSALS['same-body']
    );
    expect(
      faceAlignSpec.request(slots([bottom, otherSide]), {}, {}, ctx, {})
    ).toBeNull();
  });

  it('refuses a body a later feature used up, as Move does', () => {
    const used = face('body_used' as BodyId, 6, Z, Z);
    expect(faceAlignSpec.refuseFace!(slots([]), used, ctx)).toBe(
      FACE_ALIGN_REFUSALS['not-live']
    );
  });

  it('puts the offset handle on the target face, along its normal', () => {
    const handles = faceAlignSpec.handles(
      slots([bottom, top]),
      { offset: 0 },
      ctx,
      {}
    );
    expect(handles).toEqual([
      expect.objectContaining({
        valueId: 'offset',
        kind: 'linear',
        params: { origin: { x: 0, y: 0, z: 10 }, direction: Z }
      })
    ]);
  });

  it('says every refusal in plain words, never kernel text', () => {
    for (const sentence of Object.values(FACE_ALIGN_REFUSALS)) {
      expect(sentence).not.toMatch(/kernel|remus|BRep|error/i);
      expect(sentence.length).toBeGreaterThan(10);
    }
  });
});

describe('a click on the previewed moving body (M10 review)', () => {
  const MOVING = 'body_moving' as BodyId;
  const move: PlainMove = {
    translation: { x: 0, y: 0, z: 22 },
    rotationDeg: { x: 0, y: 0, z: 0 },
    pivot: { x: 0, y: 0, z: 0 }
  };
  /** A face record as a body's topology lists it. */
  const record = (
    id: string,
    normal: Vector3,
    centroid: Vector3,
    area: number
  ): MatchableFace => ({
    topologyId: id,
    hash: id.length,
    geometry: { normal, centroid, center: centroid, area }
  });
  const shifted = (face: MatchableFace, by: Vector3, id: string) => ({
    ...face,
    topologyId: id,
    geometry: {
      ...face.geometry!,
      centroid: {
        x: face.geometry!.centroid!.x + by.x,
        y: face.geometry!.centroid!.y + by.y,
        z: face.geometry!.centroid!.z + by.z
      },
      center: {
        x: face.geometry!.center.x + by.x,
        y: face.geometry!.center.y + by.y,
        z: face.geometry!.center.z + by.z
      }
    }
  });
  // A slotted block's two coplanar tops, its floor and its bottom.
  const committed = [
    record('bottom', neg(Z), { x: 20, y: 10, z: 0 }, 800),
    record('top-left', Z, { x: 7.5, y: 10, z: 10 }, 300),
    record('floor', Z, { x: 20, y: 10, z: 5 }, 200),
    record('top-right', Z, { x: 32.5, y: 10, z: 10 }, 300)
  ];
  const preview = committed.map((face) =>
    shifted(face, move.translation, `moved-${face.topologyId}`)
  );

  it('finds the clicked face by its place in the body, not the first coplanar one', () => {
    expect(
      committedFaceForPreviewPick(move, preview, committed, preview[3]!)
    ).toBe(committed[3]);
    expect(
      committedFaceForPreviewPick(move, preview, committed, preview[1]!)
    ).toBe(committed[1]);
  });

  it('refuses a match whose plane, moved back, is not the clicked one', () => {
    // The Move on screen is not this one: the plane is 5 off.
    const other = { ...move, translation: { x: 0, y: 0, z: 27 } };
    expect(
      committedFaceForPreviewPick(other, preview, committed, preview[3]!)
    ).toBeNull();
  });

  it('tells coplanar faces apart by centre and area when the lists differ', () => {
    const fewer = preview.slice(1);
    expect(committedFaceForPreviewPick(move, fewer, committed, fewer[2]!)).toBe(
      committed[3]
    );
    expect(committedFaceForPreviewPick(move, fewer, committed, fewer[0]!)).toBe(
      committed[1]
    );
  });

  it('takes the Move from the frame on screen, not a newer request', () => {
    // The preview drawn was built with Offset 0; the request has since
    // become Offset 5. Only the preview's own step says where it is drawn.
    const committedDoc = { featureOrder: ['f_place'] };
    const drawn = {
      featureOrder: ['f_place', 'f_align'],
      nodes: {
        n_align: {
          id: 'n_align',
          kind: 'feature',
          featureId: 'f_align',
          featureKind: 'transform',
          data: {
            featureKind: 'transform',
            targetBodyId: MOVING,
            transform: {
              translation: { x: 0, y: 0, z: 22 },
              rotationDeg: { x: 0, y: 0, z: 0 }
            }
          }
        }
      }
    } as unknown as Parameters<typeof previewedMove>[0];
    expect(previewedMove(drawn, committedDoc as never, MOVING)).toEqual(move);
    expect(
      previewedMove(drawn, committedDoc as never, 'body_other')
    ).toBeNull();
    // Nothing previewed beyond what is committed: no Move to undo.
    expect(
      previewedMove(
        drawn,
        { featureOrder: ['f_place', 'f_align'] } as never,
        MOVING
      )
    ).toBeNull();
  });

  it('moves a face back through a turned Move exactly', () => {
    const placement = faceAlignPlacement({
      moving: {
        normal: unit({ x: 1, y: 2, z: 2 }),
        point: { x: 5, y: -1, z: 4 }
      },
      target: {
        normal: unit({ x: -2, y: 1, z: 3 }),
        point: { x: 10, y: 20, z: -3 }
      }
    })!;
    const normal = unit({ x: 0.3, y: -0.9, z: 0.2 });
    const at = { x: 7, y: 3, z: -2 };
    const back = unmovedFaceGeometry(
      placement,
      placeDirection(placement, normal),
      placePoint(placement, at)
    );
    expectVector(back.normal, normal);
    expectVector(back.at, at);
  });
});
