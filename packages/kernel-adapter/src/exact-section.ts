/**
 * Exact kernel section geometry — and the witness that decides whether to
 * trust it.
 *
 * The viewport's section view is a display approximation: three.js clips the
 * disposable tessellation and `sectionCaps` fills the closed contours it can
 * assemble. That is fast enough to drag, and it is not geometry anyone should
 * export. This module asks the kernel for the real thing instead —
 * `section(solid, plane)` returns cross-section FACE handles, whose wires are
 * exact curves and whose area is the kernel's own.
 *
 * The kernel's section is candidate evidence, not proof. Measured against the
 * pinned kernel (2.131.0), it has three failure modes that all look like a
 * perfectly ordinary answer:
 *
 * - A plane that misses the body returns an EMPTY handle array, not an error.
 * - A plane flush with a planar face returns that face — full area, nothing
 *   cut. The display cap draws nothing there, and a "section" of a body that
 *   is not sectioned is not a drawing anyone asked for.
 * - A plane parallel to a through-hole's wall can come back as the outer
 *   rectangle with the hole silently missing (a 20x10x6 bar with a 4 mm bore
 *   sections to 120 mm^2 at the bore axis, where the true area is 96 mm^2).
 *
 * So every exact section is checked against an independent witness computed
 * from the solid's own tessellation: the signed cross-section area obtained by
 * walking the plane-crossing triangle segments. Displacing a contour by at
 * most the tessellation deflection changes its area by at most
 * `deflection * perimeter`, which is the tolerance this module allows. A
 * disagreement larger than that is refused with a named reason — never drawn,
 * never exported.
 */

import type { DxfEntity } from '@openzcad/io-dxf';
import {
  edgeDxfEntities,
  type DxfEdgeKernel,
  type DxfPlaneFrame
} from './exact-dxf';
import { displayTessellationForExtents } from './display-tessellation';

export type SectionPoint3 = readonly [number, number, number];

/** An unbounded cutting plane in document space. */
export interface ExactSectionPlane {
  readonly origin: SectionPoint3;
  readonly normal: SectionPoint3;
}

/** A triangle mesh as the kernel hands it back. */
export interface SectionKernelMesh {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
  free(): void;
}

/** The query surface an exact section needs from the kernel. */
export interface ExactSectionKernel extends DxfEdgeKernel {
  section(
    solid: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number
  ): Uint32Array;
  boundingBox(solid: number): Float64Array;
  getSurfaceType(face: number): string;
  faceArea(face: number, deflection: number): number;
  getFaceWires(face: number): Uint32Array;
  getWireEdges(wire: number): Uint32Array;
  tessellateFace(
    face: number,
    deflection: number,
    angularTolerance?: number | null
  ): SectionKernelMesh;
  tessellateSolid(
    solid: number,
    deflection: number,
    angularTolerance?: number | null
  ): SectionKernelMesh;
}

/**
 * Why an exact section was refused. Each one is a case the kernel answers
 * with something that would otherwise pass for geometry.
 */
export type ExactSectionRefusalReason =
  /** The plane does not pass through the body, or only grazes its surface. */
  | 'plane-misses-body'
  /** The kernel could not assemble a cross-section (it raised). */
  | 'kernel-refused'
  /** The plane cuts the body but the kernel returned no faces. */
  | 'empty-section'
  /** A cross-section face is not planar; a section curve must be flat. */
  | 'non-planar-section'
  /** The kernel's area disagrees with the tessellated witness. */
  | 'area-mismatch'
  /** The kernel's wire order does not put the outer boundary first. */
  | 'wire-order-unverified';

export interface ExactSectionRefusal {
  readonly status: 'refused';
  readonly reason: ExactSectionRefusalReason;
  readonly message: string;
}

export interface ExactSectionLoop {
  /** The outer boundary of a section region, or one of its holes. */
  readonly kind: 'outer' | 'inner';
  /** Closed document-space polyline; the closing point is not repeated. */
  readonly points: readonly SectionPoint3[];
}

export interface ExactSectionSuccess {
  readonly status: 'ok';
  /** Kernel face handles of the cross-section, valid until the build unwinds. */
  readonly faces: readonly number[];
  /** The kernel's cross-section area, in document units squared. */
  readonly area: number;
  /** The independent tessellated area the kernel's had to agree with. */
  readonly witnessArea: number;
  /** How far the two were allowed to differ at this tessellation. */
  readonly areaTolerance: number;
  readonly loops: readonly ExactSectionLoop[];
  /** Display triangles for the cut surface, in document space. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export type ExactSectionOutcome = ExactSectionSuccess | ExactSectionRefusal;

export interface ExactSectionOptions {
  /**
   * Chord tolerance for the witness tessellation and for sampled section
   * curves, in document units. Defaults to the viewport's own display
   * tessellation for the solid's extents, so the exact section is graded
   * against the same mesh quality the clipped preview is drawn from.
   */
  readonly deflection?: number;
  /**
   * Absolute area slack added to `deflection * perimeter`, for the rounding
   * of a large cross-section. Defaults to a square micrometre.
   */
  readonly areaEpsilon?: number;
}

const DEFAULT_AREA_EPSILON = 1e-6;

/** Distances below this fraction of the body extent count as "on the plane". */
const GRAZE_RATIO = 1e-9;

function refuse(
  reason: ExactSectionRefusalReason,
  message: string
): ExactSectionRefusal {
  return { status: 'refused', reason, message };
}

const sub = (a: SectionPoint3, b: SectionPoint3): SectionPoint3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2]
];
const cross = (a: SectionPoint3, b: SectionPoint3): SectionPoint3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const dot = (a: SectionPoint3, b: SectionPoint3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: SectionPoint3): number => Math.hypot(a[0], a[1], a[2]);

function unitNormal(normal: SectionPoint3): SectionPoint3 {
  const length = norm(normal);
  if (!(length > 1e-12)) {
    throw new Error('Section plane normal is degenerate.');
  }
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

/**
 * The in-plane frame every section shares: deterministic from the normal, so
 * two exports of the same plane land on the same coordinates, and one frame
 * covers every face of a multi-region cut.
 *
 * The drawing's up axis is world +Z wherever the plane allows it, which is
 * what a sectional view is expected to look like — a vertical cut comes out
 * standing up, and a horizontal one (where +Z is the view direction) falls
 * back to +Y so that the plan keeps world X running to the right.
 */
export function sectionPlaneFrame(
  plane: ExactSectionPlane,
  millimeterScale = 1
): DxfPlaneFrame {
  const normal = unitNormal(plane.normal);
  const up: SectionPoint3 = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const along = dot(up, normal);
  const v = unitNormal([
    up[0] - normal[0] * along,
    up[1] - normal[1] * along,
    up[2] - normal[2] * along
  ]);
  // u x v = normal, so the 2D frame is right-handed about the cut direction.
  return { origin: plane.origin, u: cross(v, normal), v, scale: millimeterScale };
}

export interface SectionWitness {
  /** Signed cross-section area; material sits to the left of each segment. */
  readonly area: number;
  /** Total length of the plane-crossing segments. */
  readonly perimeter: number;
  /** Signed distance range of the mesh from the plane. */
  readonly minDistance: number;
  readonly maxDistance: number;
}

/**
 * Cross-section area of a closed triangle mesh, measured independently of the
 * kernel's own section.
 *
 * Each triangle that straddles the plane contributes one segment, directed
 * `planeNormal x triangleNormal` so that material lies to its left. Summing
 * the shoelace term of those directed segments gives the enclosed area
 * directly: hole boundaries are traced the other way round and subtract
 * themselves, with no contour assembly, no welding tolerance, and no
 * dependence on the kernel's topology.
 */
export function tessellatedSectionWitness(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  plane: ExactSectionPlane
): SectionWitness {
  const normal = unitNormal(plane.normal);
  const frame = sectionPlaneFrame({ origin: plane.origin, normal });
  const origin = plane.origin;
  const pointOf = (index: number): SectionPoint3 => [
    positions[index * 3]!,
    positions[index * 3 + 1]!,
    positions[index * 3 + 2]!
  ];
  let area = 0;
  let perimeter = 0;
  let minDistance = Infinity;
  let maxDistance = -Infinity;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const points = [
      pointOf(indices[i]!),
      pointOf(indices[i + 1]!),
      pointOf(indices[i + 2]!)
    ];
    const distances = points.map((point) => dot(sub(point, origin), normal));
    for (const distance of distances) {
      minDistance = Math.min(minDistance, distance);
      maxDistance = Math.max(maxDistance, distance);
    }
    const crossings: SectionPoint3[] = [];
    for (let j = 0; j < 3; j += 1) {
      const k = (j + 1) % 3;
      const a = distances[j]!;
      const b = distances[k]!;
      // Half-open classification: a vertex exactly on the plane counts as
      // positive, so a plane through a shared vertex or edge never yields the
      // same segment twice.
      if (a > 0 === b > 0) {
        continue;
      }
      const t = a / (a - b);
      const p = points[j]!;
      const q = points[k]!;
      crossings.push([
        p[0] + (q[0] - p[0]) * t,
        p[1] + (q[1] - p[1]) * t,
        p[2] + (q[2] - p[2]) * t
      ]);
    }
    if (crossings.length !== 2) {
      continue;
    }
    const triangleNormal = cross(
      sub(points[1]!, points[0]!),
      sub(points[2]!, points[0]!)
    );
    // The direction that keeps material to the left of the segment.
    const forward = cross(normal, triangleNormal);
    const [first, second] = crossings as [SectionPoint3, SectionPoint3];
    const oriented =
      dot(sub(second, first), forward) >= 0 ? [first, second] : [second, first];
    const p = oriented[0]!;
    const q = oriented[1]!;
    const pu = dot(sub(p, origin), frame.u);
    const pv = dot(sub(p, origin), frame.v);
    const qu = dot(sub(q, origin), frame.u);
    const qv = dot(sub(q, origin), frame.v);
    area += (pu * qv - qu * pv) / 2;
    perimeter += norm(sub(q, p));
  }
  return { area, perimeter, minDistance, maxDistance };
}

function sectionLoops(
  kernel: ExactSectionKernel,
  face: number,
  deflection: number
): { loops: ExactSectionLoop[] } | ExactSectionRefusal {
  const loops: ExactSectionLoop[] = [];
  for (const [index, wire] of Array.from(kernel.getFaceWires(face)).entries()) {
    const points: SectionPoint3[] = [];
    for (const edge of Array.from(kernel.getWireEdges(wire))) {
      const flat = kernel.sampleEdge(edge, deflection);
      // Each edge's last sample is the next edge's first; dropping it keeps
      // the loop a clean closed polyline with no repeated point.
      for (let i = 0; i * 3 < flat.length - 3; i += 1) {
        points.push([flat[i * 3]!, flat[i * 3 + 1]!, flat[i * 3 + 2]!]);
      }
    }
    if (points.length < 3) {
      return refuse(
        'empty-section',
        'A cross-section boundary has fewer than three points.'
      );
    }
    loops.push({ kind: index === 0 ? 'outer' : 'inner', points });
  }
  if (loops.length === 0) {
    return refuse('empty-section', 'A cross-section face has no boundary.');
  }
  return { loops };
}

/** Enclosed area of one loop in the plane frame, sign discarded. */
function loopArea(
  loop: ExactSectionLoop,
  plane: ExactSectionPlane,
  frame: DxfPlaneFrame
): number {
  let total = 0;
  for (let i = 0; i < loop.points.length; i += 1) {
    const p = sub(loop.points[i]!, plane.origin);
    const q = sub(loop.points[(i + 1) % loop.points.length]!, plane.origin);
    total +=
      (dot(p, frame.u) * dot(q, frame.v) - dot(q, frame.u) * dot(p, frame.v)) /
      2;
  }
  return Math.abs(total);
}

/**
 * Compute the exact section of one solid, or refuse with a named reason.
 *
 * The returned face handles live in the kernel arena and stay valid only as
 * long as the caller's build does; the loops and triangles are copies and
 * outlive it.
 */
export function exactSolidSection(
  kernel: ExactSectionKernel,
  solid: number,
  requestedPlane: ExactSectionPlane,
  options: ExactSectionOptions = {}
): ExactSectionOutcome {
  const plane: ExactSectionPlane = {
    origin: requestedPlane.origin,
    normal: unitNormal(requestedPlane.normal)
  };
  const box = kernel.boundingBox(solid);
  const extents: [number, number, number] = [
    box[3]! - box[0]!,
    box[4]! - box[1]!,
    box[5]! - box[2]!
  ];
  const deflection =
    options.deflection ??
    displayTessellationForExtents(...extents).linearDeflection;
  const grazeTolerance = Math.max(...extents.map(Math.abs), 1) * GRAZE_RATIO;

  const solidMesh = kernel.tessellateSolid(solid, deflection);
  let witness: SectionWitness;
  try {
    witness = tessellatedSectionWitness(
      solidMesh.positions,
      solidMesh.indices,
      plane
    );
  } finally {
    solidMesh.free();
  }
  // A plane flush with a face has material on one side only. The kernel
  // answers that with the face itself — a full outline of an uncut body.
  if (
    witness.minDistance >= -grazeTolerance ||
    witness.maxDistance <= grazeTolerance
  ) {
    return refuse(
      'plane-misses-body',
      'The section plane does not pass through this body.'
    );
  }

  let faces: number[];
  try {
    faces = Array.from(
      kernel.section(
        solid,
        plane.origin[0],
        plane.origin[1],
        plane.origin[2],
        plane.normal[0],
        plane.normal[1],
        plane.normal[2]
      )
    );
  } catch (error) {
    return refuse(
      'kernel-refused',
      error instanceof Error
        ? `The kernel could not section this body: ${error.message}`
        : 'The kernel could not section this body.'
    );
  }
  if (faces.length === 0) {
    return refuse(
      'empty-section',
      'The kernel returned no cross-section for a plane that cuts this body.'
    );
  }

  const frame = sectionPlaneFrame(plane);
  let area = 0;
  const loops: ExactSectionLoop[] = [];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const surface = kernel.getSurfaceType(face);
    if (surface !== 'plane') {
      return refuse(
        'non-planar-section',
        `The kernel returned a ${surface} cross-section face; a section curve must be planar.`
      );
    }
    area += kernel.faceArea(face, deflection);
    const faceLoops = sectionLoops(kernel, face, deflection);
    if ('status' in faceLoops) {
      return faceLoops;
    }
    // The kernel documents "outer wire first, then inner/hole wires". Verify
    // it rather than assume it: a hole taken for the outer boundary would
    // export a plausible, wrong outline.
    const areas = faceLoops.loops.map((loop) => loopArea(loop, plane, frame));
    if (areas.some((value, index) => index > 0 && value > areas[0]!)) {
      return refuse(
        'wire-order-unverified',
        'The kernel did not return the outer cross-section boundary first.'
      );
    }
    loops.push(...faceLoops.loops);
    const mesh = kernel.tessellateFace(face, deflection);
    try {
      const base = positions.length / 3;
      for (const value of mesh.positions) {
        positions.push(value);
      }
      for (const index of mesh.indices) {
        indices.push(base + index);
      }
    } finally {
      mesh.free();
    }
  }

  const areaTolerance =
    deflection * witness.perimeter +
    (options.areaEpsilon ?? DEFAULT_AREA_EPSILON);
  const witnessArea = Math.abs(witness.area);
  if (Math.abs(area - witnessArea) > areaTolerance) {
    return refuse(
      'area-mismatch',
      `The kernel's cross-section area (${area.toFixed(4)}) disagrees with the tessellated witness (${witnessArea.toFixed(4)}) by more than ${areaTolerance.toFixed(4)}.`
    );
  }

  return {
    status: 'ok',
    faces,
    area,
    witnessArea,
    areaTolerance,
    loops,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices)
  };
}

/**
 * The exact section's boundary as 2D DXF entities, in millimetres.
 *
 * Every face shares one frame derived from the cutting plane itself, so the
 * regions of a multi-region cut stay in register with each other — a per-face
 * frame would scatter them around their own local origins.
 */
export function sectionDxfEntities(
  kernel: ExactSectionKernel,
  faces: readonly number[],
  plane: ExactSectionPlane,
  millimeterScale: number
): DxfEntity[] {
  if (!(millimeterScale > 0) || !Number.isFinite(millimeterScale)) {
    throw new Error(`DXF export: invalid unit scale ${millimeterScale}.`);
  }
  const frame = sectionPlaneFrame(plane, millimeterScale);
  const entities: DxfEntity[] = [];
  for (const face of faces) {
    for (const wire of Array.from(kernel.getFaceWires(face))) {
      for (const edge of Array.from(kernel.getWireEdges(wire))) {
        entities.push(...edgeDxfEntities(kernel, edge, frame));
      }
    }
  }
  if (entities.length === 0) {
    throw new Error('DXF export: the section produced no drawable entities.');
  }
  return entities;
}

/** One body's cross-section, as it crosses out of the kernel build. */
export interface SectionOutlineRegion {
  readonly bodyId: string;
  readonly area: number;
  readonly loops: readonly ExactSectionLoop[];
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/** A body the plane could not be sectioned through, and why. */
export interface SectionOutlineRefusal {
  readonly bodyId: string;
  readonly reason: ExactSectionRefusalReason;
  readonly message: string;
}

/**
 * The exact section of a whole document at one plane. Face handles stay
 * behind in the kernel arena: everything here is a copy the viewport and the
 * exporter can keep.
 */
export interface SectionOutlineReport {
  readonly plane: ExactSectionPlane;
  readonly regions: readonly SectionOutlineRegion[];
  readonly refusals: readonly SectionOutlineRefusal[];
}
