import { describe, expect, it } from 'vitest';
import {
  composeMoveTransform,
  pivotDragStep,
  relocateMovePivot,
  translationForRoundedMove
} from './moveTransform';

type Vec3 = { x: number; y: number; z: number };

/** Where a Move about `pivot` puts the body point `point`: R(x − p) + p + t. */
function placed(
  point: Vec3,
  pivot: Vec3,
  translation: Vec3,
  rotationDeg: Vec3
): Vec3 {
  // The viewport's form of the same map: R·x + final.
  const final = composeMoveTransform(pivot, translation, rotationDeg);
  const zero = { x: 0, y: 0, z: 0 };
  const turned = composeMoveTransform(point, zero, rotationDeg);
  // composeMoveTransform(c, 0, R) = c − R·c, so R·x = x − that.
  return {
    x: point.x - turned.x + final.x,
    y: point.y - turned.y + final.y,
    z: point.z - turned.z + final.z
  };
}

const round = (v: Vec3) => ({
  x: Math.round(v.x * 1e9) / 1e9 || 0,
  y: Math.round(v.y * 1e9) / 1e9 || 0,
  z: Math.round(v.z * 1e9) / 1e9 || 0
});

describe('the Move pivot handle (M10)', () => {
  const corners: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 40, y: 20, z: 10 },
    { x: 40, y: 0, z: 10 }
  ];

  it.each([
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 90 },
    { x: 30, y: -45, z: 120 }
  ])('relocates a pivot without moving the body (rotation %o)', (rotation) => {
    const pivot = { x: 20, y: 10, z: 5 };
    const translation = { x: 12, y: -3, z: 4 };
    const next = { x: 40, y: 0, z: 0 };
    const kept = relocateMovePivot(pivot, translation, rotation, next);
    for (const corner of corners)
      expect(round(placed(corner, next, kept, rotation))).toEqual(
        round(placed(corner, pivot, translation, rotation))
      );
  });

  it('leaves the translation alone when nothing turns', () => {
    expect(
      relocateMovePivot(
        { x: 20, y: 10, z: 5 },
        { x: 12, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: -7, y: 3, z: 1 }
      )
    ).toEqual({ x: 12, y: 0, z: 0 });
  });

  it('carries the gizmo where it is dragged and keeps the body still', () => {
    const pivot = { x: 20, y: 10, z: 5 };
    const translation = { x: 12, y: -3, z: 4 };
    const rotation = { x: 10, y: 20, z: 90 };
    const delta = { x: 5, y: -8, z: 2 };
    const step = pivotDragStep(translation, rotation, delta);
    const nextPivot = {
      x: pivot.x + step.pivotDelta.x,
      y: pivot.y + step.pivotDelta.y,
      z: pivot.z + step.pivotDelta.z
    };
    // The gizmo stands on p + t: it moved by exactly the drag.
    expect(
      round({
        x: nextPivot.x + step.translation.x,
        y: nextPivot.y + step.translation.y,
        z: nextPivot.z + step.translation.z
      })
    ).toEqual(
      round({
        x: pivot.x + translation.x + delta.x,
        y: pivot.y + translation.y + delta.y,
        z: pivot.z + translation.z + delta.z
      })
    );
    for (const corner of corners)
      expect(
        round(placed(corner, nextPivot, step.translation, rotation))
      ).toEqual(round(placed(corner, pivot, translation, rotation)));
    // Unturned, the pivot moves by the drag itself.
    expect(
      round(pivotDragStep(translation, { x: 0, y: 0, z: 0 }, delta).pivotDelta)
    ).toEqual(delta);
  });

  it('keeps the placement when Done rounds the turn and a far pivot', () => {
    // Review case: a 0.00049° pending turn about a pivot moved 100 m away.
    const rotation = { x: 0, y: 0, z: 0.00049 };
    const kept = relocateMovePivot(
      { x: 20, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      rotation,
      { x: 100020, y: 0, z: 0 }
    );
    expect(Math.abs(kept.y)).toBeGreaterThan(0.8);
    const storedRotation = { x: 0, y: 0, z: 0 };
    const storedPivot = { x: 100020, y: 0, z: 0 };
    const stored = translationForRoundedMove(
      { x: 100020, y: 0, z: 0 },
      kept,
      rotation,
      storedPivot,
      storedRotation
    );
    // A body corner lands within the turn's own rounding, not 0.855 mm off.
    for (const corner of corners) {
      const before = placed(corner, { x: 100020, y: 0, z: 0 }, kept, rotation);
      const after = placed(corner, storedPivot, stored, storedRotation);
      expect(
        Math.hypot(before.x - after.x, before.y - after.y, before.z - after.z)
      ).toBeLessThan(1e-3);
    }
  });
});
