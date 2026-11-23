/**
 * Offsetting a planar face whose whole rim is chamfered: carry the chamfer.
 *
 * The pinned kernel's face move does not recognise a chamfer ring as a blend
 * it should carry. It treats the chamfer faces as neighbours to re-limit:
 *
 * - where the chamfer runs over rounded corners (cones), the move is refused
 *   at any distance ("conical cap reaches or crosses its support apex",
 *   "swept face reaches nonadjacent face");
 * - on a sharp-cornered body (only planes), it succeeds and extends the
 *   chamfer planes instead of moving them, so pushing a chamfered bottom in
 *   grows the body sideways and pulling it out tapers the walls. Both
 *   results pass solid validation.
 *
 * Carrying the chamfer is a rigid translation of the cap and its chamfer
 * ring along the cap's normal, with the walls they stand on lengthened or
 * shortened. Walls that are planes or cylinders parallel to that normal are
 * unchanged by the translation; only the straight edges running up them
 * from the rim change length. So the edit is made on the native arena, as
 * `exact-local-chamfer-cap.ts` does for a round end: translate the moved
 * vertices, curves and surfaces, re-trim the connecting lines, and leave
 * every other record as serialized. Nothing is re-fitted, sewn or cut.
 *
 * A conservative clearance certificate proves the translated band meets
 * nothing: pulled out, nothing of the body may lie beyond the cap; pushed
 * in, nothing but the band and its walls may lie below the band's new top.
 * The bounds come from analytic supports and curve control hulls, never
 * from tessellation or sampling.
 *
 * A rim of chamfer faces (tilted planes and cones about the normal) and
 * square sides takes this path, whole or partial, when every chamfer face
 * stands on walls. A rounded edge, or a tilted face that climbs to anything
 * but a wall (a draft), keeps the kernel's move. A chamfered rim this cannot
 * prove refuses, typed, rather than fall through to the kernel move that
 * builds the wrong body.
 */
import { findFeature, resolveParamValue } from '@openzcad/document-core';
import type { Vec3 } from '@openzcad/geometry';
import type { FeatureId, ProjectDocument } from '@openzcad/shared';
import {
  ANALYTIC_MATCH_EPSILON,
  GEOMETRY_EPSILON,
  add,
  cross,
  dot,
  finiteVec3,
  length,
  normalized,
  scale,
  subtract
} from './exact-math';
import { editNativeArena, type Arena } from './exact-local-chamfer-cap';
import { OffsetFaceRefusal } from './exact-offset-face-refusal';
import { KernelRefusal } from './kernel-refusal';
import { surfaceTypeOf } from './exact-sync-memo';
import type { RemusKernel } from './remus-runtime';
import type { RemusMoveFacesRelation } from './remus-lineage';

/** The adapter's code for this refusal; the kernel has none. */
export const OFFSET_FACE_CHAMFER_RIM_NOT_CARRIED =
  'offset_face_chamfer_rim_not_carried';

type Point = [number, number, number];

/** A chamfer's two setbacks, in either order. */
export type ChamferSetback = readonly [number, number];
type Surface = Arena['faces'][number]['surface'] & {
  Torus?: { z_axis?: Point };
};

const vector = (p: readonly number[]): Vec3 => ({
  x: p[0]!,
  y: p[1]!,
  z: p[2]!
});
const point = (v: Vec3): Point => [v.x, v.y, v.z];

/** The tilt that separates a chamfer from a wall (0) or a step (1). */
const TILT_EPSILON = 1e-6;
/** Closer to parallel than this, a neighbour is coplanar with the face. */
const PARALLEL_EPSILON = 1e-12;

export function chamferRimNotCarriedRefusal(
  offset: number,
  detail: string,
  cause?: unknown
): OffsetFaceRefusal {
  const reason =
    "This face's chamfered edge can't move with it here. Remove the chamfer in History, offset the face, then chamfer the edge again.";
  const kernelMessage = `Offsetting the face by ${offset}: ${detail}${
    cause instanceof Error ? `: ${cause.message}` : ''
  }`;
  return new OffsetFaceRefusal({
    family: 'direct-edit',
    category: 'unsupported',
    kernelCode: OFFSET_FACE_CHAMFER_RIM_NOT_CARRIED,
    kernelMessage,
    reason,
    message: `${reason}\n${kernelMessage}`,
    ...(cause instanceof Error ? { cause } : {})
  });
}

/** Thrown inside the arena edit; says why the carry was not proven. */
class CarryDeclined extends Error {}

/**
 * Thrown inside the arena edit when the chamfer is only round holes in the
 * face: the kernel's move carries a hole-mouth chamfer (esaueng/remus#1808)
 * and the hole-mouth guard checks it, so that stays the general path.
 */
class HoleMouthsOnly extends Error {}

function uniqueEdges(kernel: RemusKernel, face: number): number[] {
  return [...new Set(kernel.getFaceEdges(face))];
}

function unitOf(p: readonly number[] | undefined): Vec3 | null {
  const v = finiteVec3(p ? Array.from(p) : undefined);
  return v ? normalized(v) : null;
}

const parallel = (a: readonly number[], n: Vec3) => {
  const unit = unitOf(a);
  return (
    !!unit && Math.abs(Math.abs(dot(unit, n)) - 1) <= ANALYTIC_MATCH_EPSILON
  );
};

const perpendicular = (a: readonly number[], n: Vec3) => {
  const unit = unitOf(a);
  return !!unit && Math.abs(dot(unit, n)) <= ANALYTIC_MATCH_EPSILON;
};

/** Length of `v`'s component across the unit `axis`. */
function across(v: Vec3, axis: Vec3): number {
  return length(subtract(v, scale(axis, dot(v, axis))));
}

type Role = 'chamfer' | 'wall' | 'other';

/**
 * A face's part in a chamfered rim about `normal`: a chamfer face (a plane
 * tilted between square and parallel, or a cone about the normal), a wall
 * the band can slide along (a square plane, or a cylinder about the
 * normal), or anything else. Read on the live kernel before serialization.
 */
function roleOf(kernel: RemusKernel, face: number, normal: Vec3): Role {
  const type = surfaceTypeOf(kernel, face);
  if (type === 'plane') {
    const m = finiteVec3(Array.from(kernel.getFaceNormal(face)));
    if (!m) return 'other';
    const tilt = dot(m, normal);
    if (Math.abs(tilt) <= ANALYTIC_MATCH_EPSILON) return 'wall';
    // Any tilt short of parallel is part of the band: a nearly flat bevel
    // (10 across, 0.01 up) is still one the kernel's move can extend.
    return tilt > TILT_EPSILON && tilt < 1 - PARALLEL_EPSILON
      ? 'chamfer'
      : 'other';
  }
  if (type === 'cone' || type === 'cylinder') {
    try {
      const params = JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
        axis?: number[];
      };
      if (params.axis === undefined || !parallel(params.axis, normal))
        return 'other';
      return type === 'cone' ? 'chamfer' : 'wall';
    } catch {
      return 'other';
    }
  }
  return 'other';
}

/** Whether a serialized surface is unchanged by a slide along `normal`. */
function slidesAlong(surface: Arena['faces'][number]['surface'], normal: Vec3) {
  return surface.Plane
    ? perpendicular(surface.Plane.normal, normal)
    : surface.Cylinder
      ? parallel(surface.Cylinder.axis, normal)
      : false;
}

/**
 * The cap's chamfer faces when its rim is a chamfered band standing on
 * walls, else null. Every face beside the cap is a chamfer face or a wall,
 * at least one is a chamfer face, and every chamfer face's other neighbours
 * are walls. A tilted face that climbs to anything else is a draft, which
 * the kernel's move re-limits correctly.
 */
function chamferBand(
  kernel: RemusKernel,
  solid: number,
  face: number,
  normal: Vec3,
  /** The history's chamfer setbacks, or null to take the shape alone. */
  setbacks: readonly ChamferSetback[] | null
): number[] | null {
  const edgesOf = new Map<number, number[]>();
  const owners = new Map<number, number[]>();
  for (const f of kernel.getSolidFaces(solid)) {
    const edges = uniqueEdges(kernel, f);
    edgesOf.set(f, edges);
    for (const edge of edges)
      owners.set(edge, [...(owners.get(edge) ?? []), f]);
  }
  const neighbours = (f: number) =>
    new Set(
      (edgesOf.get(f) ?? [])
        .flatMap((edge) => owners.get(edge) ?? [])
        .filter((other) => other !== f)
    );
  const roles = new Map<number, Role>();
  const role = (f: number) => {
    let known = roles.get(f);
    if (known === undefined) {
      known = roleOf(kernel, f, normal);
      roles.set(f, known);
    }
    return known;
  };
  const beside = [...neighbours(face)];
  if (beside.some((f) => role(f) === 'other')) return null;
  const band = beside.filter((f) => role(f) === 'chamfer');
  // Chamfered hole mouths alone stay the kernel's (see HoleMouthsOnly).
  const outer = new Set(kernel.getWireEdges(kernel.getFaceOuterWire(face)));
  if (!band.some((f) => edgesOf.get(f)!.some((edge) => outer.has(edge))))
    return null;
  const inBand = new Set([face, ...band]);
  for (const f of band) {
    for (const other of neighbours(f)) {
      if (!inBand.has(other) && role(other) !== 'wall') return null;
    }
  }
  if (setbacks === null) return band;
  // A drafted section standing on walls is the same shape as a chamfer
  // band; only history tells them apart. Carry a band only when every face
  // of it has the setbacks of a chamfer the document applied.
  const capPoint = edgeEnds(kernel, edgesOf.get(face)![0]!)[0];
  const inward = scale(normal, -1);
  for (const f of band) {
    const setback = bandSetback(
      kernel,
      f,
      edgesOf.get(f)!,
      normal,
      capPoint,
      inward
    );
    if (!setback || !setbacks.some((known) => sameSetback(known, setback)))
      return null;
  }
  return band;
}

function edgeEnds(kernel: RemusKernel, edge: number): [Vec3, Vec3] {
  const v = kernel.getEdgeVertices(edge);
  return [
    { x: v[0]!, y: v[1]!, z: v[2]! },
    { x: v[3]!, y: v[4]!, z: v[5]! }
  ];
}

/**
 * A chamfer face's [rise up the wall, inset across the cap], or null. The
 * rise is its height above the cap; the inset follows from the plane's tilt,
 * or from a cone's two rim radii.
 */
function bandSetback(
  kernel: RemusKernel,
  face: number,
  edges: readonly number[],
  normal: Vec3,
  capPoint: Vec3,
  inward: Vec3
): ChamferSetback | null {
  const points = edges.flatMap((edge) => edgeEnds(kernel, edge));
  if (points.length === 0) return null;
  const rise = Math.max(
    ...points.map((p) => dot(subtract(p, capPoint), inward))
  );
  if (!(rise > GEOMETRY_EPSILON)) return null;
  if (surfaceTypeOf(kernel, face) === 'plane') {
    const m = finiteVec3(Array.from(kernel.getFaceNormal(face)));
    if (!m) return null;
    const tilt = dot(m, normal);
    return [rise, (rise * tilt) / Math.sqrt(1 - tilt * tilt)];
  }
  try {
    const params = JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
      apex?: number[];
      axis?: number[];
    };
    const apex = finiteVec3(params.apex);
    const axis = unitOf(params.axis);
    if (!apex || !axis) return null;
    const radii = points.map((p) => across(subtract(p, apex), axis));
    return [rise, Math.max(...radii) - Math.min(...radii)];
  } catch {
    return null;
  }
}

function sameSetback(a: ChamferSetback, b: ChamferSetback): boolean {
  const close = (x: number, y: number) =>
    Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
  return (
    (close(a[0], b[0]) && close(a[1], b[1])) ||
    (close(a[0], b[1]) && close(a[1], b[0]))
  );
}

/**
 * The bodies `bodyId` was built from: itself, the bodies its producing
 * feature consumed, and theirs. A feature's inputs are read from every body
 * id its data names, which can only over-include an input, never drop one.
 */
function bodyAncestry(document: ProjectDocument, bodyId: string): Set<string> {
  const producers = new Map<string, unknown>();
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'feature' && 'bodyId' in node && node.bodyId)
      producers.set(node.bodyId, node.data);
  }
  const inputsOf = (data: unknown): string[] =>
    data && typeof data === 'object'
      ? Object.values(data).flatMap((value: unknown) =>
          (Array.isArray(value) ? value : [value]).filter(
            (item): item is string =>
              typeof item === 'string' && item.startsWith('body_')
          )
        )
      : [];
  const seen = new Set<string>();
  const queue = [bodyId];
  while (queue.length) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...inputsOf(producers.get(next)));
  }
  return seen;
}

/**
 * The [first, second] setbacks of every chamfer that precedes `featureId`
 * in the history and built `bodyId` or one of the bodies it came from,
 * resolved in `scope`. A chamfer elsewhere in the document cannot have made
 * a band on this body. A chamfer whose sizes do not resolve contributes
 * nothing.
 */
export function chamferSetbacksBefore(
  document: ProjectDocument,
  featureId: FeatureId,
  bodyId: string,
  scope: Record<string, number>
): ChamferSetback[] {
  const setbacks: ChamferSetback[] = [];
  const ancestry = bodyAncestry(document, bodyId);
  for (const id of document.featureOrder) {
    if (id === featureId) break;
    const node = findFeature(document, id);
    const data = node?.data;
    if (data?.featureKind !== 'chamfer') continue;
    if (
      !node ||
      !('bodyId' in node) ||
      !node.bodyId ||
      !ancestry.has(node.bodyId)
    )
      continue;
    try {
      const first = resolveParamValue(
        data.distance,
        scope,
        'distance',
        document.units
      );
      const second =
        data.distance2 !== undefined
          ? resolveParamValue(data.distance2, scope, 'distance', document.units)
          : data.angleDeg !== undefined
            ? first *
              Math.tan(
                (resolveParamValue(
                  data.angleDeg,
                  scope,
                  'angle',
                  document.units
                ) *
                  Math.PI) /
                  180
              )
            : first;
      if (Number.isFinite(first) && Number.isFinite(second))
        setbacks.push([first, second]);
    } catch {
      // An unresolvable chamfer failed its own build; it made no band.
    }
  }
  return setbacks;
}

/**
 * A lower bound of the linear height `project` (unit gradient `direction`)
 * over one edge, or null when its curve kind has no proven bound.
 */
function edgeMinimum(
  arena: Arena,
  edge: number,
  project: (p: Vec3) => number,
  direction: Vec3
): number | null {
  const record = arena.edges[edge]!;
  const ends = [
    project(vector(arena.vertices[record.start]!.point)),
    project(vector(arena.vertices[record.end]!.point))
  ];
  if (record.curve === 'Line') return Math.min(...ends);
  const curve = record.curve as {
    Circle?: { center: Point; radius: number; u_axis: Point; v_axis: Point };
    NurbsCurve?: { control_points?: Point[] };
  };
  if (curve.Circle) {
    const c = curve.Circle;
    return (
      project(vector(c.center)) -
      c.radius *
        Math.hypot(
          dot(vector(c.u_axis), direction),
          dot(vector(c.v_axis), direction)
        )
    );
  }
  const hull = curve.NurbsCurve?.control_points;
  if (Array.isArray(hull) && hull.length > 0) {
    // A B-spline lies in the convex hull of its control points.
    return Math.min(...ends, ...hull.map((p) => project(vector(p))));
  }
  return null;
}

function boundaryMinimum(
  arena: Arena,
  edges: readonly number[],
  project: (p: Vec3) => number,
  direction: Vec3
): number | null {
  let lowest = Infinity;
  for (const edge of edges) {
    const value = edgeMinimum(arena, edge, project, direction);
    if (value === null) return null;
    lowest = Math.min(lowest, value);
  }
  return lowest;
}

/**
 * A conservative lower bound of `project` over a whole face, or null when
 * its surface has no proven bound.
 */
function faceMinimum(
  arena: Arena,
  face: number,
  edges: readonly number[],
  project: (p: Vec3) => number,
  direction: Vec3
): number | null {
  const surface = arena.faces[face]!.surface as Surface;
  if (edges.length === 0) return null;
  if (surface.Plane) return boundaryMinimum(arena, edges, project, direction);
  const axial = surface.Cylinder?.axis ?? surface.Cone?.axis;
  if (axial && parallel(axial, direction)) {
    // Height along the axis has no interior extremum on an axial cylinder
    // or cone, so its boundary bounds it.
    return boundaryMinimum(arena, edges, project, direction);
  }
  if (surface.Cylinder) {
    // A tilted cylinder lies within its radius of the axis segment its
    // boundary spans; the axial coordinate has no interior extremum.
    const unit = unitOf(surface.Cylinder.axis);
    if (!unit) return null;
    const origin = vector(surface.Cylinder.origin);
    const along = (p: Vec3) => dot(subtract(p, origin), unit);
    const low = boundaryMinimum(arena, edges, along, unit);
    const high = boundaryMinimum(
      arena,
      edges,
      (p) => -along(p),
      scale(unit, -1)
    );
    if (low === null || high === null) return null;
    const ends = [low, -high].map((t) => project(add(origin, scale(unit, t))));
    return (
      Math.min(...ends) - surface.Cylinder.radius * across(direction, unit)
    );
  }
  if (surface.Torus) {
    const { center, major_radius, minor_radius, z_axis } = surface.Torus;
    const axis = unitOf(z_axis);
    const sweep = axis ? across(direction, axis) : 1;
    return project(vector(center)) - major_radius * sweep - minor_radius;
  }
  if (surface.Sphere) {
    return project(vector(surface.Sphere.center)) - surface.Sphere.radius;
  }
  if (surface.Nurbs) {
    const { control_points: rows, weights } = surface.Nurbs;
    if (
      rows.length !== weights.length ||
      rows.some(
        (row, i) =>
          row.length !== weights[i]!.length ||
          weights[i]!.some((weight) => !Number.isFinite(weight) || weight <= 0)
      )
    )
      return null;
    return Math.min(...rows.flat().map((p) => project(vector(p))));
  }
  return null;
}

/** Translate the cap and its chamfer ring by `offset` along the cap normal. */
function carryRim(
  kernel: RemusKernel,
  arena: Arena,
  cap: number,
  offset: number
): boolean {
  if (!arena.faces[cap]!.surface.Plane) return false;
  const normal = finiteVec3(Array.from(kernel.getFaceNormal(cap)));
  if (!normal) return false;
  const inward = scale(normal, -1);
  const edgesOf = new Map<number, number[]>();
  const owners = new Map<number, number[]>();
  for (let f = 0; f < arena.faces.length; f++) {
    const edges = uniqueEdges(kernel, f);
    edgesOf.set(f, edges);
    for (const edge of edges)
      owners.set(edge, [...(owners.get(edge) ?? []), f]);
  }
  const capEdges = new Set(edgesOf.get(cap));
  if (capEdges.size === 0) return false;
  const origin = vector(
    arena.vertices[arena.edges[[...capEdges][0]!]!.start]!.point
  );
  // Height into the body, measured from the cap.
  const height = (p: Vec3) => dot(subtract(p, origin), inward);

  // The chamfer faces; the cap's square sides are walls like the rest.
  const ring = [...edgesOf.keys()].filter(
    (f) =>
      f !== cap &&
      edgesOf.get(f)!.some((edge) => capEdges.has(edge)) &&
      !slidesAlong(arena.faces[f]!.surface, normal)
  );
  if (ring.length === 0) return false;
  const outer = new Set(
    arena.wires[arena.faces[cap]!.outer_wire]!.edges.map((use) => use.edge)
  );
  if (!ring.some((f) => edgesOf.get(f)!.some((edge) => outer.has(edge)))) {
    throw new HoleMouthsOnly();
  }
  for (const f of ring) {
    const surface = arena.faces[f]!.surface;
    if (surface.Cone ? !parallel(surface.Cone.axis, normal) : !surface.Plane)
      return false;
  }
  const moved = new Set([cap, ...ring]);
  const movedEdges = new Set([...moved].flatMap((f) => edgesOf.get(f)!));
  const movedVertices = new Set(
    [...movedEdges].flatMap((e) => [arena.edges[e]!.start, arena.edges[e]!.end])
  );
  for (const edge of movedEdges) {
    const curve = arena.edges[edge]!.curve;
    if (curve !== 'Line' && !curve.Circle) {
      throw new CarryDeclined('a chamfer edge is not a line or a circle');
    }
    // Two faces, or one whose seam it is.
    const owning = owners.get(edge) ?? [];
    if (!(
      owning.length === 2 ||
      (owning.length === 1 && moved.has(owning[0]!))
    ))
      return false;
  }
  // The walls the band stands on: unchanged by a slide along the normal.
  const walls = new Set(
    [...movedEdges]
      .flatMap((edge) => owners.get(edge)!)
      .filter((f) => !moved.has(f))
  );
  // A wall within the analytic match of square still tilts: sliding the
  // rim along it by the offset would leave the rim that far off its wall.
  const driftLimit =
    0.1 *
    Math.min(
      ...[...movedVertices].map((v) => arena.vertices[v]!.tolerance),
      1e-7
    );
  for (const wall of walls) {
    const surface = arena.faces[wall]!.surface;
    const lean = surface.Plane
      ? Math.abs(dot(unitOf(surface.Plane.normal) ?? normal, normal))
      : surface.Cylinder
        ? across(normal, unitOf(surface.Cylinder.axis) ?? { x: 0, y: 0, z: 0 })
        : Infinity;
    if (!(lean * Math.abs(offset) <= driftLimit)) {
      throw new CarryDeclined(
        'a wall leans too far off the face normal to slide the chamfer along it'
      );
    }
    if (!slidesAlong(surface, normal)) {
      throw new CarryDeclined(
        'the chamfer meets a wall that is not straight along the face normal'
      );
    }
  }
  // Straight edges running up the walls from the rim stretch or shorten.
  const connectors = new Set<number>();
  for (let e = 0; e < arena.edges.length; e++) {
    if (movedEdges.has(e)) continue;
    const edge = arena.edges[e]!;
    const startMoves = movedVertices.has(edge.start);
    const endMoves = movedVertices.has(edge.end);
    if (!startMoves && !endMoves) continue;
    const a = vector(arena.vertices[edge.start]!.point);
    const b = vector(arena.vertices[edge.end]!.point);
    if (
      startMoves === endMoves ||
      edge.curve !== 'Line' ||
      !(owners.get(e) ?? []).every((f) => walls.has(f)) ||
      across(subtract(b, a), normal) > ANALYTIC_MATCH_EPSILON
    ) {
      throw new CarryDeclined(
        'the chamfer is joined to something other than straight walls'
      );
    }
    connectors.add(e);
  }

  const heights = [...movedVertices].map((v) =>
    height(vector(arena.vertices[v]!.point))
  );
  const band = Math.max(...heights);
  const tolerance =
    Math.max(1, band, Math.abs(offset)) * ANALYTIC_MATCH_EPSILON;
  // Pulled out, nothing may lie beyond the cap; pushed in, nothing but the
  // band and its walls may lie below the band's new top.
  const floor = offset > 0 ? -tolerance : band - offset + tolerance;
  for (const [face, edges] of edgesOf) {
    if (moved.has(face)) continue;
    // An axial wall is bounded by its boundary, of which only the rim and
    // the connectors move.
    const lowest = walls.has(face)
      ? boundaryMinimum(
          arena,
          edges.filter((e) => !movedEdges.has(e) && !connectors.has(e)),
          height,
          inward
        )
      : faceMinimum(arena, face, edges, height, inward);
    if (lowest === null) {
      throw new CarryDeclined(
        'the clearance of a nearby face cannot be proven'
      );
    }
    if (lowest < floor) {
      throw new CarryDeclined(
        offset > 0
          ? 'part of the body lies beyond the face'
          : 'the chamfer would run into another part of the body'
      );
    }
  }
  // A stored UV trace would go stale on a re-trimmed wall.
  if (
    arena.boundary_authority.coedges.some(
      (coedge) =>
        coedge.pcurve != null &&
        (movedEdges.has(coedge.edge) || connectors.has(coedge.edge))
    )
  ) {
    throw new CarryDeclined('a wall carries a stored UV trace');
  }

  const shift = scale(normal, offset);
  for (const v of movedVertices) {
    const record = arena.vertices[v]!;
    record.point = point(add(vector(record.point), shift));
  }
  for (const e of movedEdges) {
    const curve = arena.edges[e]!.curve;
    if (curve !== 'Line' && curve.Circle) {
      curve.Circle.center = point(add(vector(curve.Circle.center), shift));
    }
  }
  for (const f of moved) {
    const surface = arena.faces[f]!.surface;
    if (surface.Plane) {
      surface.Plane.d += dot(vector(surface.Plane.normal), shift);
    } else if (surface.Cone) {
      surface.Cone.apex = point(add(vector(surface.Cone.apex), shift));
    }
  }
  for (const e of connectors) {
    const record = arena.edges[e]!;
    const span = length(
      subtract(
        vector(arena.vertices[record.start]!.point),
        vector(arena.vertices[record.end]!.point)
      )
    );
    if (span <= tolerance) {
      throw new CarryDeclined('a wall would shrink to nothing');
    }
    if (record.trim != null) record.trim = [0, span];
  }
  return true;
}

/**
 * The carried result, or null when the face's rim is not a chamfered band
 * on walls (the general move handles it). Throws a typed refusal when the rim
 * is a chamfer ring this cannot carry exactly.
 */
export function tryCarryChamferRim(
  kernel: RemusKernel,
  solid: number,
  face: number,
  offset: number,
  /** The setbacks of the chamfers in this edit's history. */
  setbacks: readonly ChamferSetback[]
): { solid: number; relation: RemusMoveFacesRelation } | null {
  if (
    setbacks.length === 0 ||
    !Number.isFinite(offset) ||
    Math.abs(offset) <= GEOMETRY_EPSILON ||
    surfaceTypeOf(kernel, face) !== 'plane'
  ) {
    return null;
  }
  const normal = finiteVec3(Array.from(kernel.getFaceNormal(face)));
  if (!normal) return null;
  if (chamferBand(kernel, solid, face, normal, setbacks) === null) return null;
  let carried: { solid: number; relation: RemusMoveFacesRelation } | null;
  try {
    carried = editNativeArena(kernel, solid, face, (probe, arena, cap) =>
      carryRim(probe, arena, cap, offset)
    );
  } catch (error) {
    if (error instanceof KernelRefusal) throw error;
    if (error instanceof HoleMouthsOnly) return null;
    throw error instanceof CarryDeclined
      ? chamferRimNotCarriedRefusal(offset, error.message)
      : chamferRimNotCarriedRefusal(
          offset,
          'the carried chamfer could not be verified',
          error
        );
  }
  if (carried === null) {
    throw chamferRimNotCarriedRefusal(
      offset,
      'the chamfer ring is not one this can carry exactly'
    );
  }
  return carried;
}

/*
 * A chamfer-shaped band the carry above does not take.
 *
 * Without a chamfer in the history (a STEP import, chiefly) a band of tilted
 * faces between the cap and its walls may be a chamfer or a drafted
 * section; the two are the same B-rep. Neither the kernel's recognizer (it
 * calls any plane tilted between two planes a chamfer, drafts included) nor
 * the band's proportions separate them. So the kernel's move keeps such a
 * band, and its re-limit is the right offset of a drafted section (on
 * some bands, one with a chamfered hole mouth or a full cone, the pinned
 * kernel carries the band instead, which is right for a chamfer). What is
 * refused is a result that is neither:
 *
 * - pushed in as far as the band's top, the tilted faces would have to pass
 *   their walls. The move does not change topology, so it cannot consume
 *   the band: the pinned kernel extends the tilted planes past the walls,
 *   growing the body sideways (a box chamfered 0.35 round its base, pushed
 *   in 2, came out 1.65 wider on every side, its walls ending at 0.35
 *   under an overhang).
 * - pulled out until tilted faces cross, the re-limited face turns inside
 *   out (a 60 × 40 base pulled 20 under a 0.35 chamfer became a 19.3 × 0.7
 *   strip traced backwards; pulled 120, both pairs crossed and the face
 *   kept its winding at 180.7 × 200.7) and the solid still validates.
 *
 * Both are read exactly off the move's output: the moved face must be on
 * the plane it was sent to, each of its loops must keep its winding and not
 * cross another, and each straight edge must lie on a neighbouring plane of
 * the source (in place for a re-limit, translated with the face for a
 * carry) with the face on the same side of it. Pushed in past the band's
 * top, only the carry is accepted: every tilted plane and every arc must
 * have moved with the face. Nothing is sampled.
 */

/** One edge of a face's loop, in the loop's direction. */
type LoopEdge =
  | { kind: 'line'; a: Vec3; b: Vec3; edge: number }
  | {
      kind: 'arc';
      a: Vec3;
      b: Vec3;
      center: Vec3;
      radius: number;
      /** The circle's axis, and the swept angle about it (signed). */
      axis: Vec3;
      start: number;
      sweep: number;
      u: Vec3;
      v: Vec3;
    };

interface CapLoop {
  /** The winding about the face's outward normal: 1 or -1. */
  sign: number;
  edges: LoopEdge[];
}

function parseArena(kernel: RemusKernel, solid: number): Arena {
  return JSON.parse(
    new TextDecoder().decode(kernel.serializeSolids(Uint32Array.of(solid)))
  ) as Arena;
}

/**
 * The loops of one serialized face, each with its winding about the face's
 * outward normal, or null when a loop has an edge kind with no exact area.
 */
function capLoops(
  arena: Arena,
  face: number,
  outward: Vec3,
  tolerance: number
): CapLoop[] | null {
  const record = arena.faces[face]!;
  const loops: CapLoop[] = [];
  for (const wire of [record.outer_wire, ...record.inner_wires]) {
    const edges: LoopEdge[] = [];
    // Twice the area vector: a × b per line, c × (b − a) + r²Δθ·n per arc,
    // all about a point of the loop. Absolute coordinates far from the
    // origin cancel catastrophically and lose a small loop's winding.
    const firstUse = arena.wires[wire]!.edges[0];
    if (!firstUse) return null;
    const firstEdge = arena.edges[firstUse.edge]!;
    const origin = vector(
      arena.vertices[firstUse.forward ? firstEdge.start : firstEdge.end]!.point
    );
    let area: Vec3 = { x: 0, y: 0, z: 0 };
    for (const use of arena.wires[wire]!.edges) {
      const edge = arena.edges[use.edge]!;
      const from = vector(
        arena.vertices[use.forward ? edge.start : edge.end]!.point
      );
      const to = vector(
        arena.vertices[use.forward ? edge.end : edge.start]!.point
      );
      if (edge.curve === 'Line') {
        edges.push({ kind: 'line', a: from, b: to, edge: use.edge });
        area = add(area, cross(subtract(from, origin), subtract(to, origin)));
        continue;
      }
      const circle = edge.curve.Circle;
      const trim = edge.trim;
      if (!circle || !trim) return null;
      const u = unitOf(circle.u_axis);
      const v = unitOf(circle.v_axis);
      if (!u || !v) return null;
      const axis = cross(u, v);
      const center = vector(circle.center);
      const span = trim[1] - trim[0];
      if (!(span > 0)) return null;
      const sweep = use.forward ? span : -span;
      edges.push({
        kind: 'arc',
        a: from,
        b: to,
        center,
        radius: circle.radius,
        axis,
        start: use.forward ? trim[0] : trim[1],
        sweep,
        u,
        v
      });
      area = add(
        area,
        add(
          cross(subtract(center, origin), subtract(to, from)),
          scale(axis, circle.radius * circle.radius * sweep)
        )
      );
    }
    const winding = dot(area, outward) / 2;
    if (!(Math.abs(winding) > tolerance)) return null;
    loops.push({ sign: Math.sign(winding), edges });
  }
  return loops;
}

/** Planar faces of the arena with this outward normal, on the plane through `at`. */
function facesOnPlane(
  arena: Arena,
  normal: Vec3,
  at: Vec3,
  tolerance: number
): { face: number; outward: Vec3 }[] {
  const found: { face: number; outward: Vec3 }[] = [];
  arena.faces.forEach((record, face) => {
    const plane = record.surface.Plane;
    if (!plane) return;
    const n = unitOf(plane.normal);
    if (!n) return;
    const outward = record.reversed ? scale(n, -1) : n;
    if (dot(outward, normal) < 1 - ANALYTIC_MATCH_EPSILON) return;
    if (Math.abs(dot(n, at) - plane.d) > tolerance) return;
    found.push({ face, outward });
  });
  return found;
}

/** The angle of `p` on an arc's circle, unwrapped from the arc's start. */
function onArc(
  arc: Extract<LoopEdge, { kind: 'arc' }>,
  p: Vec3,
  slack: number
): boolean {
  const d = subtract(p, arc.center);
  let angle = Math.atan2(dot(d, arc.v), dot(d, arc.u)) - arc.start;
  const turn = 2 * Math.PI;
  if (arc.sweep >= 0) {
    angle = ((angle % turn) + turn) % turn;
    return angle <= arc.sweep + slack || angle >= turn - slack;
  }
  angle = ((-angle % turn) + turn) % turn;
  return angle <= -arc.sweep + slack || angle >= turn - slack;
}

/** Whether two loop edges meet (or come within `tolerance`), in the cap plane. */
function edgesMeet(a: LoopEdge, b: LoopEdge, tolerance: number): boolean {
  if (a.kind === 'line' && b.kind === 'line') {
    return segmentDistance(a.a, a.b, b.a, b.b) <= tolerance;
  }
  if (a.kind === 'line' || b.kind === 'line') {
    const line = (a.kind === 'line' ? a : b) as Extract<
      LoopEdge,
      { kind: 'line' }
    >;
    const arc = (a.kind === 'arc' ? a : b) as Extract<
      LoopEdge,
      { kind: 'arc' }
    >;
    // The segment against the circle, then the hits against the arc.
    const span = subtract(line.b, line.a);
    const reach = length(span);
    if (!(reach > 0)) return true;
    const dir = scale(span, 1 / reach);
    const toCenter = subtract(arc.center, line.a);
    const along = dot(toCenter, dir);
    const offAxis = across(toCenter, dir);
    if (offAxis > arc.radius + tolerance) return false;
    const half = Math.sqrt(
      Math.max(0, arc.radius * arc.radius - offAxis * offAxis)
    );
    const slack = tolerance / Math.max(arc.radius, tolerance);
    for (const t of [along - half, along + half, along]) {
      if (t < -tolerance || t > reach + tolerance) continue;
      const hit = add(line.a, scale(dir, Math.min(reach, Math.max(0, t))));
      const radial = Math.abs(length(subtract(hit, arc.center)) - arc.radius);
      if (radial <= tolerance && onArc(arc, hit, slack)) return true;
    }
    // An arc end on the segment.
    return [arc.a, arc.b].some(
      (p) => segmentDistance(p, p, line.a, line.b) <= tolerance
    );
  }
  // Two arcs: the circles' crossings, then each against both arcs.
  const between = subtract(b.center, a.center);
  const gap = length(between);
  const slack = tolerance / Math.max(Math.min(a.radius, b.radius), tolerance);
  if (gap <= tolerance && Math.abs(a.radius - b.radius) <= tolerance) {
    // One circle: they meet where either holds an end of the other.
    return (
      onArc(a, b.a, slack) ||
      onArc(a, b.b, slack) ||
      onArc(b, a.a, slack) ||
      onArc(b, a.b, slack)
    );
  }
  if (
    gap > a.radius + b.radius + tolerance ||
    gap < Math.abs(a.radius - b.radius) - tolerance
  )
    return false;
  const toward = scale(between, 1 / gap);
  const x = (gap * gap + a.radius * a.radius - b.radius * b.radius) / (2 * gap);
  const h = Math.sqrt(Math.max(0, a.radius * a.radius - x * x));
  const side = normalized(cross(a.axis, toward));
  if (!side) return true;
  const foot = add(a.center, scale(toward, x));
  return [add(foot, scale(side, h)), subtract(foot, scale(side, h))].some(
    (p) => onArc(a, p, slack) && onArc(b, p, slack)
  );
}

/** The least distance between two segments. */
function segmentDistance(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = subtract(q1, p1);
  const d2 = subtract(q2, p2);
  const r = subtract(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number;
  let t: number;
  if (a <= 0 && e <= 0) return length(r);
  if (a <= 0) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= 0) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 0 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  return length(subtract(add(p1, scale(d1, s)), add(p2, scale(d2, t))));
}

/**
 * The winding of a face's outer loop when its holes wind the other way, as
 * every valid face does, else null.
 */
function windingOf(loops: readonly CapLoop[]): number | null {
  const outer = loops[0]?.sign;
  return outer !== undefined &&
    loops.slice(1).every((loop) => loop.sign === -outer)
    ? outer
    : null;
}

/** Why the loops are not a face's boundary, or null when they are. */
function loopsFault(
  loops: readonly CapLoop[],
  winding: number,
  tolerance: number
): string | null {
  if (windingOf(loops) !== winding) {
    return 'the moved face would turn inside out';
  }
  const all = loops.flatMap((loop, l) =>
    loop.edges.map((edge, i) => ({ edge, l, i, n: loop.edges.length }))
  );
  for (let x = 0; x < all.length; x++) {
    for (let y = x + 1; y < all.length; y++) {
      const p = all[x]!;
      const q = all[y]!;
      if (
        p.l === q.l &&
        (Math.abs(p.i - q.i) <= 1 || Math.abs(p.i - q.i) === p.n - 1)
      )
        continue;
      if (edgesMeet(p.edge, q.edge, tolerance)) {
        return 'the moved face would cross itself';
      }
    }
  }
  return null;
}

/**
 * Guards the kernel's move of a chamfer-shaped band the carry did not take
 * (see the note above). Returns null when the face's rim is not such a
 * band. Otherwise it returns the check the move's output must pass, which
 * throws the typed refusal when the moved face is not where it was sent,
 * its loops turned or crossed, or its edges left their neighbours.
 */
export function guardUncarriedChamferBand(
  kernel: RemusKernel,
  solid: number,
  face: number,
  offset: number
): ((output: number) => void) | null {
  if (
    !Number.isFinite(offset) ||
    Math.abs(offset) <= GEOMETRY_EPSILON ||
    surfaceTypeOf(kernel, face) !== 'plane'
  ) {
    return null;
  }
  const normal = finiteVec3(Array.from(kernel.getFaceNormal(face)));
  if (!normal) return null;
  const band = chamferBand(kernel, solid, face, normal, null);
  if (band === null) return null;
  const capEdges = uniqueEdges(kernel, face);
  const capPoint = edgeEnds(kernel, capEdges[0]!)[0];
  const inward = scale(normal, -1);
  // The band's top: the lowest of its corners off the face.
  let top = Infinity;
  for (const f of band) {
    for (const edge of uniqueEdges(kernel, f)) {
      for (const p of edgeEnds(kernel, edge)) {
        const rise = dot(subtract(p, capPoint), inward);
        if (rise > GEOMETRY_EPSILON) top = Math.min(top, rise);
      }
    }
  }
  if (!Number.isFinite(top)) return null;
  const tolerance = Math.max(1, top, Math.abs(offset)) * ANALYTIC_MATCH_EPSILON;
  // Pushed in this far, a re-limit would run the tilted faces past their
  // walls; only a carry can be right, and a refusal names the limit.
  const limit =
    offset < 0 && -offset > top - GEOMETRY_EPSILON * Math.max(1, top)
      ? -Math.round(top * 1e9) / 1e9
      : undefined;
  const refuse = (detail: string) =>
    uncarriedBandRefusal(offset, detail, limit);
  // The source face read the way the output's will be: its loops' winding,
  // and the side of each straight edge its neighbour's plane lies on.
  const source = parseArena(kernel, solid);
  const owners = edgeOwners(source);
  const windings = new Set<number | null>();
  const sides: EdgeSide[] = [];
  const arcs: Extract<LoopEdge, { kind: 'arc' }>[] = [];
  for (const candidate of facesOnPlane(source, normal, capPoint, tolerance)) {
    const loops = capLoops(
      source,
      candidate.face,
      candidate.outward,
      tolerance
    );
    windings.add(loops === null ? null : windingOf(loops));
    for (const edge of loops?.flatMap((loop) => loop.edges) ?? []) {
      if (edge.kind !== 'line') {
        arcs.push(edge);
        continue;
      }
      for (const owner of owners.get(edge.edge) ?? []) {
        if (owner === candidate.face) continue;
        const plane = source.faces[owner]!.surface.Plane;
        const n = plane && unitOf(plane.normal);
        if (!plane || !n) continue;
        sides.push({ n, d: plane.d, side: sideOf(edge, normal, n) });
      }
    }
  }
  const expected = windings.size === 1 ? [...windings][0] : null;
  if (expected === null || expected === undefined) {
    throw refuse('the face could not be read exactly');
  }
  const sent = add(capPoint, scale(normal, offset));
  return (output: number) => {
    const arena = parseArena(kernel, output);
    const after = facesOnPlane(arena, normal, sent, tolerance);
    if (after.length === 0) {
      throw refuse('the move left the face short of where it was sent');
    }
    for (const candidate of after) {
      const loops = capLoops(
        arena,
        candidate.face,
        candidate.outward,
        tolerance
      );
      const fault =
        loops === null
          ? 'the moved face could not be read exactly'
          : (loopsFault(loops, expected, tolerance) ??
            sidesFault(
              loops,
              sides,
              normal,
              offset,
              limit !== undefined,
              tolerance
            ) ??
            (limit === undefined
              ? null
              : arcsFault(loops, arcs, normal, offset, tolerance)));
      if (fault !== null) throw refuse(fault);
    }
  };
}

/** A straight edge's neighbouring plane, and the side the face lies on. */
interface EdgeSide {
  n: Vec3;
  d: number;
  side: number;
}

function edgeOwners(arena: Arena): Map<number, number[]> {
  const owners = new Map<number, number[]>();
  arena.faces.forEach((record, face) => {
    for (const wire of [record.outer_wire, ...record.inner_wires]) {
      for (const { edge } of arena.wires[wire]!.edges) {
        const list = owners.get(edge) ?? [];
        if (!list.includes(face)) list.push(face);
        owners.set(edge, list);
      }
    }
  });
  return owners;
}

/**
 * Which way a loop edge's neighbour plane leans from the face: the face
 * lies left of its edges about its outward normal, so this is the sign of
 * that leftward direction against the neighbour's normal.
 */
function sideOf(
  edge: Extract<LoopEdge, { kind: 'line' }>,
  outward: Vec3,
  n: Vec3
): number {
  return Math.sign(dot(cross(outward, subtract(edge.b, edge.a)), n));
}

/**
 * Why the moved face's straight edges are not its neighbours' edges, or
 * null when they are. A re-limit leaves every neighbouring plane where it
 * was; a carry translates the band's with the face (a wall's is unchanged
 * either way). Past the band's top, a re-limited tilted face would stand
 * past its wall, so only the carried plane will do. Each edge must lie on one of them and keep the face on the
 * side it was: a reversed edge is a face turned past where its neighbours
 * cross, which can keep the loop's winding when two pairs reverse at once.
 */
function sidesFault(
  loops: readonly CapLoop[],
  sides: readonly EdgeSide[],
  outward: Vec3,
  offset: number,
  /** Past the band's top: only a carried neighbour will do. */
  carriedOnly: boolean,
  tolerance: number
): string | null {
  for (const edge of loops.flatMap((loop) => loop.edges)) {
    if (edge.kind !== 'line') continue;
    const on = sides.filter(({ n, d }) =>
      (carriedOnly
        ? [d + offset * dot(n, outward)]
        : [d, d + offset * dot(n, outward)]
      ).some((level) =>
        [edge.a, edge.b].every((p) => Math.abs(dot(n, p) - level) <= tolerance)
      )
    );
    if (on.length === 0) {
      return 'the moved face has left the faces beside it';
    }
    if (on.some(({ n, side }) => sideOf(edge, outward, n) !== side)) {
      return 'the moved face would turn past where its neighbours cross';
    }
  }
  return null;
}

/**
 * Past the band's top, why a moved arc is not one of the face's arcs carried
 * with it, or null when each is: a re-limited cone there has run past its
 * wall.
 */
function arcsFault(
  loops: readonly CapLoop[],
  arcs: readonly Extract<LoopEdge, { kind: 'arc' }>[],
  outward: Vec3,
  offset: number,
  tolerance: number
): string | null {
  const shift = scale(outward, offset);
  for (const edge of loops.flatMap((loop) => loop.edges)) {
    if (edge.kind !== 'arc') continue;
    const carried = arcs.some(
      (arc) =>
        Math.abs(arc.radius - edge.radius) <= tolerance &&
        length(subtract(add(arc.center, shift), edge.center)) <= tolerance
    );
    if (!carried) return 'a rounded part of the edge would run past its wall';
  }
  return null;
}

function uncarriedBandRefusal(
  offset: number,
  detail: string,
  limit?: number
): OffsetFaceRefusal {
  const reason =
    limit === undefined
      ? "This face's chamfered or drafted edge can't move with it this far. Try a smaller offset."
      : `This face's chamfered or drafted edge can't move with it past ${
          Math.round(Math.abs(limit) * 100) / 100
        }. Try a smaller offset.`;
  const kernelMessage = `Offsetting the face by ${offset}: ${detail}`;
  return new OffsetFaceRefusal({
    family: 'direct-edit',
    category: 'unsupported',
    kernelCode: OFFSET_FACE_CHAMFER_RIM_NOT_CARRIED,
    kernelMessage,
    reason,
    message: `${reason}\n${kernelMessage}`,
    ...(limit === undefined ? {} : { limit })
  });
}
