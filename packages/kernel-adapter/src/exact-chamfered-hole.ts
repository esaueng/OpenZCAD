/** Shrink an analytic bore while extending its existing conical mouths. */
import { RemusKernel } from './remus-runtime';
import type { Vec3 } from '@openzcad/geometry';
import type { ThroughHoleGeometry } from './exact-measure';
import { faceFingerprint } from './exact-witnesses';
import {
  ANALYTIC_MATCH_EPSILON,
  add,
  dot,
  length,
  normalized,
  scale,
  subtract
} from './exact-math';

type Point = [number, number, number];
interface Circle {
  center: Point;
  normal: Point;
  radius: number;
}
interface Arena {
  version: number;
  vertices: { point: Point }[];
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
    reversed: boolean;
    surface: {
      Cylinder?: { origin: Point; axis: Point; radius: number };
      Cone?: { apex: Point; axis: Point; half_angle: number };
      Plane?: { normal: Point; d: number };
    };
  }[];
  shells: { faces: number[] }[];
  solids: { inner_shells: number[] }[];
  solid_roots: number[];
  boundary_authority: {
    faces: { outer_loop: number; inner_loops: number[] }[];
    loops: { coedges: number[] }[];
    coedges: { pcurve?: unknown }[];
  };
  journal?: unknown;
}
const vector = (p: Point): Vec3 => ({ x: p[0], y: p[1], z: p[2] });
const point = (v: Vec3): Point => [v.x, v.y, v.z];
const refusal = () =>
  new Error('The hole’s chamfer cannot be extended exactly at this diameter.');

/**
 * Only shrinks are handled: all added material lies inside the old bore.
 * Both end rings must be complete circles, each meeting a planar end or a
 * coaxial cone. Its outer mouth may break out through a side face: those
 * boundary curves remain untouched. Other neighbours and stored UV traces refuse.
 * The pinned native representation is copied; cone carriers, outer rings,
 * unrelated faces, edge trims and tolerances are retained verbatim.
 */
export function shrinkChamferedThroughHole(
  kernel: RemusKernel,
  solid: number,
  face: number,
  geometry: ThroughHoleGeometry,
  radius: number,
  tolerance: number
): number | null {
  const boreEdges = new Set(kernel.getFaceEdges(face));
  if (
    ![...kernel.getSolidFaces(solid)].some(
      (candidate) =>
        kernel.getSurfaceType(candidate) === 'cone' &&
        [...kernel.getFaceEdges(candidate)].some((edge) => boreEdges.has(edge))
    )
  )
    return null;
  if (radius >= geometry.radius) return null;
  const bytes = kernel.serializeSolids(Uint32Array.of(solid));
  const original = new TextDecoder().decode(bytes);
  const arena = JSON.parse(original) as Arena;
  if (
    arena.version !== 3 ||
    arena.shells.length !== 1 ||
    arena.solids.length !== 1 ||
    arena.solid_roots.length !== 1 ||
    arena.solids[0]!.inner_shells.length ||
    !arena.boundary_authority
  )
    throw refusal();
  const probe = new RemusKernel();
  try {
    const [input] = probe.deserializeSolids(bytes);
    if (
      input === undefined ||
      probe.validateSolid(input) !== 0 ||
      JSON.stringify([...probe.getSolidFaces(input)]) !==
        JSON.stringify(arena.shells[0]!.faces)
    )
      throw refusal();
    const matches = [...probe.getSolidFaces(input)].filter(
      (candidate) =>
        faceFingerprint(probe, candidate) === faceFingerprint(kernel, face)
    );
    if (matches.length !== 1) throw refusal();
    const bore = matches[0]!;
    const node = arena.faces[bore]!;
    const cylinder = node.surface.Cylinder;
    if (!cylinder || !node.reversed || node.inner_wires.length) throw refusal();
    const axis = normalized(subtract(geometry.axisEnd, geometry.axisStart))!;
    const origin = geometry.axisStart;
    const axial = (p: Point) => dot(subtract(vector(p), origin), axis);
    const close = (a: number, b: number) => Math.abs(a - b) <= tolerance;
    const parallel = (p: Point) =>
      Math.abs(Math.abs(dot(vector(p), axis)) - 1) <= ANALYTIC_MATCH_EPSILON;
    const onAxis = (p: Point) =>
      length(subtract(subtract(vector(p), origin), scale(axis, axial(p)))) <=
      tolerance;
    const edgesOf = (f: number) => [...new Set(probe.getFaceEdges(f))];
    const owners = new Map<number, number[]>();
    for (const f of probe.getSolidFaces(input))
      for (const edge of edgesOf(f))
        owners.set(edge, [...(owners.get(edge) ?? []), f]);
    interface Ring {
      edges: number[];
      at: number;
      radius: number;
    }
    const ringsOf = (f: number): Ring[] => {
      if (arena.faces[f]!.inner_wires.length) throw refusal();
      const rings: Ring[] = [];
      const wire = arena.wires[arena.faces[f]!.outer_wire]!;
      for (const e of edgesOf(f)) {
        const edge = arena.edges[e]!;
        if (edge.curve === 'Line') {
          const uses = wire.edges.filter((use) => use.edge === e);
          if (
            owners.get(e)?.length !== 1 ||
            uses.length !== 2 ||
            uses[0]!.forward === uses[1]!.forward
          )
            throw refusal();
          continue;
        }
        const circle = edge.curve.Circle;
        if (!circle || !parallel(circle.normal) || !onAxis(circle.center))
          throw refusal();
        const at = axial(circle.center);
        let ring = rings.find(
          (r) => close(r.at, at) && close(r.radius, circle.radius)
        );
        if (!ring) {
          ring = { edges: [], at, radius: circle.radius };
          rings.push(ring);
        }
        ring.edges.push(e);
      }
      // Limit this local edit to unsplit complete circles. Split/trimmed
      // periodic boundaries need a separate coverage and UV certificate.
      for (const ring of rings) {
        if (ring.edges.length !== 1) throw refusal();
        const e = ring.edges[0]!;
        const span = probe.getEdgeParamSpan(e);
        const edge = arena.edges[e]!;
        if (
          edge.start !== edge.end ||
          Math.abs(Math.abs(span[1]! - span[0]!) - 2 * Math.PI) >
            ANALYTIC_MATCH_EPSILON
        )
          throw refusal();
      }
      return rings;
    };
    const rings = ringsOf(bore).sort((a, b) => a.at - b.at);
    if (
      rings.length !== 2 ||
      !close(rings[0]!.at, 0) ||
      !close(rings[1]!.at, geometry.axialLength) ||
      rings.some((r) => !close(r.radius, geometry.radius))
    )
      throw refusal();
    const local = new Set([bore]);
    const moves = rings.map((ring, end) => {
      const edge = ring.edges[0]!;
      const adjacent = owners.get(edge);
      if (adjacent?.length !== 2) throw refusal();
      const other = adjacent.find((f) => f !== bore)!;
      local.add(other);
      const surface = arena.faces[other]!.surface;
      if (surface.Plane) {
        if (!parallel(surface.Plane.normal)) throw refusal();
        return 0;
      }
      const cone = surface.Cone;
      if (
        !cone ||
        !parallel(cone.axis) ||
        !onAxis(cone.apex) ||
        cone.half_angle <= 0 ||
        cone.half_angle >= Math.PI / 2
      )
        throw refusal();
      if (arena.faces[other]!.inner_wires.length) throw refusal();
      const alignment = dot(axis, vector(cone.axis));
      const slope = Math.tan(cone.half_angle) / alignment;
      if (!close(geometry.radius, (ring.at - axial(cone.apex)) / slope))
        throw refusal();
      for (const e of edgesOf(other)) {
        if (e === edge) continue;
        const boundaryEdge = arena.edges[e]!;
        const circle =
          boundaryEdge.curve === 'Line' ? undefined : boundaryEdge.curve.Circle;
        // A coaxial circular carrier has a constant radius over its whole trim.
        if (
          circle &&
          parallel(circle.normal) &&
          onAxis(circle.center) &&
          circle.radius > geometry.radius + tolerance
        )
          continue;
        const neighbours = owners.get(e)!.filter((f) => f !== other);
        if (!neighbours.length && boundaryEdge.curve === 'Line') {
          const uses = arena.wires[
            arena.faces[other]!.outer_wire
          ]!.edges.filter((use) => use.edge === e);
          if (uses.length === 2 && uses[0]!.forward !== uses[1]!.forward)
            continue;
        }
        const plane =
          neighbours.length === 1
            ? arena.faces[neighbours[0]!]!.surface.Plane
            : undefined;
        const normal = plane && normalized(vector(plane.normal));
        if (!normal) throw refusal();
        const along = dot(normal, axis);
        const p = arena.vertices[boundaryEdge.start]!.point;
        const radiusAtVertex = (axial(p) - axial(cone.apex)) / slope;
        // A transverse plane fixes the cone radius. A parallel side plane's
        // distance from the axis bounds every point of its intersection curve.
        if (
          Math.abs(Math.abs(along) - 1) <= ANALYTIC_MATCH_EPSILON &&
          radiusAtVertex > geometry.radius + tolerance
        )
          continue;
        if (
          Math.abs(along) <= ANALYTIC_MATCH_EPSILON &&
          Math.abs(dot(normal, subtract(vector(p), origin))) >
            geometry.radius + tolerance
        )
          continue;
        throw refusal();
      }
      // The input has a strictly valid, nonintersecting cone wire. Its complete
      // bore ring separates the outer boundary from the region being added.
      // Certify that every other boundary vertex is on the outward side of
      // that ring; retain all of its clipped curves verbatim.
      const vertices = new Set(
        edgesOf(other).flatMap((e) => [
          arena.edges[e]!.start,
          arena.edges[e]!.end
        ])
      );
      let extendsOutward = false;
      for (const v of vertices) {
        const p = arena.vertices[v]!.point;
        const r = length(
          subtract(subtract(vector(p), origin), scale(axis, axial(p)))
        );
        if (
          r < geometry.radius - tolerance ||
          !close(r, (axial(p) - axial(cone.apex)) / slope)
        )
          throw refusal();
        if (r > geometry.radius + tolerance) extendsOutward = true;
      }
      const move = (radius - geometry.radius) * slope;
      if (!extendsOutward || (end === 0 ? move <= 0 : move >= 0))
        throw refusal();
      return move;
    });
    if (rings[1]!.at + moves[1]! - rings[0]!.at - moves[0]! <= tolerance)
      throw new Error(
        'That diameter would leave no cylindrical wall between the hole’s chamfers.'
      );
    for (const f of local) {
      const boundary = arena.boundary_authority;
      const faceBoundary = boundary.faces[f]!;
      for (const loop of [faceBoundary.outer_loop, ...faceBoundary.inner_loops])
        if (
          boundary.loops[loop]!.coedges.some(
            (c) => boundary.coedges[c]!.pcurve != null
          )
        )
          throw refusal();
    }
    const movedVertices = new Set<number>();
    rings.forEach((ring, i) => {
      const e = arena.edges[ring.edges[0]!]!;
      const circle = e.curve === 'Line' ? undefined : e.curve.Circle;
      if (!circle) throw refusal();
      const oldCenter = vector(circle.center);
      const newCenter = add(oldCenter, scale(axis, moves[i]!));
      circle.center = point(newCenter);
      circle.radius = radius;
      for (const vertex of new Set([e.start, e.end])) {
        if (movedVertices.has(vertex)) throw refusal();
        movedVertices.add(vertex);
        const radial = subtract(
          vector(arena.vertices[vertex]!.point),
          oldCenter
        );
        if (!close(length(radial), geometry.radius)) throw refusal();
        arena.vertices[vertex]!.point = point(
          add(newCenter, scale(radial, radius / geometry.radius))
        );
      }
    });
    for (let e = 0; e < arena.edges.length; e++) {
      const edge = arena.edges[e]!;
      if (!movedVertices.has(edge.start) && !movedVertices.has(edge.end))
        continue;
      if ((owners.get(e) ?? []).some((f) => !local.has(f))) throw refusal();
      if (edge.curve === 'Line' && edge.trim != null) {
        const span = probe.getEdgeParamSpan(e);
        const oldStart = [...probe.getVertexPosition(edge.start)];
        const oldEnd = [...probe.getVertexPosition(edge.end)];
        if (
          !close(span[0]!, 0) ||
          !close(
            span[1]!,
            Math.hypot(...oldEnd.map((v, i) => v - oldStart[i]!))
          )
        )
          throw refusal();
        edge.trim = [
          0,
          length(
            subtract(
              vector(arena.vertices[edge.end]!.point),
              vector(arena.vertices[edge.start]!.point)
            )
          )
        ];
      }
    }
    cylinder.radius = radius;
    delete arena.journal;
    let marker = '__openzcad_native_negative_zero__';
    while (original.includes(marker)) marker += '_';
    const encoded = JSON.stringify(arena, (_key, value: unknown) =>
      Object.is(value, -0) ? marker : value
    ).replaceAll(JSON.stringify(marker), '-0.0');
    const outputBytes = new TextEncoder().encode(encoded);
    const check = new RemusKernel();
    try {
      const [checked] = check.deserializeSolids(outputBytes);
      if (
        checked === undefined ||
        check.validateSolid(checked) !== 0 ||
        check.getSolidFaces(checked).length !==
          probe.getSolidFaces(input).length
      )
        throw refusal();
    } finally {
      check.free();
    }
    const [output] = kernel.deserializeSolids(outputBytes);
    if (output === undefined || kernel.validateSolid(output) !== 0)
      throw refusal();
    return output;
  } finally {
    probe.free();
  }
}
