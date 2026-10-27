import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';

type Point = [number, number, number];
export interface SteppedArena {
  vertices: { point: Point; tolerance: number }[];
  edges: {
    start: number;
    end: number;
    curve:
      | 'Line'
      | {
          Circle: {
            center: Point;
            radius: number;
            u_axis: Point;
            v_axis: Point;
          };
        };
    trim?: [number, number];
  }[];
  faces: { outer_wire: number; surface: Record<string, unknown> }[];
  wires: { edges: { edge: number; forward: boolean }[] }[];
  boundary_authority: {
    loops: { coedges: number[] }[];
    coedges: { edge: number; forward: boolean; periodic_winding: number[] }[];
  };
}

export function steppedArena(kernel: RemusKernel, solid: number): SteppedArena {
  return JSON.parse(
    new TextDecoder().decode(kernel.serializeSolids(Uint32Array.of(solid)))
  ) as SteppedArena;
}

/** Independently authored dimensions; no customer geometry or source STEP. */
export function steppedChamferedCylinderSolid(kernel: RemusKernel): number {
  const profile = [
    [0, 0],
    [4, 0],
    [6, 2],
    [6, 45],
    [10, 55],
    [10, 75],
    [8, 77],
    [0, 77]
  ];
  const edges = profile.map(([r, z], i) => {
    const next = profile[(i + 1) % profile.length]!;
    return kernel.makeLineEdge(r!, 0, z!, next[0]!, 0, next[1]!);
  });
  const revolved = kernel.revolve(
    kernel.makePlanarFaceFromWire(
      kernel.makeWire(Uint32Array.from(edges), true)
    ),
    0,
    0,
    0,
    0,
    0,
    1,
    360
  );
  const rims = [...kernel.getSolidEdges(revolved)].filter(
    (edge) =>
      kernel.getEdgeCurveType(edge) === 'CIRCLE' &&
      [45, 55].some(
        (z) => Math.abs(kernel.getEdgeVertices(edge)[2]! - z) < 1e-6
      )
  );
  const rounded = kernel.fillet(revolved, Uint32Array.from(rims), 2);
  // Keep one shoulder as exact rational NURBS, as an imported degenerate
  // toroidal patch can be. Its control net must survive every end move.
  const arena = steppedArena(kernel, rounded);
  const faces = [...kernel.getSolidFaces(rounded)];
  const torus = faces.find((face) => kernel.getSurfaceType(face) === 'torus')!;
  const record = arena.faces[faces.indexOf(torus)]!.surface.Torus as {
    center: Point;
    major_radius: number;
    minor_radius: number;
    x_axis: Point;
    y_axis: Point;
    z_axis: Point;
  };
  const meridian = [...kernel.getFaceEdges(torus)].find((edge) => {
    return (
      kernel.getEdgeCurveType(edge) === 'CIRCLE' &&
      Math.abs(
        1 / kernel.measureCurvatureAtEdge(edge, 0)[0]! - record.minor_radius
      ) < 1e-6
    );
  })!;
  const ends = [...kernel.getEdgeVertices(meridian)];
  const angles = [0, 3]
    .map((start) => {
      const delta = record.center.map((c, i) => ends[start + i]! - c);
      const height = delta.reduce(
        (s, value, i) => s + value * record.z_axis[i]!,
        0
      );
      const radial = Math.hypot(
        ...record.x_axis.map((_, i) => delta[i]! - height * record.z_axis[i]!)
      );
      return Math.atan2(height, radial - record.major_radius);
    })
    .sort((a, b) => a - b);
  const half = (angles[1]! - angles[0]!) / 2;
  const middle = (angles[0]! + angles[1]!) / 2;
  const wv = Math.cos(half);
  const arc = [
    [Math.cos(angles[0]!), Math.sin(angles[0]!), 1],
    [Math.cos(middle) / wv, Math.sin(middle) / wv, wv],
    [Math.cos(angles[1]!), Math.sin(angles[1]!), 1]
  ];
  // A rational tensor product of one complete circle and the actual small
  // meridian arc. Its natural domain is the shoulder patch, not a full torus.
  const controlPoints: Point[][] = [];
  const weights: number[][] = [];
  for (let i = 0; i <= 8; i++) {
    const angle = (i * Math.PI) / 4;
    const wu = i % 2 ? Math.SQRT1_2 : 1;
    const radial = record.x_axis.map(
      (x, j) => (x * Math.cos(angle) + record.y_axis[j]! * Math.sin(angle)) / wu
    );
    controlPoints.push(
      arc.map(
        ([c, s]) =>
          record.center.map(
            (value, j) =>
              value +
              radial[j]! * (record.major_radius + record.minor_radius * c!) +
              record.z_axis[j]! * record.minor_radius * s!
          ) as Point
      )
    );
    weights.push(arc.map((p) => wu * p[2]!));
  }
  arena.faces[faces.indexOf(torus)]!.surface = {
    Nurbs: {
      degree_u: 2,
      degree_v: 2,
      knots_u: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1],
      knots_v: [0, 0, 0, 1, 1, 1],
      control_points: controlPoints,
      weights
    }
  };
  // Split the large wall/chamfer ring into two exact arcs. Both the wire
  // compatibility view and authoritative coedge uses must retain the split.
  const rim = arena.edges.findIndex(
    (edge) =>
      edge.curve !== 'Line' && Math.abs(edge.curve.Circle.center[2] - 75) < 1e-6
  );
  const original = arena.edges[rim]!;
  if (original.curve === 'Line')
    throw new Error('Expected circular fixture rim.');
  const circle = original.curve.Circle;
  const [start, end] = original.trim!;
  const mid = (start + end) / 2;
  const vertex = arena.vertices.length;
  arena.vertices.push({
    point: circle.center.map(
      (c, i) =>
        c +
        circle.radius *
          (Math.cos(mid) * circle.u_axis[i]! +
            Math.sin(mid) * circle.v_axis[i]!)
    ) as Point,
    tolerance: arena.vertices[original.start]!.tolerance
  });
  const second = arena.edges.length;
  arena.edges.push({
    ...structuredClone(original),
    start: vertex,
    trim: [mid, end]
  });
  original.end = vertex;
  original.trim = [start, mid];
  for (const wire of arena.wires)
    wire.edges = wire.edges.flatMap((use) =>
      use.edge !== rim
        ? [use]
        : use.forward
          ? [use, { ...use, edge: second }]
          : [{ ...use, edge: second }, use]
    );
  const boundary = arena.boundary_authority;
  for (const loop of boundary.loops)
    loop.coedges = loop.coedges.flatMap((index) => {
      const use = boundary.coedges[index]!;
      if (use.edge !== rim) return [index];
      const added = boundary.coedges.length;
      boundary.coedges.push({ ...use, edge: second });
      return use.forward ? [index, added] : [added, index];
    });
  return kernel.deserializeSolids(
    new TextEncoder().encode(JSON.stringify(arena))
  )[0]!;
}
