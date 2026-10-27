/** Exact local end moves; the rest of the native B-rep is copied verbatim. */
import { RemusKernel } from './remus-runtime';
import type { RemusMoveFacesRelation } from './remus-lineage';
import { faceFingerprint } from './exact-witnesses';
import { surfaceTypeOf } from './exact-sync-memo';
import {
  ANALYTIC_MATCH_EPSILON,
  GEOMETRY_EPSILON,
  add,
  cross,
  dot,
  finiteVec3,
  length,
  scale,
  subtract
} from './exact-math';
import type { Vec3 } from '@openzcad/geometry';

type Point = [number, number, number];
interface Surface {
  Plane?: { normal: Point; d: number };
  Cylinder?: { origin: Point; axis: Point; radius: number };
  Cone?: { apex: Point; axis: Point; half_angle: number };
  Torus?: { center: Point; major_radius: number; minor_radius: number };
  Sphere?: { center: Point; radius: number };
  Nurbs?: { control_points: Point[][]; weights: number[][] };
}
interface Circle {
  center: Point;
  normal: Point;
  radius: number;
  u_axis: Point;
  v_axis: Point;
}
interface Arena {
  version: number;
  vertices: { point: Point; tolerance: number }[];
  edges: {
    start: number;
    end: number;
    curve: 'Line' | { Circle?: Circle };
    trim?: [number, number] | null;
  }[];
  wires: { edges: { edge: number; forward: boolean }[] }[];
  faces: {
    outer_wire: number;
    inner_wires: number[];
    surface: Surface;
    reversed: boolean;
  }[];
  shells: { faces: number[] }[];
  solids: { outer_shell: number; inner_shells: number[] }[];
  solid_roots: number[];
  boundary_authority: {
    faces: { outer_loop: number; inner_loops: number[] }[];
    loops: { coedges: number[] }[];
    coedges: { edge: number; pcurve?: unknown }[];
  };
  journal?: unknown;
}
interface Rim {
  edges: number[];
  radius: number;
  axial: number;
}
const point = (v: Vec3): Point => [v.x, v.y, v.z];
const vector = (p: Point): Vec3 => ({ x: p[0], y: p[1], z: p[2] });
const TAU = 2 * Math.PI;

/** Require a complete circle, including split rims with different curve frames. */
function completeRim(kernel: RemusKernel, arena: Arena, rim: Rim, axis: Vec3) {
  const intervals: [number, number][] = [];
  const first = arena.edges[rim.edges[0]!]!.curve;
  if (first === 'Line' || !first.Circle) return false;
  const u = vector(first.Circle.u_axis);
  const v = cross(axis, u);
  for (const edge of rim.edges) {
    const curve = arena.edges[edge]!.curve;
    if (curve === 'Line' || !curve.Circle) return false;
    const circle = curve.Circle;
    const [start, end] = kernel.getEdgeParamSpan(edge);
    if (start === undefined || end === undefined) return false;
    const span = Math.abs(end - start);
    if (span <= GEOMETRY_EPSILON || span > TAU + ANALYTIC_MATCH_EPSILON)
      return false;
    const direction = dot(
      cross(vector(circle.u_axis), vector(circle.v_axis)),
      axis
    );
    const p = subtract(
      vector([...kernel.evaluateEdgeCurve(edge, start)] as Point),
      vector(circle.center)
    );
    const a = Math.atan2(dot(p, v), dot(p, u));
    const b = a + (end - start) * Math.sign(direction);
    const low = ((Math.min(a, b) % TAU) + TAU) % TAU;
    const high = low + span;
    intervals.push([low, Math.min(high, TAU)]);
    if (high > TAU) intervals.push([0, high - TAU]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let end = 0;
  for (const interval of intervals) {
    if (Math.abs(interval[0] - end) > ANALYTIC_MATCH_EPSILON) return false;
    end = interval[1];
  }
  return Math.abs(end - TAU) <= ANALYTIC_MATCH_EPSILON;
}

/** Conservative support bound, never a tessellated or sampled clearance test. */
function faceExtent(
  arena: Arena,
  face: number,
  axis: Vec3,
  project: (p: Point) => number
): number | null {
  const node = arena.faces[face]!;
  const surface = node.surface;
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
    return Math.max(...rows.flat().map(project));
  }
  if (surface.Torus)
    return (
      project(surface.Torus.center) +
      surface.Torus.major_radius +
      surface.Torus.minor_radius
    );
  if (surface.Sphere)
    return project(surface.Sphere.center) + surface.Sphere.radius;
  const axial = surface.Cylinder?.axis ?? surface.Cone?.axis;
  if (
    !surface.Plane &&
    (!axial ||
      Math.abs(Math.abs(dot(vector(axial), axis)) - 1) > ANALYTIC_MATCH_EPSILON)
  )
    return null;
  // Height has no interior extrema on an axial cylinder/cone or a plane.
  const extents: number[] = [];
  if (surface.Cone) extents.push(project(surface.Cone.apex));
  for (const wire of [node.outer_wire, ...node.inner_wires]) {
    for (const { edge: index } of arena.wires[wire]!.edges) {
      const edge = arena.edges[index]!;
      if (edge.curve === 'Line') {
        extents.push(
          project(arena.vertices[edge.start]!.point),
          project(arena.vertices[edge.end]!.point)
        );
      } else if (edge.curve.Circle) {
        const circle = edge.curve.Circle;
        extents.push(
          project(circle.center) +
            circle.radius *
              Math.hypot(
                dot(vector(circle.u_axis), axis),
                dot(vector(circle.v_axis), axis)
              )
        );
      } else return null;
    }
  }
  return extents.length ? Math.max(...extents) : null;
}

function moveEnd(
  kernel: RemusKernel,
  arena: Arena,
  cap: number,
  offset: number
): boolean {
  const node = arena.faces[cap]!;
  const plane = node.surface.Plane;
  if (!plane || node.inner_wires.length) return false;
  const normal = finiteVec3([...kernel.getFaceNormal(cap)]);
  if (!normal) return false;
  const firstEdge = arena.wires[node.outer_wire]!.edges[0]?.edge;
  const firstCurve =
    firstEdge === undefined ? undefined : arena.edges[firstEdge]!.curve;
  if (!firstCurve || firstCurve === 'Line' || !firstCurve.Circle) return false;
  const origin = vector(firstCurve.Circle.center);
  const project = (p: Point) => dot(subtract(vector(p), origin), normal);
  const parallel = (p: Point) =>
    Math.abs(Math.abs(dot(vector(p), normal)) - 1) <= ANALYTIC_MATCH_EPSILON;
  const edgesOf = (f: number) => [...new Set(kernel.getFaceEdges(f))];
  const owners = new Map<number, number[]>();
  for (let f = 0; f < arena.faces.length; f++)
    for (const edge of edgesOf(f))
      owners.set(edge, [...(owners.get(edge) ?? []), f]);
  const across = (edges: number[], face: number) => {
    const adjacent = edges.map((edge) => owners.get(edge));
    if (adjacent.some((faces) => !faces || faces.length !== 2)) return null;
    const other = new Set(
      adjacent.flatMap((faces) => faces!.filter((f) => f !== face))
    );
    return other.size === 1 ? [...other][0]! : null;
  };
  const cone = across(edgesOf(cap), cap);
  const conical = cone === null ? undefined : arena.faces[cone]!.surface.Cone;
  if (!conical || !parallel(conical.axis)) return false;
  const radius = Math.max(
    ...edgesOf(cap).map((e) => {
      const curve = arena.edges[e]!.curve;
      return curve === 'Line' ? 0 : (curve.Circle?.radius ?? 0);
    })
  );
  const tolerance = Math.max(1, radius) * ANALYTIC_MATCH_EPSILON;
  const close = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const rimsOf = (face: number): Rim[] | null => {
    if (arena.faces[face]!.inner_wires.length) return null;
    const rims: Rim[] = [];
    for (const edge of edgesOf(face)) {
      const curve = arena.edges[edge]!.curve;
      if (curve === 'Line') {
        if (owners.get(edge)?.length !== 1) return null;
        continue;
      }
      const circle = curve.Circle;
      if (!circle || !parallel(circle.normal)) return null;
      const delta = subtract(vector(circle.center), origin);
      const axial = dot(delta, normal);
      if (length(subtract(delta, scale(normal, axial))) > tolerance)
        return null;
      let rim = rims.find(
        (r) => close(r.axial, axial) && close(r.radius, circle.radius)
      );
      if (!rim) {
        rim = { edges: [], radius: circle.radius, axial };
        rims.push(rim);
      }
      rim.edges.push(edge);
    }
    return rims.every((rim) => completeRim(kernel, arena, rim, normal))
      ? rims
      : null;
  };
  const capRims = rimsOf(cap);
  const coneRims = rimsOf(cone!);
  if (capRims?.length !== 1 || coneRims?.length !== 2) return false;
  const sameEdges = (a: Rim, b: Rim) =>
    a.edges.length === b.edges.length &&
    a.edges.every((edge) => b.edges.includes(edge));
  const rim = capRims[0]!;
  const shoulder = coneRims.find((r) => !sameEdges(r, rim));
  if (
    !coneRims.some((r) => sameEdges(r, rim)) ||
    !shoulder ||
    shoulder.radius <= rim.radius + tolerance ||
    rim.axial - shoulder.axial <= tolerance
  )
    return false;
  const apex = vector(conical.apex);
  const apexDelta = subtract(apex, origin);
  if (
    length(subtract(apexDelta, scale(normal, dot(apexDelta, normal)))) >
      tolerance ||
    conical.half_angle <= 0 ||
    conical.half_angle >= Math.PI / 2
  )
    return false;
  for (const boundary of coneRims) {
    const height =
      (boundary.axial - project(conical.apex)) *
      dot(normal, vector(conical.axis));
    if (
      height <= 0 ||
      !close(boundary.radius, height / Math.tan(conical.half_angle))
    )
      return false;
  }
  const wall = across(shoulder.edges, cone!);
  const cylinder =
    wall === null ? undefined : arena.faces[wall]!.surface.Cylinder;
  if (
    !cylinder ||
    arena.faces[wall!]!.reversed ||
    !parallel(cylinder.axis) ||
    !close(cylinder.radius, shoulder.radius)
  )
    return false;
  const wallRims = rimsOf(wall!);
  const fixed = wallRims?.find((r) => !sameEdges(r, shoulder));
  if (
    wallRims?.length !== 2 ||
    !wallRims.some((r) => sameEdges(r, shoulder)) ||
    !fixed ||
    !close(fixed.radius, cylinder.radius) ||
    fixed.axial >= shoulder.axial - tolerance
  )
    return false;
  if (shoulder.axial + offset - fixed.axial <= GEOMETRY_EPSILON)
    throw new Error(
      'That distance would leave no cylindrical wall before the shoulder.'
    );
  for (const [band, rings] of [
    [cone!, coneRims],
    [wall!, wallRims]
  ] as const) {
    const seams = edgesOf(band).filter(
      (edge) => arena.edges[edge]!.curve === 'Line'
    );
    if (seams.length !== 1) return false;
    const edge = arena.edges[seams[0]!]!;
    const uses = arena.wires[arena.faces[band]!.outer_wire]!.edges.filter(
      (use) => use.edge === seams[0]
    );
    if (uses.length !== 2 || uses[0]!.forward === uses[1]!.forward)
      return false;
    const a = project(arena.vertices[edge.start]!.point);
    const b = project(arena.vertices[edge.end]!.point);
    if (
      !rings.some((r) => close(r.axial, a)) ||
      !rings.some((r) => close(r.axial, b)) ||
      close(a, b)
    )
      return false;
  }
  // A stored UV trace cannot be left stale after stretching its cylinder.
  // Reference-form STEP imports have no wall pcurves; other cases stay on
  // the general path until an exact UV remapping is qualified.
  const boundary = arena.boundary_authority;
  const loop = boundary.loops[boundary.faces[wall!]!.outer_loop]!;
  if (loop.coedges.some((c) => boundary.coedges[c]!.pcurve != null))
    return false;
  const local = new Set([cap, cone!, wall!]);
  for (let f = 0; f < arena.faces.length; f++) {
    if (local.has(f)) continue;
    const extent = faceExtent(arena, f, normal, project);
    if (
      extent === null ||
      !Number.isFinite(extent) ||
      extent >= shoulder.axial + Math.min(0, offset) - tolerance
    )
      return false;
  }
  const movedEdges = new Set([...edgesOf(cap), ...edgesOf(cone!)]);
  const movedVertices = new Set(
    [...movedEdges].flatMap((e) => [arena.edges[e]!.start, arena.edges[e]!.end])
  );
  // The moved rings cannot be attached to another feature or cavity.
  for (let e = 0; e < arena.edges.length; e++) {
    const edge = arena.edges[e]!;
    if (!movedVertices.has(edge.start) && !movedVertices.has(edge.end))
      continue;
    if ((owners.get(e) ?? []).some((f) => !local.has(f))) return false;
    if (!movedEdges.has(e)) {
      if (
        edge.curve !== 'Line' ||
        movedVertices.has(edge.start) === movedVertices.has(edge.end)
      )
        return false;
      const span = kernel.getEdgeParamSpan(e);
      const a = vector(arena.vertices[edge.start]!.point);
      const b = vector(arena.vertices[edge.end]!.point);
      if (!close(span[0]!, 0) || !close(span[1]!, length(subtract(a, b))))
        return false;
    }
  }
  const shift = scale(normal, offset);
  for (const vertex of movedVertices)
    arena.vertices[vertex]!.point = point(
      add(vector(arena.vertices[vertex]!.point), shift)
    );
  for (const edge of movedEdges) {
    const curve = arena.edges[edge]!.curve;
    if (curve !== 'Line' && curve.Circle)
      curve.Circle.center = point(add(vector(curve.Circle.center), shift));
  }
  for (const edge of edgesOf(wall!)) {
    const record = arena.edges[edge]!;
    if (record.curve === 'Line' && record.trim != null)
      record.trim = [
        0,
        length(
          subtract(
            vector(arena.vertices[record.start]!.point),
            vector(arena.vertices[record.end]!.point)
          )
        )
      ];
  }
  plane.d += dot(vector(plane.normal), shift);
  conical.apex = point(add(apex, shift));
  return true;
}

function uniqueFaces(kernel: RemusKernel, solid: number) {
  const map = new Map<number, number>();
  for (const face of kernel.getSolidFaces(solid)) {
    const hash = faceFingerprint(kernel, face);
    if (map.has(hash)) return null;
    map.set(hash, face);
  }
  return map;
}

/**
 * Edit the pinned native arena without re-fitting or sewing curved geometry.
 * Full circular cap/cone/wall bands and a conservative clearance certificate
 * prove the local deformation. Every other surface, curve, trim, tolerance,
 * loop and coedge remains as serialized. Ambiguous/unsupported inputs decline.
 */
export function tryExactLocalChamferCapOffset(
  kernel: RemusKernel,
  solid: number,
  face: number,
  offset: number
): { solid: number; relation: RemusMoveFacesRelation } | null {
  if (
    !Number.isFinite(offset) ||
    Math.abs(offset) <= GEOMETRY_EPSILON ||
    surfaceTypeOf(kernel, face) !== 'plane'
  )
    return null;
  const selectedEdges = new Set(kernel.getFaceEdges(face));
  if (
    ![...kernel.getSolidFaces(solid)].some(
      (candidate) =>
        surfaceTypeOf(kernel, candidate) === 'cone' &&
        [...kernel.getFaceEdges(candidate)].some((edge) =>
          selectedEdges.has(edge)
        )
    )
  )
    return null;
  const source = uniqueFaces(kernel, solid);
  if (!source) return null;
  const bytes = kernel.serializeSolids(Uint32Array.of(solid));
  const original = new TextDecoder().decode(bytes);
  const arena = JSON.parse(original) as Arena;
  if (
    arena.version !== 3 ||
    arena.faces.length > 1500 ||
    arena.shells.length !== 1 ||
    arena.solids.length !== 1 ||
    arena.solid_roots.length !== 1 ||
    arena.solids[0]!.inner_shells.length ||
    !arena.boundary_authority
  )
    return null;
  const probe = new RemusKernel();
  try {
    const [input] = probe.deserializeSolids(bytes);
    if (input === undefined || probe.validateSolid(input) !== 0) return null;
    const local = uniqueFaces(probe, input);
    if (
      !local ||
      source.size !== local.size ||
      [...source.keys()].some((hash) => !local.has(hash))
    )
      return null;
    // In a fresh owner, the native arena tables are the allocated handles.
    // Verify that contract, then map the live source through unique witnesses.
    if (
      JSON.stringify([...probe.getSolidFaces(input)]) !==
      JSON.stringify(arena.shells[0]!.faces)
    )
      return null;
    const cap = local.get(faceFingerprint(kernel, face));
    if (cap === undefined || !moveEnd(probe, arena, cap, offset)) return null;
    // Copied source journals do not describe this deformation. The explicit
    // construction relation below supplies its verified direct-edit lineage.
    delete arena.journal;
    // JSON.stringify normally changes native -0 to +0. Preserve every
    // untouched double, including signed zero in analytic surface frames.
    let marker = '__openzcad_native_negative_zero__';
    while (original.includes(marker)) marker += '_';
    const encoded = JSON.stringify(arena, (_key, value: unknown) =>
      Object.is(value, -0) ? marker : value
    ).replaceAll(JSON.stringify(marker), '-0.0');
    const outputBytes = new TextEncoder().encode(encoded);
    const check = new RemusKernel();
    try {
      const [checked] = check.deserializeSolids(outputBytes);
      if (checked === undefined || check.validateSolid(checked) !== 0)
        throw new Error(
          'The chamfered end move did not produce a valid exact solid.'
        );
      const verified = uniqueFaces(check, checked);
      if (
        !verified ||
        verified.size !== source.size ||
        JSON.stringify([...check.getSolidFaces(checked)]) !==
          JSON.stringify(arena.shells[0]!.faces)
      )
        throw new Error('The chamfered end move has ambiguous face history.');
      const [output] = kernel.deserializeSolids(outputBytes);
      if (output === undefined || kernel.validateSolid(output) !== 0)
        throw new Error(
          'The chamfered end move could not be restored exactly.'
        );
      const restored = uniqueFaces(kernel, output);
      if (!restored || [...verified.keys()].some((hash) => !restored.has(hash)))
        throw new Error(
          'The chamfered end move could not verify its face history.'
        );
      const faceMap = new Map<number, number>();
      for (const [hash, sourceFace] of source) {
        const constructed = local.get(hash)!;
        faceMap.set(
          sourceFace,
          restored.get(faceFingerprint(check, constructed))!
        );
      }
      return {
        solid: output,
        relation: { faceMap, conflictedSources: new Set() }
      };
    } finally {
      check.free();
    }
  } finally {
    probe.free();
  }
}
