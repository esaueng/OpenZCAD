/**
 * Exact separation of a group of constant-depth planar embosses. This is a
 * geometry proof, not OCR: names and glyph outlines are never guessed.
 *
 * The v3 arena boundary graph is the pinned kernel's native interchange. A
 * support face's inner loops isolate each embossed component. Its sides must
 * be straight extrusions, with one planar cap and optional coplanar islands
 * (the holes in letters). Closing the footprints gives the plain support;
 * extruding the original caps back gives the original raised material.
 */
import type { PlanarEmbossSelection, Transform3D } from '@openzcad/shared';
import { RemusKernel } from './remus-runtime';
import { faceFingerprint } from './exact-witnesses';
import { transformMatrix } from './exact-math';

type Point = [number, number, number];
interface Surface {
  Plane?: { normal: Point; d: number };
  Cylinder?: { axis: Point };
  Nurbs?: {
    degree_u: number;
    degree_v: number;
    control_points: Point[][];
    weights: number[][];
  };
}
interface Arena {
  version: number;
  faces: {
    outer_wire: number;
    inner_wires: number[];
    surface: Surface;
    reversed: boolean;
  }[];
  wires: { edges: { edge: number }[] }[];
  shells: { faces: number[] }[];
  solids: { outer_shell: number; inner_shells: number[] }[];
  solid_roots: number[];
  boundary_authority: {
    faces: { outer_loop: number; inner_loops: number[] }[];
    loops: { coedges: number[]; closed: boolean }[];
    coedges: unknown[];
  };
}
const TOLERANCE = 1e-6;
const dot = (a: Point, b: Point) => a.reduce((s, v, i) => s + v * b[i]!, 0);
const subtract = (a: Point, b: Point): Point => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2]
];
const parallel = (a: Point, b: Point) =>
  Math.abs(Math.abs(dot(a, b)) - 1) < TOLERANCE;
const vector = (p: Point) => ({ x: p[0], y: p[1], z: p[2] });
const tidy = (n: number) => Math.round(n * 1e6) / 1e6;

/** Prove that the exact surface is invariant along the extrusion direction. */
function straightSide(surface: Surface, normal: Point): boolean {
  if (surface.Plane)
    return Math.abs(dot(surface.Plane.normal, normal)) < TOLERANCE;
  if (surface.Cylinder) return parallel(surface.Cylinder.axis, normal);
  const nurbs = surface.Nurbs;
  if (!nurbs) return false;
  let rows = nurbs.control_points;
  let weights = nurbs.weights;
  if (nurbs.degree_v !== 1 || rows.some((row) => row.length !== 2)) {
    if (nurbs.degree_u !== 1 || rows.length !== 2) return false;
    rows = rows[0]!.map((_, i) => [rows[0]![i]!, rows[1]![i]!]);
    weights = weights[0]!.map((_, i) => [weights[0]![i]!, weights[1]![i]!]);
  }
  const shift = subtract(rows[0]![1]!, rows[0]![0]!);
  const distance = dot(shift, normal);
  if (Math.abs(distance) < TOLERANCE) return false;
  return rows.every((row, i) => {
    const delta = subtract(row[1]!, row[0]!);
    return (
      delta.every(
        (v, axis) => Math.abs(v - normal[axis]! * distance) < TOLERANCE
      ) && Math.abs(weights[i]![0]! - weights[i]![1]!) < 1e-10
    );
  });
}

function facePoints(kernel: RemusKernel, face: number): Point[] {
  return Array.from(kernel.getFaceEdges(face)).flatMap((edge) => {
    const values = kernel.sampleEdge(edge, 0.01);
    const points: Point[] = [];
    for (let i = 0; i < values.length; i += 3)
      points.push([values[i]!, values[i + 1]!, values[i + 2]!]);
    return points;
  });
}

interface Separation {
  selection: PlanarEmbossSelection;
  base: Uint8Array;
  text: Uint8Array;
}

function candidate(
  kernel: RemusKernel,
  arena: Arena,
  support: number,
  edgeFaces: Map<number, number[]>
): Separation | null {
  const supportFace = arena.faces[support]!;
  const plane = supportFace.surface.Plane;
  // A single boss is not sufficient evidence of a group of lettering.
  if (
    !plane ||
    supportFace.inner_wires.length < 2 ||
    supportFace.inner_wires.length > 64
  )
    return null;
  const normal = plane.normal.map((n) =>
    supportFace.reversed ? -n : n
  ) as Point;
  const offset = supportFace.reversed ? -plane.d : plane.d;
  if (Math.abs(dot(normal, normal) - 1) > TOLERANCE) return null;
  const removed = new Set<number>();
  const caps: number[] = [];
  let depth: number | undefined;
  for (const wire of supportFace.inner_wires) {
    const pending = arena.wires[wire]!.edges.flatMap(
      ({ edge }) => edgeFaces.get(edge) ?? []
    ).filter((f) => f !== support);
    const component = new Set<number>();
    while (pending.length) {
      const face = pending.pop()!;
      if (face === support || component.has(face)) continue;
      if (removed.has(face)) return null;
      component.add(face);
      if (component.size > 256) return null;
      const node = arena.faces[face]!;
      for (const w of [node.outer_wire, ...node.inner_wires])
        for (const { edge } of arena.wires[w]!.edges)
          pending.push(
            ...(edgeFaces.get(edge) ?? []).filter((f) => f !== support)
          );
    }
    const componentCaps: number[] = [];
    for (const face of component) {
      const node = arena.faces[face]!;
      const surface = node.surface;
      if (surface.Plane && parallel(surface.Plane.normal, normal)) {
        const d = surface.Plane.d * dot(surface.Plane.normal, normal) - offset;
        const outward = surface.Plane.normal.map((n) =>
          node.reversed ? -n : n
        ) as Point;
        if (dot(outward, normal) < 1 - TOLERANCE || d < -TOLERANCE) return null;
        if (d > TOLERANCE) {
          if (depth !== undefined && Math.abs(d - depth) > TOLERANCE)
            return null;
          depth = d;
          componentCaps.push(face);
        }
      } else if (!straightSide(surface, normal)) return null;
    }
    if (componentCaps.length !== 1) return null;
    caps.push(componentCaps[0]!);
    component.forEach((face) => removed.add(face));
  }
  if (!depth || caps.length !== supportFace.inner_wires.length) return null;
  // Extents supplement the exact side-surface proof, refusing material behind
  // the support or past the cap (engraving, stepped letters, buried cavities).
  const points = [...removed].flatMap((f) => facePoints(kernel, f));
  if (
    !points.length ||
    points.some((p) => {
      const distance = dot(p, normal) - offset;
      return distance < -TOLERANCE || distance > depth + TOLERANCE;
    })
  )
    return null;
  const plain = structuredClone(arena);
  plain.faces[support]!.inner_wires = [];
  plain.boundary_authority.faces[support]!.inner_loops = [];
  plain.shells[0]!.faces = plain.shells[0]!.faces.filter(
    (f) => !removed.has(f)
  );
  // Removing loops requires compacting the coedge ownership table. Keep all
  // other exact surfaces/curves and their tolerance records byte-for-byte.
  const boundary = plain.boundary_authority;
  const loops: Arena['boundary_authority']['loops'] = [];
  const coedges: unknown[] = [];
  for (const face of boundary.faces) {
    const next = [face.outer_loop, ...face.inner_loops].map((index) => {
      const loop = boundary.loops[index]!;
      const result = loops.length;
      loops.push({
        ...loop,
        coedges: loop.coedges.map((i) => {
          const c = coedges.length;
          coedges.push(boundary.coedges[i]);
          return c;
        })
      });
      return result;
    });
    face.outer_loop = next[0]!;
    face.inner_loops = next.slice(1);
  }
  boundary.loops = loops;
  boundary.coedges = coedges;
  const [base] = kernel.deserializeSolids(
    new TextEncoder().encode(JSON.stringify(plain))
  );
  if (base === undefined || kernel.validateSolid(base) !== 0) return null;
  const letters = caps.map((face) =>
    kernel.extrude(face, -normal[0], -normal[1], -normal[2], depth)
  );
  if (letters.some((solid) => kernel.validateSolid(solid) !== 0)) return null;
  // Do not substitute tessellated volume for this topology/surface proof:
  // retriangulating a curved letter changes that estimate with deflection.
  const hashes = caps
    .map((face) => faceFingerprint(kernel, face))
    .sort((a, b) => a - b);
  if (new Set(hashes).size !== hashes.length) return null;
  return {
    selection: {
      supportFaceHash: faceFingerprint(kernel, support),
      capFaceHashes: hashes,
      normal: vector(normal),
      depth: tidy(depth),
      bounds: {
        min: vector(
          [0, 1, 2].map((axis) =>
            tidy(Math.min(...points.map((p) => p[axis]!)))
          ) as Point
        ),
        max: vector(
          [0, 1, 2].map((axis) =>
            tidy(Math.max(...points.map((p) => p[axis]!)))
          ) as Point
        )
      }
    },
    base: kernel.serializeSolids(Uint32Array.of(base)),
    text: kernel.serializeSolids(new Uint32Array(letters))
  };
}

function analyze(kernel: RemusKernel, solid: number): Separation | null {
  const bytes = kernel.serializeSolids(Uint32Array.of(solid));
  const arena = JSON.parse(new TextDecoder().decode(bytes)) as Arena;
  if (
    arena.version !== 3 ||
    arena.shells.length !== 1 ||
    arena.solids.length !== 1 ||
    arena.solid_roots.length !== 1 ||
    arena.solids[0]!.inner_shells.length !== 0 ||
    !arena.boundary_authority ||
    arena.faces.length > 1500
  )
    return null;
  // This short-lived worker-local kernel gives the arena stable local handles;
  // verify the mapping explicitly rather than persist traversal ordinals.
  const probe = new RemusKernel();
  try {
    const [source] = probe.deserializeSolids(bytes);
    if (source === undefined || probe.validateSolid(source) !== 0) return null;
    const faces = [...probe.getSolidFaces(source)];
    if (JSON.stringify(faces) !== JSON.stringify(arena.shells[0]!.faces))
      return null;
    const edgeFaces = new Map<number, number[]>();
    for (const face of faces)
      for (const wire of [
        arena.faces[face]!.outer_wire,
        ...arena.faces[face]!.inner_wires
      ])
        for (const { edge } of arena.wires[wire]!.edges)
          edgeFaces.set(edge, [...(edgeFaces.get(edge) ?? []), face]);
    if ([...edgeFaces.values()].some((owners) => owners.length !== 2))
      return null;
    const matches: Separation[] = [];
    for (const support of faces) {
      const match = candidate(probe, arena, support, edgeFaces);
      if (match) matches.push(match);
      if (matches.length > 1) return null;
    }
    return matches[0] ?? null;
  } finally {
    probe.free();
  }
}

export function recognizePlanarEmboss(
  kernel: RemusKernel,
  solid: number
): PlanarEmbossSelection | null {
  try {
    return analyze(kernel, solid)?.selection ?? null;
  } catch {
    return null;
  }
}

export function separatePlanarEmboss(
  kernel: RemusKernel,
  solid: number,
  selection: PlanarEmbossSelection,
  part: 'base' | 'text',
  sourcePlacement: readonly Transform3D[] = []
): number[] {
  const match = analyze(kernel, solid);
  // Recognition requires exactly one group. Prove that group against the
  // positioned source, then return its original exact geometry so the normal
  // Move history places it once, without an inverse-transform round trip.
  let positioned = solid;
  for (const transform of sourcePlacement) {
    if (
      ![
        transform.translation.x,
        transform.translation.y,
        transform.translation.z,
        transform.rotationDeg.x,
        transform.rotationDeg.y,
        transform.rotationDeg.z
      ].every((value) => typeof value === 'number' && Number.isFinite(value))
    )
      throw new Error('Lettering source placement must be fixed and rigid.');
    positioned = kernel.copyAndTransformSolid(
      positioned,
      transformMatrix(transform.translation, transform.rotationDeg)
    );
  }
  const measured = sourcePlacement.length ? analyze(kernel, positioned) : match;
  const key = (s: PlanarEmbossSelection) =>
    JSON.stringify([
      s.supportFaceHash,
      s.capFaceHashes,
      s.normal.x,
      s.normal.y,
      s.normal.z,
      s.depth,
      s.bounds.min.x,
      s.bounds.min.y,
      s.bounds.min.z,
      s.bounds.max.x,
      s.bounds.max.y,
      s.bounds.max.z
    ]);
  if (!match || !measured || key(measured.selection) !== key(selection))
    throw new Error(
      'The raised lettering no longer matches its measured source. Re-import and request a fresh proposal.'
    );
  if (part !== 'base' && part !== 'text')
    throw new Error('Unknown lettering part.');
  return [...kernel.deserializeSolids(match[part])];
}
