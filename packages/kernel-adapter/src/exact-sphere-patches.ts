/**
 * Exact containment evidence for faces whose ADR-011 witnesses cannot tell
 * them apart (K06, sphere-patch identity).
 *
 * Remus builds a sphere from two hemispheres trimmed at the equator. Both
 * lie on one carrier, share every equator vertex, and have the same perimeter,
 * so their exact witnesses — and therefore their hashes — are identical. That
 * is correct for a witness (it describes geometry, and ADR-011 hashes stay
 * frozen), but it means witness matching alone cannot carry a name from one
 * hemisphere onto its own image.
 *
 * The kernel can, however, answer a sharper question exactly: does a point
 * lie ON a trimmed face? `pointToFaceDistance` honours the face's trim, so a
 * pole is at distance zero from its own hemisphere and at √2·R from the other.
 * Everything here is built on that one predicate, with a wide gap between "on"
 * and "off" so that nothing in between is ever read as either: a probe that
 * lands near a boundary (the equator) is `unknown` and the caller declines.
 * No nearest-face choice is made anywhere — a point that is on more than one
 * candidate, or on none, names nothing.
 */
import type { RemusKernel } from './remus-runtime';
import type { QuantizedTopologyPoint } from '@openzcad/shared';
import type { WitnessTieResolver } from './remus-lineage';
import { quantizeCoordinate } from './topology-fingerprint';

export interface SphereCarrier {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/** The exact sphere a face lies on, or null for any other surface. */
export function sphereCarrierOf(
  kernel: RemusKernel,
  face: number
): SphereCarrier | null {
  try {
    if (kernel.getSurfaceType(face) !== 'sphere') return null;
    const record = JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
      center?: unknown;
      radius?: unknown;
    };
    const center = record.center;
    const radius = record.radius;
    if (
      !Array.isArray(center) ||
      center.length !== 3 ||
      center.some((value) => typeof value !== 'number' || !isFinite(value)) ||
      typeof radius !== 'number' ||
      !(radius > 0) ||
      !isFinite(radius)
    ) {
      return null;
    }
    return {
      center: [center[0] as number, center[1] as number, center[2] as number],
      radius
    };
  } catch {
    return null;
  }
}

/** The sphere carrier in the ADR-011 coordinate quantum, for exact comparison. */
export function quantizedSphereCarrier(carrier: SphereCarrier): {
  readonly center: QuantizedTopologyPoint;
  readonly radius: number;
} {
  return {
    center: [
      quantizeCoordinate(carrier.center[0]),
      quantizeCoordinate(carrier.center[1]),
      quantizeCoordinate(carrier.center[2])
    ],
    radius: quantizeCoordinate(carrier.radius)
  };
}

/**
 * On within a hair of the linear tolerance, scaled with the part so a
 * metre-sized sphere is not held to a micron. Off only beyond a thousandth of
 * the radius — a pole and the opposite hemisphere are √2·R apart.
 */
function containmentBands(radius: number) {
  return { on: Math.max(1e-7, radius * 1e-9), off: radius * 1e-3 };
}

export type FaceContainment = 'on' | 'off' | 'unknown';

export function faceContainment(
  kernel: RemusKernel,
  face: number,
  point: readonly [number, number, number],
  radius: number
): FaceContainment {
  let distance: number;
  try {
    distance = kernel.pointToFaceDistance(
      point[0],
      point[1],
      point[2],
      face
    )[0]!;
  } catch {
    return 'unknown';
  }
  if (!Number.isFinite(distance)) return 'unknown';
  const bands = containmentBands(radius);
  return distance <= bands.on
    ? 'on'
    : distance >= bands.off
      ? 'off'
      : 'unknown';
}

/** The six points where the carrier meets its centre's coordinate axes. */
function axisPoles(
  carrier: SphereCarrier
): [string, [number, number, number]][] {
  const [x, y, z] = carrier.center;
  const r = carrier.radius;
  return [
    ['x-max', [x + r, y, z]],
    ['x-min', [x - r, y, z]],
    ['y-max', [x, y + r, z]],
    ['y-min', [x, y - r, z]],
    ['z-max', [x, y, z + r]],
    ['z-min', [x, y, z - r]]
  ];
}

/**
 * The two hemispheres of a primitive sphere built in its own frame, named by
 * the pole each one contains: `z-max` holds (0, 0, +R) and not (0, 0, −R),
 * `z-min` the reverse. Returns null — and the caller publishes nothing —
 * unless the solid is exactly two faces on one sphere and each pole lies on
 * exactly one of them.
 */
export function primitiveSphereFaceRoles(
  kernel: RemusKernel,
  solid: number
): Map<number, 'z-max' | 'z-min'> | null {
  const faces = Array.from(kernel.getSolidFaces(solid));
  if (faces.length !== 2) return null;
  const carriers = faces.map((face) => sphereCarrierOf(kernel, face));
  if (carriers.some((carrier) => carrier === null)) return null;
  const [first, second] = carriers as SphereCarrier[];
  const key = (carrier: SphereCarrier) =>
    JSON.stringify(quantizedSphereCarrier(carrier));
  if (key(first!) !== key(second!)) return null;
  const carrier = first!;
  const poles = new Map(axisPoles(carrier));
  const roles = new Map<number, 'z-max' | 'z-min'>();
  for (const role of ['z-max', 'z-min'] as const) {
    const pole = poles.get(role)!;
    const states = faces.map((face) =>
      faceContainment(kernel, face, pole, carrier.radius)
    );
    if (states.includes('unknown')) return null;
    const holders = faces.filter((_, index) => states[index] === 'on');
    if (holders.length !== 1 || roles.has(holders[0]!)) return null;
    roles.set(holders[0]!, role);
  }
  return roles.size === 2 ? roles : null;
}

function applyMatrix(
  matrix: readonly number[],
  point: readonly [number, number, number]
): [number, number, number] {
  const [x, y, z] = point;
  return [
    matrix[0]! * x + matrix[1]! * y + matrix[2]! * z + matrix[3]!,
    matrix[4]! * x + matrix[5]! * y + matrix[6]! * z + matrix[7]!,
    matrix[8]! * x + matrix[9]! * y + matrix[10]! * z + matrix[11]!
  ];
}

const IDENTITY: readonly number[] = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1
];

/**
 * Settles a witness tie between result faces when the source is a sphere
 * patch: `(kind, sourceFace, resultFaces) → resultFace | null`.
 *
 * A probe point is chosen on the source face that is OFF every other face of
 * the source solid (one of the six axis poles of its carrier; equator points
 * are on both hemispheres and are rejected). The known transform carries the
 * probe exactly; the tie resolves only when exactly one tied result face
 * holds the carried probe and every other tied face is clearly off it.
 * Anything else — not a sphere, no clean probe, two holders, an unknown
 * distance — returns null and the name stays unpublished.
 */

export function sphereWitnessTieResolver(
  kernel: RemusKernel,
  sourceSolid: number,
  matrix: readonly number[] = IDENTITY
): WitnessTieResolver {
  return (kind, sourceHandle, resultHandles) => {
    if (kind !== 'face' || resultHandles.length < 2) return null;
    const carrier = sphereCarrierOf(kernel, sourceHandle);
    if (!carrier) return null;
    let others: number[];
    try {
      others = Array.from(kernel.getSolidFaces(sourceSolid)).filter(
        (face) => face !== sourceHandle
      );
      if (
        others.length === Array.from(kernel.getSolidFaces(sourceSolid)).length
      )
        return null;
    } catch {
      return null;
    }
    const scale = Math.hypot(matrix[0]!, matrix[4]!, matrix[8]!);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    for (const [, pole] of axisPoles(carrier)) {
      if (faceContainment(kernel, sourceHandle, pole, carrier.radius) !== 'on')
        continue;
      if (
        others.some(
          (face) =>
            faceContainment(kernel, face, pole, carrier.radius) !== 'off'
        )
      )
        continue;
      const moved = applyMatrix(matrix, pole);
      const states = resultHandles.map((face) =>
        faceContainment(kernel, face, moved, carrier.radius * scale)
      );
      if (states.includes('unknown')) return null;
      const holders = resultHandles.filter(
        (_, index) => states[index] === 'on'
      );
      return holders.length === 1 ? holders[0]! : null;
    }
    return null;
  };
}
