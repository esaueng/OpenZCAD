import { describe, expect, it } from 'vitest';
import type { Vector3 } from '@openzcad/shared';
import {
  GROUND_FRAME,
  eulerDegrees,
  footprintPlacement,
  framePlaneHit,
  placementFrame,
  primitiveBuild,
  principalFrameFor,
  type PlacementPick
} from './primitives';

/** The transform's own turn, `Rz · Ry · Rx`, applied to a point. */
function turn(rotationDeg: Vector3, point: Vector3): Vector3 {
  const [a, b, c] = [rotationDeg.x, rotationDeg.y, rotationDeg.z].map(
    (degrees) => (degrees * Math.PI) / 180
  ) as [number, number, number];
  const [ca, sa, cb, sb, cc, sc] = [
    Math.cos(a),
    Math.sin(a),
    Math.cos(b),
    Math.sin(b),
    Math.cos(c),
    Math.sin(c)
  ];
  return {
    x:
      cc * cb * point.x +
      (cc * sb * sa - sc * ca) * point.y +
      (cc * sb * ca + sc * sa) * point.z,
    y:
      sc * cb * point.x +
      (sc * sb * sa + cc * ca) * point.y +
      (sc * sb * ca - cc * sa) * point.z,
    z: -sb * point.x + cb * sa * point.y + cb * ca * point.z
  };
}

function near(actual: Vector3, expected: Vector3) {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.z).toBeCloseTo(expected.z, 9);
}

const placed = (
  normal: Vector3,
  signU: 1 | -1 = 1,
  signV: 1 | -1 = 1
): PlacementPick => ({ frame: placementFrame(normal), signU, signV });

describe('placement frames', () => {
  it('lays world axes into every plane square to one', () => {
    expect(placementFrame({ x: 0, y: 0, z: 1 })).toEqual(GROUND_FRAME);
    expect(placementFrame({ x: 0, y: 0, z: -1 })).toEqual({
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: -1, z: 0 },
      normal: { x: 0, y: 0, z: -1 }
    });
    expect(placementFrame({ x: 1, y: 0, z: 0 })).toEqual({
      u: { x: 0, y: 1, z: 0 },
      v: { x: 0, y: 0, z: 1 },
      normal: { x: 1, y: 0, z: 0 }
    });
    expect(placementFrame({ x: 0, y: -1, z: 0 })).toEqual({
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 0, z: 1 },
      normal: { x: 0, y: -1, z: 0 }
    });
  });

  it('is right-handed on a tilted plane too', () => {
    const frame = placementFrame({ x: 0, y: -1, z: 1 });
    const { u, v, normal } = frame;
    expect(u).toEqual({ x: 1, y: 0, z: 0 });
    near(
      {
        x: u.y * v.z - u.z * v.y,
        y: u.z * v.x - u.x * v.z,
        z: u.x * v.y - u.y * v.x
      },
      normal
    );
  });

  it('draws on the ground unless the view sees it edge-on', () => {
    expect(principalFrameFor({ x: -1, y: -1, z: -1 }).normal).toEqual({
      x: 0,
      y: 0,
      z: 1
    });
    // From below, the ground faces down: a primitive grows toward the eye.
    expect(principalFrameFor({ x: 0, y: 0.3, z: 1 }).normal).toEqual({
      x: 0,
      y: 0,
      z: -1
    });
    // A front view draws on the front plane, facing the viewer.
    expect(principalFrameFor({ x: 0, y: 1, z: 0.05 }).normal).toEqual({
      x: 0,
      y: -1,
      z: 0
    });
    expect(principalFrameFor({ x: -1, y: 0.2, z: 0 }).normal).toEqual({
      x: 1,
      y: 0,
      z: 0
    });
  });

  it('meets a ray in front of the eye only', () => {
    const at = framePlaneHit(
      GROUND_FRAME,
      { x: 0, y: 0, z: 5 },
      { x: 1, y: 2, z: 10 },
      { x: 0, y: 0, z: -1 }
    );
    expect(at).toEqual({ x: 1, y: 2, z: 5 });
    expect(
      framePlaneHit(
        GROUND_FRAME,
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 10 },
        { x: 0, y: 0, z: 1 }
      )
    ).toBeNull();
    expect(
      framePlaneHit(
        GROUND_FRAME,
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 10 },
        { x: 1, y: 0, z: 0 }
      )
    ).toBeNull();
  });
});

describe('a footprint drag', () => {
  it('sizes a box corner to corner, its position the lowest corner', () => {
    // Dragged right to left: Corner X is where the box really starts, so a
    // typed Corner X moves that corner (Codex review on #889).
    const result = footprintPlacement(
      'box',
      GROUND_FRAME,
      { x: 10.04, y: 5.02, z: 0 },
      { x: -9.7, y: 20.3, z: 0 },
      true,
      1,
      { height: 24 }
    );
    expect(result).toEqual({
      placement: { frame: GROUND_FRAME, signU: 1, signV: 1 },
      anchor: { x: -10, y: 5, z: 0 },
      values: { width: 20, depth: 15 }
    });
  });

  it('hangs a box under a bottom face from its lowest corner', () => {
    const bottom = placementFrame({ x: 0, y: 0, z: -1 });
    const result = footprintPlacement(
      'box',
      bottom,
      { x: 0, y: 0, z: 20 },
      { x: 10, y: 6, z: 20 },
      true,
      1,
      { height: 5 }
    );
    // The footprint spans x 0..10 and y 0..6; the box hangs 5 below.
    expect(result.anchor).toEqual({ x: 0, y: 0, z: 15 });
    expect(result.values).toEqual({ width: 10, depth: 6 });
    expect(result.placement).toEqual({
      frame: GROUND_FRAME,
      signU: 1,
      signV: 1,
      hangs: 'z'
    });
    expect(
      primitiveBuild('box', result.placement, { ...result.values, height: 5 }, result.anchor)
    ).toEqual({
      dimensions: { width: 10, height: 6, depth: 5 },
      position: { x: 0, y: 0, z: 15 }
    });
  });

  it('places a clicked box at its lowest corner too', () => {
    const bottom = placementFrame({ x: 0, y: 0, z: -1 });
    expect(
      footprintPlacement(
        'box',
        bottom,
        { x: 3, y: 4, z: 20 },
        { x: 3, y: 4, z: 20 },
        false,
        1,
        { width: 30, depth: 18, height: 24 }
      )
    ).toMatchObject({ anchor: { x: 3, y: -14, z: -4 }, values: {} });
  });

  it('sizes a round primitive by its radius from the press', () => {
    const result = footprintPlacement(
      'cylinder',
      GROUND_FRAME,
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 4, z: 0 },
      true,
      null
    );
    expect(result.values).toEqual({ radius: 5 });
    expect(
      footprintPlacement(
        'torus',
        GROUND_FRAME,
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 8, z: 0 },
        true,
        null
      ).values
    ).toEqual({ majorRadius: 8 });
  });

  it('snaps in the plane but never off a face', () => {
    const top = placementFrame({ x: 0, y: 0, z: 1 });
    const result = footprintPlacement(
      'cylinder',
      top,
      { x: 4.6, y: 2.2, z: 6.37 },
      { x: 4.6, y: 2.2, z: 6.37 },
      false,
      1
    );
    // A click places it where it landed and leaves the sizes alone.
    expect(result).toEqual({
      placement: { frame: top, signU: 1, signV: 1 },
      anchor: { x: 5, y: 2, z: 6.37 },
      values: {}
    });
  });

  it('leaves a footprint unrounded with snapping off', () => {
    expect(
      footprintPlacement(
        'box',
        GROUND_FRAME,
        { x: 1.2345, y: 0.0004, z: 0 },
        { x: 1.2845, y: 3.4567, z: 0 },
        true,
        null,
        { height: 24 }
      )
    ).toMatchObject({
      anchor: { x: 1.2345, y: 0.0004, z: 0 },
      values: { width: 0.05, depth: 3.4563 }
    });
    // Never below the smallest size a primitive takes.
    expect(
      footprintPlacement(
        'cylinder',
        GROUND_FRAME,
        { x: 0, y: 0, z: 0 },
        { x: 0.0001, y: 0, z: 0 },
        true,
        null
      ).values
    ).toEqual({ radius: 0.001 });
  });

  it('never draws a size below one snap step', () => {
    expect(
      footprintPlacement(
        'box',
        GROUND_FRAME,
        { x: 0, y: 0, z: 0 },
        { x: 0.2, y: 3, z: 0 },
        true,
        1
      ).values
    ).toEqual({ width: 1, depth: 3 });
  });
});

describe('the placement turn', () => {
  it('takes the kernel axes onto the asked ones', () => {
    const cases: [Vector3, Vector3, Vector3][] = [
      [
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: 1, y: 0, z: 0 }
      ],
      [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: -1, z: 0 },
        { x: 0, y: 0, z: -1 }
      ],
      // Straight along X: the degenerate turn.
      [
        { x: 0, y: 0, z: -1 },
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 0, z: 0 }
      ]
    ];
    const tilted = placementFrame({ x: 0.3, y: -0.5, z: 0.8 });
    cases.push([tilted.u, tilted.v, tilted.normal]);
    for (const [x, y, z] of cases) {
      const rotation = eulerDegrees(x, y, z);
      near(turn(rotation, { x: 1, y: 0, z: 0 }), x);
      near(turn(rotation, { x: 0, y: 1, z: 0 }), y);
      near(turn(rotation, { x: 0, y: 0, z: 1 }), z);
    }
  });
});

describe('what a placement builds', () => {
  const origin = { x: 0, y: 0, z: 0 };

  it('is exactly the card default before any drag', () => {
    expect(
      primitiveBuild('box', null, { width: 30, depth: 18, height: 24 }, origin)
    ).toEqual({
      dimensions: { width: 30, height: 18, depth: 24 },
      position: origin
    });
    expect(
      primitiveBuild('cylinder', null, { radius: 6, height: 28 }, origin)
    ).toEqual({ dimensions: { radius: 6, height: 28 }, position: origin });
  });

  it('keeps a box unturned on any face square to an axis', () => {
    // Its position is its lowest corner, exactly as given.
    expect(
      primitiveBuild(
        'box',
        placed({ x: 0, y: 0, z: 1 }),
        { width: 20, depth: 15, height: 5 },
        { x: -10, y: 5, z: 'lift' }
      )
    ).toEqual({
      dimensions: { width: 20, height: 15, depth: 5 },
      position: { x: -10, y: 5, z: 'lift' }
    });
    // On a +X side face its height runs along X.
    expect(
      primitiveBuild(
        'box',
        placed({ x: 1, y: 0, z: 0 }),
        { width: 20, depth: 15, height: 5 },
        { x: 30, y: 0, z: 0 }
      )
    ).toEqual({
      dimensions: { width: 5, height: 20, depth: 15 },
      position: { x: 30, y: 0, z: 0 }
    });
  });

  it('turns a box with a tilted face, its corners where the drag put them', () => {
    const normal = { x: 0, y: -1, z: 1 };
    for (const [signU, signV] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1]
    ] as const) {
      const placement = placed(normal, signU, signV);
      const at = { x: 2, y: 3, z: 4 };
      const build = primitiveBuild(
        'box',
        placement,
        { width: 10, depth: 6, height: 2 },
        at
      );
      expect(build.position).toEqual(at);
      const dims = build.dimensions as Record<string, number>;
      // The far corner of the kernel box, turned and placed.
      const far = turn(build.rotationDeg!, {
        x: dims.width!,
        y: dims.height!,
        z: dims.depth!
      });
      const { u, v } = placement.frame;
      const n = placement.frame.normal;
      near(
        { x: far.x + at.x, y: far.y + at.y, z: far.z + at.z },
        {
          x: at.x + u.x * 10 * signU + v.x * 6 * signV + n.x * 2,
          y: at.y + u.y * 10 * signU + v.y * 6 * signV + n.y * 2,
          z: at.z + u.z * 10 * signU + v.z * 6 * signV + n.z * 2
        }
      );
    }
  });

  it('turns a cylinder over under a face, its base center on the face', () => {
    const build = primitiveBuild(
      'cylinder',
      placed({ x: 0, y: 0, z: -1 }),
      { radius: 3, height: 'h' },
      { x: 1, y: 2, z: 0 }
    );
    expect(build.position).toEqual({ x: 1, y: 2, z: 0 });
    expect(build.dimensions).toEqual({ radius: 3, height: 'h' });
    near(turn(build.rotationDeg!, { x: 0, y: 0, z: 1 }), { x: 0, y: 0, z: -1 });
  });

  it('turns a cylinder, a cone and a torus onto a side face', () => {
    for (const kind of ['cylinder', 'cone', 'torus'] as const) {
      const build = primitiveBuild(
        kind,
        placed({ x: 1, y: 0, z: 0 }),
        {},
        { x: 30, y: 0, z: 10 }
      );
      expect(build.position).toEqual({ x: 30, y: 0, z: 10 });
      near(turn(build.rotationDeg!, { x: 0, y: 0, z: 1 }), {
        x: 1,
        y: 0,
        z: 0
      });
    }
  });

  it('turns a cone over under a face, keeping its bottom on the face', () => {
    const build = primitiveBuild(
      'cone',
      placed({ x: 0, y: 0, z: -1 }),
      { bottomRadius: 6, topRadius: 2, height: 10 },
      origin
    );
    near(turn(build.rotationDeg!, { x: 0, y: 0, z: 1 }), { x: 0, y: 0, z: -1 });
    expect(build.dimensions).toEqual({
      bottomRadius: 6,
      topRadius: 2,
      height: 10
    });
  });

  it('never turns a sphere, nor a ring flat under a face', () => {
    expect(
      primitiveBuild('sphere', placed({ x: 1, y: 0, z: 0 }), { radius: 4 }, origin)
    ).toEqual({ dimensions: { radius: 4 }, position: origin });
    expect(
      primitiveBuild(
        'torus',
        placed({ x: 0, y: 0, z: -1 }),
        { majorRadius: 8, minorRadius: 1 },
        origin
      ).rotationDeg
    ).toBeUndefined();
  });
});
