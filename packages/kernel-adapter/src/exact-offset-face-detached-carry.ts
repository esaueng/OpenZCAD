/**
 * A face offset must not carry a curved support it is not attached to.
 *
 * Offsetting a planar face moves that face, re-limits its neighbours and
 * rebuilds or translates the blend and chamfer bands along its rim. It never
 * moves a separate curved support: a cylindrical boss, a spherical dome, a
 * toroidal ring. Measured on the pin: a 30 × 18 × 24 box fused with an r6
 * boss at the origin, with r1 rounds on the boss's vertical seam with the
 * box's front face and on its arc seam with the box's top. The rounds meet,
 * so the front face, the vertical round and the torus round on the boss are
 * one tangent chain. Offsetting the front face by +5 comes back `ok`, closed,
 * valid and exact, with the boss wall and its rounds moved 5 mm with the
 * face (in the reported model, with a bottom chamfer ring, the chamfer moved
 * too), and the front face at its old area instead of extended: the kernel
 * translated the tangent-connected region rigidly instead of re-solving the
 * round where the face meets the boss. The move journal reports every face
 * as plain `modified`, so lineage cannot tell, and every structural check
 * passes. With only the vertical seam rounded the same move is refused
 * ("blend face … reaches non-invariant cylinder support face"), which is the
 * right answer.
 *
 * This is the adapter's guard until the kernel refuses (or re-solves) it
 * itself. After the move it looks for a curved face of the source whose exact
 * carrier is gone from the result while the same carrier translated by the
 * move's displacement is present: proof that the kernel moved it rigidly.
 * That is the move's job only for the moved faces themselves and for their
 * own blend chain:
 *
 * - a seed: a round on the moved face's rim, tangent to it (the edge between
 *   them is G1), which a planar move translates or rebuilds;
 * - a corner patch: a curved face tangent to a chain member and rolling the
 *   same radius, which a prismatic blend translation carries with its band.
 *
 * Every chain member must also be shaped like a rolling-ball blend, not like
 * a support: a cylinder spans less than half a turn about its axis, a torus
 * less than half a turn about its tube, a sphere lies inside an open
 * hemisphere. A bore or boss wall spans half a turn or more, so it never
 * joins the chain, whatever its radius, and neither does a bore that meets
 * the face square rather than tangent.
 *
 * Any other curved face moved that way is refused, typed, and nothing is
 * committed. The check reads only faces that are proven to have moved
 * rigidly, so a face the move re-limits, rebuilds or removes never refuses.
 * Cones are not read: a chamfer or countersink cone is carried with the face
 * it rings, and the hole-mouth guard (`exact-offset-face-hole-mouth.ts`)
 * owns those.
 *
 * Lengths compare at a tolerance set by the body's size and the move, never
 * by how far the body sits from the world origin.
 */
import { GEOMETRY_LINEAR_TOLERANCE, type Vec3 } from '@openzcad/geometry';

import { analyticSurfaceRecord } from './exact-brep';
import {
  ANALYTIC_MATCH_EPSILON,
  FULL_REVOLUTION,
  add,
  cross,
  dot,
  finiteVec3,
  length,
  normalized,
  positiveFinite,
  scale,
  subtract
} from './exact-math';
import { OffsetFaceRefusal } from './exact-offset-face-refusal';
import { edgeToFaceMapOf, surfaceTypeOf } from './exact-sync-memo';
import type { RemusKernel } from './remus-runtime';

/** The adapter's code for this refusal; the kernel has none. */
export const OFFSET_FACE_CARRIED_DETACHED_SUPPORT =
  'offset_face_carried_detached_support';

/** The curved carriers a rigid carry can be proven on. */
type CurvedCarrier =
  | { kind: 'cylinder'; origin: Vec3; axis: Vec3; radius: number }
  | { kind: 'sphere'; center: Vec3; radius: number }
  | {
      kind: 'torus';
      center: Vec3;
      axis: Vec3;
      majorRadius: number;
      minorRadius: number;
    };

/**
 * The length tolerance for one move: the analytic match tolerance scaled by
 * the body's bounding-box diagonal, never below the linear tolerance, and
 * never more than a quarter of the move, so a carry of any length stays
 * visible. Where the body sits in the world does not enter it: a body 60 km
 * from the origin compares as finely as one at the origin.
 */
function moveTolerance(
  kernel: RemusKernel,
  source: number,
  displacement: Vec3
): number {
  let diagonal = 0;
  try {
    const box = kernel.boundingBox(source);
    diagonal = Math.hypot(
      box[3]! - box[0]!,
      box[4]! - box[1]!,
      box[5]! - box[2]!
    );
  } catch {
    // No box: the linear tolerance alone.
  }
  const size = Number.isFinite(diagonal) ? diagonal : 0;
  return Math.min(
    Math.max(GEOMETRY_LINEAR_TOLERANCE, size * ANALYTIC_MATCH_EPSILON),
    length(displacement) / 4
  );
}

/** Directions compare as lines: parallel either way. */
const PARALLEL_SINE = 1e-7;

/** How far short of half a turn a blend's arc must stop. */
const HALF_TURN_MARGIN = 1e-3;

function carrierOf(kernel: RemusKernel, face: number): CurvedCarrier | null {
  const type = surfaceTypeOf(kernel, face);
  if (type !== 'cylinder' && type !== 'sphere' && type !== 'torus') {
    return null;
  }
  const record = analyticSurfaceRecord(kernel, face);
  if (!record) return null;
  if (type === 'sphere') {
    const center = finiteVec3(record.center);
    const radius = positiveFinite(record.radius);
    return center && radius !== null
      ? { kind: 'sphere', center, radius }
      : null;
  }
  const rawAxis = finiteVec3(record.axis);
  const axis = rawAxis ? normalized(rawAxis) : null;
  if (!axis) return null;
  if (type === 'cylinder') {
    const origin = finiteVec3(record.origin);
    const radius = positiveFinite(record.radius);
    return origin && radius !== null
      ? { kind: 'cylinder', origin, axis, radius }
      : null;
  }
  const center = finiteVec3(record.center);
  const majorRadius = positiveFinite(record.majorRadius ?? record.major_radius);
  const minorRadius = positiveFinite(record.minorRadius ?? record.minor_radius);
  return center && majorRadius !== null && minorRadius !== null
    ? { kind: 'torus', center, axis, majorRadius, minorRadius }
    : null;
}

function translated(carrier: CurvedCarrier, by: Vec3): CurvedCarrier {
  return carrier.kind === 'cylinder'
    ? { ...carrier, origin: add(carrier.origin, by) }
    : { ...carrier, center: add(carrier.center, by) };
}

function parallel(a: Vec3, b: Vec3): boolean {
  return length(cross(a, b)) <= PARALLEL_SINE;
}

/** Whether two carriers are the same surface, whatever their trims. */
function sameCarrier(
  a: CurvedCarrier,
  b: CurvedCarrier,
  tolerance: number
): boolean {
  if (a.kind === 'cylinder' && b.kind === 'cylinder') {
    if (!parallel(a.axis, b.axis)) return false;
    if (Math.abs(a.radius - b.radius) > tolerance) return false;
    // Distance between the two axis lines, which are parallel.
    const between = subtract(b.origin, a.origin);
    return length(cross(between, a.axis)) <= tolerance;
  }
  if (a.kind === 'sphere' && b.kind === 'sphere') {
    return (
      Math.abs(a.radius - b.radius) <= tolerance &&
      length(subtract(a.center, b.center)) <= tolerance
    );
  }
  if (a.kind === 'torus' && b.kind === 'torus') {
    return (
      parallel(a.axis, b.axis) &&
      Math.abs(a.majorRadius - b.majorRadius) <= tolerance &&
      Math.abs(a.minorRadius - b.minorRadius) <= tolerance &&
      length(subtract(a.center, b.center)) <= tolerance
    );
  }
  return false;
}

/** The radius a blend of this carrier would roll: the tube, not the ring. */
function rollingRadius(carrier: CurvedCarrier): number {
  return carrier.kind === 'torus' ? carrier.minorRadius : carrier.radius;
}

/** Points along every edge of `face`, or null when one cannot be sampled. */
function boundaryPoints(
  kernel: RemusKernel,
  face: number,
  deflection: number
): Vec3[] | null {
  const points: Vec3[] = [];
  try {
    for (const edge of kernel.getFaceEdges(face)) {
      const flat = kernel.sampleEdge(edge, deflection);
      for (let index = 0; index + 2 < flat.length; index += 3) {
        points.push({
          x: flat[index]!,
          y: flat[index + 1]!,
          z: flat[index + 2]!
        });
      }
    }
  } catch {
    return null;
  }
  return points.length > 0 ? points : null;
}

/**
 * The angular extent of `angles` on the circle: a full turn less the widest
 * gap between neighbours.
 */
function angularSpan(angles: number[]): number {
  if (angles.length === 0) return FULL_REVOLUTION;
  const sorted = angles
    .map(
      (angle) => ((angle % FULL_REVOLUTION) + FULL_REVOLUTION) % FULL_REVOLUTION
    )
    .sort((a, b) => a - b);
  let widest = sorted[0]! + FULL_REVOLUTION - sorted[sorted.length - 1]!;
  for (let index = 1; index < sorted.length; index += 1) {
    widest = Math.max(widest, sorted[index]! - sorted[index - 1]!);
  }
  return FULL_REVOLUTION - widest;
}

/** An angle about `axis` measured in a fixed frame perpendicular to it. */
function angleAbout(axis: Vec3): (radial: Vec3) => number {
  const helper =
    Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = normalized(cross(axis, helper))!;
  const v = cross(axis, u);
  return (radial) => Math.atan2(dot(radial, v), dot(radial, u));
}

/**
 * Whether `face` is shaped like a rolling-ball blend of its carrier rather
 * than like a support: a cylinder spans less than half a turn about its
 * axis, a torus less than half a turn about its tube, and a sphere lies
 * inside an open hemisphere. A round between two faces meeting at any real
 * angle passes; a bore or boss wall, which wraps half a turn or more, does
 * not.
 */
function blendShaped(
  kernel: RemusKernel,
  face: number,
  carrier: CurvedCarrier
): boolean {
  const points = boundaryPoints(kernel, face, rollingRadius(carrier) / 50);
  if (!points) return false;
  const halfTurn = Math.PI - HALF_TURN_MARGIN;
  switch (carrier.kind) {
    case 'cylinder': {
      const angle = angleAbout(carrier.axis);
      return (
        angularSpan(
          points.map((point) => {
            const offset = subtract(point, carrier.origin);
            return angle(
              subtract(offset, scale(carrier.axis, dot(offset, carrier.axis)))
            );
          })
        ) < halfTurn
      );
    }
    case 'torus':
      return (
        angularSpan(
          points.map((point) => {
            const offset = subtract(point, carrier.center);
            const height = dot(offset, carrier.axis);
            const ring = length(subtract(offset, scale(carrier.axis, height)));
            return Math.atan2(height, ring - carrier.majorRadius);
          })
        ) < halfTurn
      );
    case 'sphere': {
      const directions = points.flatMap((point) => {
        const direction = normalized(subtract(point, carrier.center));
        return direction ? [direction] : [];
      });
      const mean = normalized(
        directions.reduce((sum, direction) => add(sum, direction), {
          x: 0,
          y: 0,
          z: 0
        })
      );
      return (
        mean !== null &&
        directions.every(
          (direction) => dot(direction, mean) > Math.sin(HALF_TURN_MARGIN)
        )
      );
    }
  }
}

function describe(carrier: CurvedCarrier): string {
  const round = (value: number) => Number(value.toPrecision(6));
  const point = (p: Vec3) => `(${round(p.x)}, ${round(p.y)}, ${round(p.z)})`;
  switch (carrier.kind) {
    case 'cylinder':
      return `r${round(carrier.radius)} cylinder through ${point(carrier.origin)}`;
    case 'sphere':
      return `r${round(carrier.radius)} sphere about ${point(carrier.center)}`;
    case 'torus':
      return `R${round(carrier.majorRadius)}/r${round(carrier.minorRadius)} torus about ${point(carrier.center)}`;
  }
}

/**
 * The moved faces' own blend chain on `source`: the blend-shaped rounds
 * tangent to a moved face, then every blend-shaped curved face tangent to a
 * member and rolling the same radius.
 */
function blendChain(
  kernel: RemusKernel,
  source: number,
  movedSet: ReadonlySet<number>,
  tolerance: number
): Set<number> {
  let smooth: ReadonlySet<number>;
  try {
    smooth = new Set(kernel.getSolidSmoothEdges(source));
  } catch {
    // Without a tangency verdict no face can be proven a blend.
    return new Set();
  }
  const edgeFaces = edgeToFaceMapOf(kernel, source);
  const chain = new Map<number, number>();
  const queue: number[] = [];
  /** The curved faces across a G1 edge of `face`, with their carriers. */
  const tangentNeighbours = (face: number) => {
    const found: { face: number; carrier: CurvedCarrier }[] = [];
    for (const edge of kernel.getFaceEdges(face)) {
      if (!smooth.has(edge)) continue;
      for (const other of edgeFaces[String(edge)] ?? []) {
        if (other === face || movedSet.has(other) || chain.has(other)) continue;
        const carrier = carrierOf(kernel, other);
        if (carrier) found.push({ face: other, carrier });
      }
    }
    return found;
  };
  const join = (face: number, carrier: CurvedCarrier) => {
    if (chain.has(face) || !blendShaped(kernel, face, carrier)) return;
    chain.set(face, rollingRadius(carrier));
    queue.push(face);
  };
  for (const face of movedSet) {
    for (const seed of tangentNeighbours(face)) join(seed.face, seed.carrier);
  }
  while (queue.length > 0) {
    const member = queue.shift()!;
    const radius = chain.get(member)!;
    for (const next of tangentNeighbours(member)) {
      if (Math.abs(rollingRadius(next.carrier) - radius) <= tolerance) {
        join(next.face, next.carrier);
      }
    }
  }
  return new Set(chain.keys());
}

/** A source face the move carried rigidly without being attached to it. */
export interface DetachedCarry {
  /** The source face's handle. */
  face: number;
  /** Its carrier before the move. */
  carrier: string;
}

/**
 * The first curved face of `source` that the move from `source` to `output`
 * translated rigidly by `displacement` although the move had no reason to
 * carry it, or null when there is none.
 *
 * `moved` are the faces the move was asked to move, on `source`.
 */
export function detachedSupportCarry(
  kernel: RemusKernel,
  source: number,
  moved: readonly number[],
  output: number,
  displacement: Vec3
): DetachedCarry | null {
  if (length(displacement) <= ANALYTIC_MATCH_EPSILON) return null;
  const tolerance = moveTolerance(kernel, source, displacement);
  const movedSet = new Set(moved);
  const resultCarriers: CurvedCarrier[] = [];
  for (const face of kernel.getSolidFaces(output)) {
    const carrier = carrierOf(kernel, face);
    if (carrier) resultCarriers.push(carrier);
  }
  const present = (carrier: CurvedCarrier) =>
    resultCarriers.some((other) => sameCarrier(carrier, other, tolerance));
  // The faces that rigidly moved and are not one of the moved faces.
  const carried: { face: number; carrier: CurvedCarrier }[] = [];
  for (const face of kernel.getSolidFaces(source)) {
    if (movedSet.has(face)) continue;
    const carrier = carrierOf(kernel, face);
    if (!carrier) continue;
    const shifted = translated(carrier, displacement);
    // A carrier the displacement leaves where it was (a bore along the
    // move) cannot show a carry.
    if (sameCarrier(carrier, shifted, tolerance)) continue;
    if (present(carrier) || !present(shifted)) continue;
    carried.push({ face, carrier });
  }
  if (carried.length === 0) return null;
  // Only now, with a proven carry, read the chain the move may take along.
  const chain = blendChain(kernel, source, movedSet, tolerance);
  const detached = carried.filter(({ face }) => !chain.has(face));
  if (detached.length === 0) return null;
  // Name the support itself (the boss, not a round riding with it) when
  // one moved; otherwise the first face that should not have.
  const named =
    detached.find(({ face, carrier }) => !blendShaped(kernel, face, carrier)) ??
    detached[0]!;
  return { face: named.face, carrier: describe(named.carrier) };
}

/** The refusal for a move that carried a support it is not attached to. */
export function detachedSupportCarryRefusal(
  offset: number,
  carry: DetachedCarry
): OffsetFaceRefusal {
  const reason =
    'Offsetting this face would also move a separate curved feature joined to it by a fillet (such as a boss), so the offset was not applied. The exact kernel cannot yet rebuild the fillet between them for this offset.';
  const detail = `Offsetting the face by ${offset} translated the ${carry.carrier} with it instead of leaving it in place.`;
  return new OffsetFaceRefusal({
    family: 'direct-edit',
    category: 'unsupported',
    kernelCode: OFFSET_FACE_CARRIED_DETACHED_SUPPORT,
    kernelMessage: detail,
    reason,
    message: `${reason}\n${detail}`
  });
}
