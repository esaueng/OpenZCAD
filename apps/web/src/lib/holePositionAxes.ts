interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** What a hole's U and V fields run along on one entry face. */
export interface HolePositionAxes {
  u: Vector3;
  v: Vector3;
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalized(vector: Vector3): Vector3 | null {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length > 1e-12
    ? { x: vector.x / length, y: vector.y / length, z: vector.z / length }
    : null;
}

/**
 * The face frame a hole's (u, v) is measured in, from the entry face's
 * outward normal.
 *
 * It must stay the construction the kernel-adapter's hole builder uses
 * (`exact-feature-builders.ts`): a world reference axis — +Z unless the face
 * nearly faces it, then +X — crossed into the normal. On a top face that
 * makes U run along world −Y and V along +X, which is why "U = −40" on a
 * 100 × 60 plate landed off the 60 mm side.
 */
export function holePositionAxes(normal: Vector3): HolePositionAxes | null {
  const zAxis = normalized(normal);
  if (!zAxis) return null;
  const reference =
    Math.abs(zAxis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const u = normalized(cross(reference, zAxis));
  if (!u) return null;
  return { u, v: cross(zAxis, u) };
}

const ALIGNED = 1 - 1e-6;

/**
 * "+X", "−Y" … for a direction along a world axis; null for an oblique one,
 * which has no short name worth showing.
 */
export function worldAxisName(direction: Vector3): string | null {
  const components: [string, number][] = [
    ['X', direction.x],
    ['Y', direction.y],
    ['Z', direction.z]
  ];
  for (const [name, value] of components) {
    if (Math.abs(value) >= ALIGNED) {
      return `${value > 0 ? '+' : '−'}${name}`;
    }
  }
  return null;
}

/** The U and V field labels for a face, naming the world axis each runs along. */
export function holePositionLabels(normal: Vector3 | undefined): {
  u: string;
  v: string;
} {
  const axes = normal ? holePositionAxes(normal) : null;
  const u = axes ? worldAxisName(axes.u) : null;
  const v = axes ? worldAxisName(axes.v) : null;
  return {
    u: u ? `U · along ${u}` : 'U',
    v: v ? `V · along ${v}` : 'V'
  };
}
