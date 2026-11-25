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
 * That is the move's job only for:
 *
 * - the moved faces themselves;
 * - the faces sharing an edge with them, the rim bands a planar move
 *   translates or rebuilds;
 * - curved faces with the blend radius of one of those rim bands, the corner
 *   patches a prismatic blend translation carries with its band.
 *
 * Any other curved face moved that way is refused, typed, and nothing is
 * committed. The check reads only faces that are proven to have moved
 * rigidly, so a face the move re-limits, rebuilds or removes never refuses.
 * Cones are not read: a chamfer or countersink cone is carried with the face
 * it rings, and the hole-mouth guard (`exact-offset-face-hole-mouth.ts`)
 * owns those.
 */
import type { Vec3 } from '@openzcad/geometry';

import { analyticSurfaceRecord } from './exact-brep';
import {
  ANALYTIC_MATCH_EPSILON,
  add,
  cross,
  finiteVec3,
  length,
  normalized,
  positiveFinite,
  subtract
} from './exact-math';
import { measureBlendRegion } from './exact-measure';
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

/** Lengths compare at the analytic match tolerance, scaled by size. */
const lengthTolerance = (size: number) =>
  Math.max(1, Math.abs(size)) * ANALYTIC_MATCH_EPSILON;

/** Directions compare as lines: parallel either way. */
const PARALLEL_SINE = 1e-7;

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
function sameCarrier(a: CurvedCarrier, b: CurvedCarrier): boolean {
  if (a.kind === 'cylinder' && b.kind === 'cylinder') {
    if (!parallel(a.axis, b.axis)) return false;
    if (Math.abs(a.radius - b.radius) > lengthTolerance(a.radius)) return false;
    // Distance between the two axis lines, which are parallel.
    const between = subtract(b.origin, a.origin);
    const off = length(cross(between, a.axis));
    return off <= lengthTolerance(length(a.origin) + a.radius);
  }
  if (a.kind === 'sphere' && b.kind === 'sphere') {
    return (
      Math.abs(a.radius - b.radius) <= lengthTolerance(a.radius) &&
      length(subtract(a.center, b.center)) <=
        lengthTolerance(length(a.center) + a.radius)
    );
  }
  if (a.kind === 'torus' && b.kind === 'torus') {
    return (
      parallel(a.axis, b.axis) &&
      Math.abs(a.majorRadius - b.majorRadius) <=
        lengthTolerance(a.majorRadius) &&
      Math.abs(a.minorRadius - b.minorRadius) <=
        lengthTolerance(a.minorRadius) &&
      length(subtract(a.center, b.center)) <=
        lengthTolerance(length(a.center) + a.majorRadius)
    );
  }
  return false;
}

/** The radius a blend of this carrier would roll: the tube, not the ring. */
function rollingRadius(carrier: CurvedCarrier): number {
  return carrier.kind === 'torus' ? carrier.minorRadius : carrier.radius;
}

function blendRadiusOf(
  kernel: RemusKernel,
  solid: number,
  face: number,
  carrier: CurvedCarrier | null
): number | null {
  return (
    measureBlendRegion(kernel, solid, face)?.radius ??
    (carrier ? rollingRadius(carrier) : null)
  );
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
  const movedSet = new Set(moved);
  const resultCarriers: CurvedCarrier[] = [];
  for (const face of kernel.getSolidFaces(output)) {
    const carrier = carrierOf(kernel, face);
    if (carrier) resultCarriers.push(carrier);
  }
  const present = (carrier: CurvedCarrier) =>
    resultCarriers.some((other) => sameCarrier(carrier, other));
  // The faces that rigidly moved and are not one of the moved faces.
  const carried: { face: number; carrier: CurvedCarrier }[] = [];
  for (const face of kernel.getSolidFaces(source)) {
    if (movedSet.has(face)) continue;
    const carrier = carrierOf(kernel, face);
    if (!carrier) continue;
    const shifted = translated(carrier, displacement);
    // A carrier the displacement leaves where it was (a bore along the
    // move) cannot show a carry.
    if (sameCarrier(carrier, shifted)) continue;
    if (present(carrier) || !present(shifted)) continue;
    carried.push({ face, carrier });
  }
  if (carried.length === 0) return null;
  // Only now, with a proven carry, read the rim the move was allowed to take.
  const edgeFaces = edgeToFaceMapOf(kernel, source);
  const rim = new Set<number>();
  for (const face of moved) {
    for (const edge of kernel.getFaceEdges(face)) {
      for (const other of edgeFaces[String(edge)] ?? []) {
        if (!movedSet.has(other)) rim.add(other);
      }
    }
  }
  const bandRadii: number[] = [];
  for (const band of rim) {
    if (surfaceTypeOf(kernel, band) === 'plane') continue;
    const radius = blendRadiusOf(kernel, source, band, carrierOf(kernel, band));
    if (radius !== null) bandRadii.push(radius);
  }
  for (const { face, carrier } of carried) {
    if (rim.has(face)) continue;
    const radius = blendRadiusOf(kernel, source, face, carrier);
    if (
      radius !== null &&
      bandRadii.some(
        (band) => Math.abs(band - radius) <= lengthTolerance(radius)
      )
    ) {
      continue;
    }
    return { face, carrier: describe(carrier) };
  }
  return null;
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
