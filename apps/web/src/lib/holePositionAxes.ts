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

/** Which world axis a direction mostly runs along: 0 for X, 1 for Y, 2 for Z. */
function dominantAxis(direction: Vector3): number {
  const magnitudes = [
    Math.abs(direction.x),
    Math.abs(direction.y),
    Math.abs(direction.z)
  ];
  return magnitudes.indexOf(Math.max(...magnitudes));
}

/**
 * The order the card shows the U and V fields in: the one running along X
 * first, then Y, then Z.
 *
 * The frame itself cannot change — saved holes store (u, v) in it, and the
 * kernel builder rebuilds them from it — so on a top face U still runs along
 * −Y and V along +X. Listing V first there puts the plate's X (its width) in
 * the first field, where a reader looks for it, while each label still says
 * which way its own field runs. Side faces already list their horizontal
 * axis first and keep their order.
 */
export function holePositionFieldOrder(
  normal: Vector3 | undefined
): readonly ['u', 'v'] | readonly ['v', 'u'] {
  const axes = normal ? holePositionAxes(normal) : null;
  if (!axes) return ['u', 'v'];
  return dominantAxis(axes.v) < dominantAxis(axes.u) ? ['v', 'u'] : ['u', 'v'];
}

/** A picked coordinate as field text: no float noise, no "-0". */
function coordinateText(value: number, step: number | null): string {
  const increment = step !== null && step > 0 ? step : 0.01;
  const snapped = Math.round(value / increment) * increment;
  // As many places as the increment has (0.25 → 2), never more than six.
  const written = String(increment);
  const dot = written.indexOf('.');
  const places = written.includes('e')
    ? 6
    : dot < 0
      ? 0
      : Math.min(6, written.length - dot - 1);
  const rounded = Number(snapped.toFixed(places));
  return rounded === 0 ? '0' : String(rounded);
}

/**
 * The hole position (u, v) a click on the entry face asks for: the picked
 * point measured from the face's anchor along the same U and V the builder
 * drills in, rounded to the snap increment (or to 0.01 with snapping off).
 * Null when the face has no usable frame.
 */
export function holePositionFromPoint(
  normal: Vector3,
  anchor: Vector3,
  point: Vector3,
  step: number | null
): { u: string; v: string } | null {
  const axes = holePositionAxes(normal);
  if (!axes) return null;
  const offset = {
    x: point.x - anchor.x,
    y: point.y - anchor.y,
    z: point.z - anchor.z
  };
  const along = (axis: Vector3) =>
    offset.x * axis.x + offset.y * axis.y + offset.z * axis.z;
  const u = along(axes.u);
  const v = along(axes.v);
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return { u: coordinateText(u, step), v: coordinateText(v, step) };
}

/**
 * `holePositionFromPoint` for a picked entry face's measured geometry,
 * measured from the anchor the hole is drilled against. Null when the face
 * lacks a normal or that anchor.
 */
export function holePositionFromPick(
  face: { normal?: Vector3; centroid?: Vector3; center?: Vector3 },
  anchor: 'centroid' | 'center',
  point: Vector3,
  step: number | null
): { u: string; v: string } | null {
  const origin = anchor === 'centroid' ? face.centroid : face.center;
  return face.normal && origin
    ? holePositionFromPoint(face.normal, origin, point, step)
    : null;
}
