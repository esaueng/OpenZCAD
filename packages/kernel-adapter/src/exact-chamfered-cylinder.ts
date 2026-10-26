/** Exact end moves for a solid cylinder with one or two circular chamfers. */
import type { Vec2, Vec3 } from '@openzcad/geometry';
import type { RemusKernel } from './remus-runtime';
import type { RemusMoveFacesRelation } from './remus-lineage';
import { analyticSurfaceRecord, brepEdgeCircle } from './exact-brep';
import { revolveRadialProfile } from './exact-cylinder-ops';
import {
  ANALYTIC_MATCH_EPSILON,
  GEOMETRY_EPSILON,
  dot,
  finiteVec3,
  length,
  normalized,
  positiveFinite,
  scale,
  subtract
} from './exact-math';

interface Rim {
  edge: number;
  radius: number;
  axial: number;
}
interface End {
  cap: number;
  cone?: number;
  rim: Rim;
  shoulder: Rim;
}
interface Rod {
  origin: Vec3;
  axis: Vec3;
  radius: number;
  wall: number;
  ends: [End, End];
}

/**
 * Prove the complete solid, including its ordered cap/cone/wall adjacency.
 * Surface resemblance alone must never turn a pocket, tube, partial cylinder,
 * or a rod with another feature into a replacement cylinder. Split rims and
 * freeform surfaces deliberately stay with the ordinary exact kernel path.
 */
function readRod(kernel: RemusKernel, solid: number): Rod | null {
  const faces = [...kernel.getSolidFaces(solid)];
  if (faces.length < 4 || faces.length > 5) return null;
  const types = new Map(
    faces.map((face) => [face, kernel.getSurfaceType(face)])
  );
  const walls = faces.filter((face) => types.get(face) === 'cylinder');
  const caps = faces.filter((face) => types.get(face) === 'plane');
  const cones = faces.filter((face) => types.get(face) === 'cone');
  if (
    walls.length !== 1 ||
    caps.length !== 2 ||
    cones.length < 1 ||
    cones.length > 2 ||
    faces.length !== 3 + cones.length ||
    kernel.getSolidShells(solid).length !== 1 ||
    faces.some((face) => kernel.getFaceWires(face).length !== 1)
  )
    return null;
  const wall = walls[0]!;
  const cylinder = analyticSurfaceRecord(kernel, wall);
  const origin = finiteVec3(cylinder?.origin);
  const rawAxis = finiteVec3(cylinder?.axis);
  const axis = rawAxis && normalized(rawAxis);
  const radius = positiveFinite(cylinder?.radius);
  if (!origin || !axis || radius === null) return null;
  const tolerance = Math.max(1, radius) * ANALYTIC_MATCH_EPSILON;
  const close = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const parallel = (a: Vec3) =>
    Math.abs(Math.abs(dot(a, axis)) - 1) <= ANALYTIC_MATCH_EPSILON;
  const onAxis = (point: Vec3) => {
    const delta = subtract(point, origin);
    return length(subtract(delta, scale(axis, dot(delta, axis)))) <= tolerance;
  };
  const edgesByFace = new Map(
    faces.map((face) => [face, [...new Set(kernel.getFaceEdges(face))]])
  );
  const owners = new Map<number, number[]>();
  for (const [face, edges] of edgesByFace) {
    for (const edge of edges)
      owners.set(edge, [...(owners.get(edge) ?? []), face]);
  }
  const rims = new Map<number, Rim>();
  for (const [edge, adjacent] of owners) {
    const type = kernel.getEdgeCurveType(edge);
    if (type === 'LINE') {
      // The only straight edges in this family are the periodic seams.
      if (adjacent.length !== 1 || types.get(adjacent[0]!) === 'plane')
        return null;
      continue;
    }
    const span = kernel.getEdgeParamSpan(edge);
    const vertices = kernel.getEdgeVertexHandles(edge);
    if (
      type !== 'CIRCLE' ||
      adjacent.length !== 2 ||
      vertices[0] !== vertices[1] ||
      span.length !== 2 ||
      Math.abs(Math.abs(span[1]! - span[0]!) - 2 * Math.PI) >
        ANALYTIC_MATCH_EPSILON
    )
      return null;
    const circle = brepEdgeCircle(kernel, edge, [
      ...kernel.tessellateEdge(edge, 16)
    ]);
    if (!circle || !parallel(circle.axis) || !onAxis(circle.center))
      return null;
    rims.set(edge, {
      edge,
      radius: circle.radius,
      axial: dot(subtract(circle.center, origin), axis)
    });
  }
  const wallRims = edgesByFace
    .get(wall)!
    .flatMap((edge) => (rims.has(edge) ? [rims.get(edge)!] : []))
    .sort((a, b) => a.axial - b.axial);
  if (
    wallRims.length !== 2 ||
    wallRims.some((rim) => !close(rim.radius, radius))
  )
    return null;
  const ends: End[] = [];
  const usedCones = new Set<number>();
  for (const cap of caps) {
    const edges = edgesByFace.get(cap)!;
    const rim = edges.length === 1 ? rims.get(edges[0]!) : undefined;
    const normal = finiteVec3([...kernel.getFaceNormal(cap)]);
    if (!rim || !normal || !parallel(normal)) return null;
    const side = dot(normal, axis) < 0 ? 0 : 1;
    const shoulder = wallRims[side]!;
    const neighbor = owners.get(rim.edge)!.find((face) => face !== cap)!;
    if (neighbor === wall) {
      if (rim.edge !== shoulder.edge || !close(rim.radius, radius)) return null;
      ends[side] = { cap, rim, shoulder };
      continue;
    }
    if (types.get(neighbor) !== 'cone' || usedCones.has(neighbor)) return null;
    const coneRims = edgesByFace
      .get(neighbor)!
      .filter((edge) => rims.has(edge));
    if (
      coneRims.length !== 2 ||
      !coneRims.includes(rim.edge) ||
      !coneRims.includes(shoulder.edge)
    )
      return null;
    const record = analyticSurfaceRecord(kernel, neighbor);
    const apex = finiteVec3(record?.apex);
    const rawConeAxis = finiteVec3(record?.axis);
    const coneAxis = rawConeAxis && normalized(rawConeAxis);
    const angle = positiveFinite(record?.halfAngle);
    if (
      !apex ||
      !coneAxis ||
      !parallel(coneAxis) ||
      !onAxis(apex) ||
      angle === null ||
      angle >= Math.PI / 2 ||
      rim.radius >= radius - tolerance ||
      (side === 0 ? shoulder.axial - rim.axial : rim.axial - shoulder.axial) <=
        tolerance
    )
      return null;
    const apexAxial = dot(subtract(apex, origin), axis);
    for (const boundary of [rim, shoulder]) {
      const coneHeight = (boundary.axial - apexAxial) * dot(axis, coneAxis);
      if (
        coneHeight <= 0 ||
        // Remus measures halfAngle from the radial plane to the generator.
        !close(boundary.radius, coneHeight / Math.tan(angle))
      )
        return null;
    }
    usedCones.add(neighbor);
    ends[side] = { cap, cone: neighbor, rim, shoulder };
  }
  if (
    !ends[0] ||
    !ends[1] ||
    usedCones.size !== cones.length ||
    wallRims[1]!.axial - wallRims[0]!.axial <= tolerance ||
    kernel.validateSolidRelaxed(solid) !== 0
  )
    return null;
  return { origin, axis, radius, wall, ends: [ends[0], ends[1]] };
}

/**
 * Translate a proved cap and its chamfer as one end group. Re-revolving the
 * exact radial section extends the wall without extending the cone (which
 * would change the end diameter). The opposite end stays at its source plane.
 * All other shapes return null; no generic cone check or tolerance is relaxed.
 */
export function tryExactChamferedCylinderCapOffset(
  kernel: RemusKernel,
  solid: number,
  face: number,
  offset: number
): { solid: number; relation: RemusMoveFacesRelation } | null {
  const rod = readRod(kernel, solid);
  if (!rod || !Number.isFinite(offset)) return null;
  const side = rod.ends.findIndex((end) => end.cap === face);
  // Moving an unchamfered end already works through the general face move.
  if (side < 0 || rod.ends[side]!.cone === undefined) return null;
  const delta = side === 0 ? -offset : offset;
  const ends = rod.ends.map((end, index) => ({
    ...end,
    rim: { ...end.rim, axial: end.rim.axial + (index === side ? delta : 0) },
    shoulder: {
      ...end.shoulder,
      axial: end.shoulder.axial + (index === side ? delta : 0)
    }
  }));
  if (ends[1]!.shoulder.axial - ends[0]!.shoulder.axial <= GEOMETRY_EPSILON) {
    throw new Error(
      'That distance would leave no cylindrical wall between the end faces.'
    );
  }
  const low = ends[0]!;
  const high = ends[1]!;
  const profile: Vec2[] = [
    { x: 0, y: low.rim.axial },
    { x: low.rim.radius, y: low.rim.axial },
    ...(low.cone === undefined
      ? []
      : [{ x: rod.radius, y: low.shoulder.axial }]),
    { x: rod.radius, y: high.shoulder.axial },
    ...(high.cone === undefined
      ? []
      : [{ x: high.rim.radius, y: high.rim.axial }]),
    { x: 0, y: high.rim.axial }
  ];
  const output = revolveRadialProfile(kernel, profile, {
    ...rod,
    axialMin: low.rim.axial,
    axialMax: high.rim.axial
  });
  const result = readRod(kernel, output);
  if (!result)
    throw new Error(
      'The chamfered end could not be rebuilt as an exact cylindrical solid.'
    );
  // These are construction roles on a fully proved section, never face order
  // or nearest-face matching. The common direct-edit lineage gate re-verifies
  // each source reference and refreshes its witness against these result faces.
  const faceMap = new Map<number, number>([[rod.wall, result.wall]]);
  for (const [index, end] of rod.ends.entries()) {
    faceMap.set(end.cap, result.ends[index]!.cap);
    if (end.cone !== undefined)
      faceMap.set(end.cone, result.ends[index]!.cone!);
  }
  return { solid: output, relation: { faceMap, conflictedSources: new Set() } };
}
