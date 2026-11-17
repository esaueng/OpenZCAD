/**
 * Exact kernel section geometry — and the witness that decides whether to
 * trust it.
 *
 * The viewport's section view is a display approximation: three.js clips the
 * disposable tessellation and `sectionCaps` fills the closed contours it can
 * assemble. That is fast enough to drag, and it is not geometry anyone should
 * export. This module asks the kernel for the real thing instead —
 * `section(solid, plane)` returns cross-section FACE handles, whose wires and
 * area are the kernel's own.
 *
 * The kernel's section is candidate evidence, not proof. Measured against the
 * earlier kernel releases, it had three failure modes that all looked like a
 * perfectly ordinary answer:
 *
 * - A plane that misses the body returns an EMPTY handle array, not an error.
 * - A plane flush with a planar face returns that face — full area, nothing
 *   cut. The display cap draws nothing there, and a "section" of a body that
 *   is not sectioned is not a drawing anyone asked for.
 * - A plane parallel to a through-hole's wall can come back as the outer
 *   rectangle with the hole silently missing (a 20x10x6 bar with a 4 mm bore
 *   sections to 120 mm^2 at the bore axis, where the true area is 96 mm^2).
 *   Current releases refuse this case without authoritative cap clipping;
 *   the independent witness still guards against incorrect successful answers.
 *
 * So every exact section is checked against an independent witness computed
 * from the solid's own tessellation: the signed cross-section area obtained by
 * walking the plane-crossing triangle segments. Displacing a contour by at
 * most the tessellation deflection changes its area by at most
 * `deflection * perimeter`, which is the tolerance this module allows. A
 * disagreement larger than that is refused with a named reason — never drawn,
 * never exported.
 *
 * That witness is itself a tessellation, so it cannot tell a curve from a
 * polygon inscribed in it, and the kernel's section does hand back such
 * polygons: where the plane crosses a cylinder, cone, sphere or torus it
 * returns straight chords (64 round a cylinder, 1024 round a sphere), and a
 * NURBS face comes back as sampled chords too. A plate with two 3 mm holes sections to 3143.5421 mm^2 where the true
 * area is 3143.4513 — well inside the witness tolerance. So the boundary is
 * checked a second way, against the solid's own surfaces: a point in the
 * middle of every boundary edge has to lie ON the solid. A chord's does not,
 * and a section holding one is reported as `approximate`, with how far its
 * chords stray, rather than as exact.
 *
 * "How far" is measured in the cutting plane, to a point of the true section
 * curve, not as the distance to the surface: where the surface leans away
 * from the plane the two differ by the sine of the angle between them, and
 * the short one would understate both the deviation and the area it costs.
 */

import type { DxfEntity } from '@openzcad/io-dxf';
import {
  dxfSampleDeflection,
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
  /** Every face of the solid, cavity shells included. */
  getSolidFaces(solid: number): Uint32Array | number[];
  /** `[distance, x, y, z]` to the nearest point of the solid's boundary. */
  pointToSolidDistance(
    px: number,
    py: number,
    pz: number,
    solid: number
  ): Float64Array | number[];
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
  | 'wire-order-unverified'
  /**
   * The named body has no geometry in the document being sectioned.
   *
   * This one is not the kernel's: it is raised by the document-level section
   * when a caller's body list and the document it is sectioning have come
   * apart — the viewport showing a preview document's bodies while the live
   * document is the one being cut, say. It is a refusal rather than a throw
   * so that one stale id cannot take the whole section down with it: every
   * body that does section is still drawn and measured, and because this is
   * not `plane-misses-body` it still shuts the export.
   */
  | 'unknown-body';

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

/**
 * Whether a section's boundary is the solid's own intersection curves.
 *
 * `exact`: every boundary edge lies on the solid, to the kernel's tolerance.
 * `approximate`: at least one edge is a chord standing in for a curve (or
 * could not be checked), so the outline and the area are those of a polygon
 * inscribed in or around the true section.
 */
export type SectionBoundaryFidelity = 'exact' | 'approximate';

export interface SectionBoundaryCheck {
  readonly boundary: SectionBoundaryFidelity;
  /**
   * The farthest a boundary edge's midpoint lies from the true section
   * curve, measured WITHIN the cutting plane, in document units: 0 for an
   * exact boundary and the largest chord sagitta for an approximate one. It
   * is the distance to a point found on the solid and in the plane, so it
   * can overstate the gap and never understates it. Null where that point
   * could not be found for some edge, or an edge was not measured at all.
   */
  readonly boundaryDeviation: number | null;
  /**
   * How far the reported area can be from the true one, in document units
   * squared: each stray edge's in-plane deviation times its length. The
   * segment between a chord and a shallow arc holds two thirds of that
   * product, so the sum covers the polygon's error with half again to spare
   * for an arc that is not symmetric about its chord. Null wherever
   * `boundaryDeviation` is.
   */
  readonly areaUncertainty: number | null;
}

export interface ExactSectionSuccess extends SectionBoundaryCheck {
  readonly status: 'ok';
  /** Kernel face handles of the cross-section, valid until the build unwinds. */
  readonly faces: readonly number[];
  /**
   * The area of the kernel's cross-section faces, in document units squared.
   * The true area only where `boundary` is `exact`; otherwise a polygon's,
   * within `areaUncertainty` of it.
   */
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
  /**
   * Leave the boundary unchecked, for a caller that only wants the faces —
   * the DXF writer draws each edge as the kernel holds it either way. The
   * result then reports `approximate` with unmeasured figures: a boundary
   * nobody checked is not an exact one.
   */
  readonly skipBoundaryCheck?: boolean;
}

const DEFAULT_AREA_EPSILON = 1e-6;

/**
 * Distances below this fraction of the body extent count as "on the plane".
 * The plane test floors the extent at one document unit; see
 * {@link ON_SOLID_RATIO} for why the boundary check may not.
 */
const GRAZE_RATIO = 1e-9;

/**
 * A boundary edge's midpoint within this fraction of the body's largest
 * extent of the solid counts as "on the solid".
 *
 * Purely relative, with no floor in document units. A floor of one unit
 * made the tolerance 1e-9 of whatever the unit was, so the same 0.5 mm
 * sphere was approximate modelled in millimetres and exact modelled in
 * metres, where its chords' 5.9e-10 sagitta fell under the floor. A fraction
 * of the extent gives one verdict for one shape in any unit.
 *
 * A true edge's midpoint measures about 1e-16 of the extent from the solid
 * (rounding, at every scale tried); the chords the kernel cuts a circle into
 * miss by 1.2e-3 of its radius at 64 to the turn and 1.2e-6 at 2048. So this
 * separates the two for any radius above a thousandth of the body's size.
 */
const ON_SOLID_RATIO = 1e-9;

/**
 * How many boundary edges are measured for the deviation and uncertainty
 * FIGURES once a section is known to be approximate. A point-to-solid query
 * visits the solid's faces (about 0.1 to 0.5 ms each), a stray edge takes
 * two or three of them, and a chorded section has 64 to 2048 edges per
 * curve, so a cut through hundreds of round features would otherwise spend
 * seconds refining a number. Past the budget the figures are reported as
 * unmeasured; the verdict itself is never sampled.
 */
const BOUNDARY_PROBE_BUDGET = 2048;

/** Newton steps allowed to carry a stray midpoint onto the section curve. */
const IN_PLANE_STEPS = 8;

/**
 * Below this, the direction to the nearest surface point is all but along
 * the plane normal: the surface lies nearly flat on the plane there, and no
 * step within the plane is known to reach it.
 */
const MIN_IN_PLANE_SLOPE = 1e-6;

const UNCHECKED_BOUNDARY: SectionBoundaryCheck = {
  boundary: 'approximate',
  boundaryDeviation: null,
  areaUncertainty: null
};

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
  millimeterScale = 1,
  modelUnitMm: number = millimeterScale
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
  return {
    origin: plane.origin,
    u: cross(v, normal),
    v,
    scale: millimeterScale,
    sampleDeflection: dxfSampleDeflection(modelUnitMm)
  };
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
  for (const [index, wire] of kernel.getFaceWires(face).entries()) {
    const points: SectionPoint3[] = [];
    for (const edge of kernel.getWireEdges(wire)) {
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

/** A point partway along one boundary edge, and the edge's length. */
function edgeProbe(
  kernel: ExactSectionKernel,
  edge: number,
  deflection: number
): { point: SectionPoint3; length: number } | null {
  if (kernel.getEdgeCurveType(edge) === 'LINE') {
    const ends = kernel.getEdgeVertices(edge);
    const a: SectionPoint3 = [ends[0]!, ends[1]!, ends[2]!];
    const b: SectionPoint3 = [ends[3]!, ends[4]!, ends[5]!];
    const length = norm(sub(b, a));
    return length > 0
      ? {
          point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
          length
        }
      : null;
  }
  // A curved edge: the kernel's own samples lie on its curve, so the middle
  // one is a point of the edge well away from the vertices it shares.
  const flat = kernel.sampleEdge(edge, deflection);
  const count = Math.floor(flat.length / 3);
  if (count < 2) {
    return null;
  }
  const at = (index: number): SectionPoint3 => [
    flat[index * 3]!,
    flat[index * 3 + 1]!,
    flat[index * 3 + 2]!
  ];
  let length = 0;
  for (let i = 1; i < count; i += 1) {
    length += norm(sub(at(i), at(i - 1)));
  }
  return { point: at(Math.floor(count / 2)), length };
}

type SolidDistance = { distance: number; closest: SectionPoint3 } | null;

/** Distance from a point to the solid, and where on it; null if unknown. */
function solidDistance(
  kernel: ExactSectionKernel,
  solid: number,
  point: SectionPoint3
): SolidDistance {
  let hit: Float64Array | number[];
  try {
    hit = kernel.pointToSolidDistance(point[0], point[1], point[2], solid);
  } catch {
    return null;
  }
  const values = [hit[0], hit[1], hit[2], hit[3]];
  if (!values.every((value) => Number.isFinite(value))) {
    return null;
  }
  return { distance: hit[0]!, closest: [hit[1]!, hit[2]!, hit[3]!] };
}

/**
 * How far a stray boundary point lies from the true section curve, measured
 * within the cutting plane — or null when that cannot be certified.
 *
 * The distance to the solid is not that figure. It runs along the surface
 * normal, and where the surface leans away from the plane the gap in the
 * plane is longer by the sine of the angle between them: at z = 9.5 on a
 * radius-10 sphere, a chord 0.0012 from the sphere is 0.0038 from the circle
 * it stands in for.
 *
 * So the point is walked, in the plane, toward the nearest surface point
 * until the kernel says it is ON the solid: Newton's method on the distance,
 * whose slope along the walk is the in-plane share of the direction to the
 * closest point. Where it lands is in the plane and on the solid, hence on
 * the true section curve, and the length walked is a distance from the
 * probe to that curve. A walk that does not land answers null — never the
 * shorter figure it started from.
 */
function inPlaneDeviation(
  kernel: ExactSectionKernel,
  solid: number,
  normal: SectionPoint3,
  point: SectionPoint3,
  first: { distance: number; closest: SectionPoint3 },
  tolerance: number
): number | null {
  const toward = sub(first.closest, point);
  const lift = dot(toward, normal);
  const flat: SectionPoint3 = [
    toward[0] - normal[0] * lift,
    toward[1] - normal[1] * lift,
    toward[2] - normal[2] * lift
  ];
  const flatLength = norm(flat);
  if (!(flatLength > 0)) {
    return null;
  }
  const along: SectionPoint3 = [
    flat[0] / flatLength,
    flat[1] / flatLength,
    flat[2] / flatLength
  ];
  let travelled = 0;
  let distance = first.distance;
  let slope = flatLength / first.distance;
  for (let step = 0; step < IN_PLANE_STEPS; step += 1) {
    if (!(Math.abs(slope) > MIN_IN_PLANE_SLOPE)) {
      break;
    }
    travelled += distance / slope;
    const at: SectionPoint3 = [
      point[0] + along[0] * travelled,
      point[1] + along[1] * travelled,
      point[2] + along[2] * travelled
    ];
    const hit = solidDistance(kernel, solid, at);
    if (!hit) {
      break;
    }
    if (hit.distance <= tolerance) {
      return Math.abs(travelled);
    }
    distance = hit.distance;
    // Negative once the walk has stepped past the surface: the next step
    // then comes back.
    slope = dot(sub(hit.closest, at), along) / hit.distance;
  }
  return null;
}

/**
 * Whether the section's boundary is the solid's own intersection curves, or
 * chords across them.
 *
 * A plane meets a solid's faces in curves that lie on those faces, so every
 * point of a true boundary edge is on the solid. The midpoint of a chord
 * across a curved face is not: it sits a sagitta inside the hole or the
 * material. One sample per edge is enough to tell — a straight line through
 * three points of a cylinder, cone or sphere lies in it — and unlike the
 * tessellated witness it is measured against the solid's analytic surfaces,
 * so no chord tolerance can hide it. `tolerance` is how far from the solid
 * still counts as on it, in document units.
 *
 * The figures for a stray edge are in-plane ones ({@link inPlaneDeviation}),
 * and are withheld for the whole section if any edge's cannot be certified.
 *
 * It reads what the kernel RETURNED rather than assuming how it sections a
 * curved face: a kernel that hands back circle edges for the same cut passes
 * this unchanged, and its section is exact.
 */
export function sectionBoundaryCheck(
  kernel: ExactSectionKernel,
  solid: number,
  faces: readonly number[],
  plane: ExactSectionPlane,
  deflection: number,
  tolerance: number
): SectionBoundaryCheck {
  const normal = unitNormal(plane.normal);
  // Planes meet planes in straight lines, so a solid with no curved face has
  // no curve for a chord to stand in for. (Cavity shells are listed too.)
  const curved = Array.from(kernel.getSolidFaces(solid)).some(
    (face) => kernel.getSurfaceType(face) !== 'plane'
  );
  if (!curved) {
    return { boundary: 'exact', boundaryDeviation: 0, areaUncertainty: 0 };
  }
  const edges: number[] = [];
  for (const face of faces) {
    for (const wire of kernel.getFaceWires(face)) {
      edges.push(...kernel.getWireEdges(wire));
    }
  }
  let deviation = 0;
  let uncertainty = 0;
  let unmeasured = false;
  let stray = false;
  let probes = 0;
  for (const edge of edges) {
    // Every edge is measured until one strays: `exact` is never a sample.
    // After that only the figures are at stake, and they are given up
    // rather than paid for without limit.
    if (stray && probes >= BOUNDARY_PROBE_BUDGET) {
      unmeasured = true;
      break;
    }
    const probe = edgeProbe(kernel, edge, deflection);
    if (!probe) {
      continue;
    }
    probes += 1;
    const hit = solidDistance(kernel, solid, probe.point);
    if (!hit) {
      // An edge that cannot be shown to lie on the solid is not exact, and
      // with it unmeasured there is no figure left to refine.
      unmeasured = true;
      break;
    }
    if (hit.distance > tolerance) {
      stray = true;
      const inPlane = inPlaneDeviation(
        kernel,
        solid,
        normal,
        probe.point,
        hit,
        tolerance
      );
      if (inPlane === null) {
        // The verdict stands; a figure that might understate does not.
        unmeasured = true;
        break;
      }
      deviation = Math.max(deviation, inPlane);
      uncertainty += inPlane * probe.length;
    }
  }
  if (unmeasured) {
    return UNCHECKED_BOUNDARY;
  }
  return {
    boundary: stray ? 'approximate' : 'exact',
    boundaryDeviation: deviation,
    areaUncertainty: uncertainty
  };
}

/**
 * Compute the kernel's section of one solid, or refuse with a named reason.
 *
 * A success is not yet a claim of exactness: `boundary` says whether the
 * outline is the solid's own curves or a polygon across them.
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
    ...(options.skipBoundaryCheck
      ? UNCHECKED_BOUNDARY
      : sectionBoundaryCheck(
          kernel,
          solid,
          faces,
          plane,
          deflection,
          // The body's own size, in its own units — not `grazeTolerance`,
          // whose one-unit floor would make this verdict depend on them.
          Math.max(...extents.map(Math.abs)) * ON_SOLID_RATIO
        )),
    loops,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices)
  };
}

/**
 * The section's boundary as 2D DXF entities, in millimetres: each kernel edge
 * as the kernel holds it, so a boundary reported `approximate` is written as
 * the straight segments it is.
 *
 * Every face shares one frame derived from the cutting plane itself, so the
 * regions of a multi-region cut stay in register with each other — a per-face
 * frame would scatter them around their own local origins.
 */
export function sectionDxfEntities(
  kernel: ExactSectionKernel,
  faces: readonly number[],
  plane: ExactSectionPlane,
  millimeterScale: number,
  /** Millimetres per model unit; differs from the scale for a non-mm export. */
  modelUnitMm: number = millimeterScale
): DxfEntity[] {
  if (!(millimeterScale > 0) || !Number.isFinite(millimeterScale)) {
    throw new Error(`DXF export: invalid unit scale ${millimeterScale}.`);
  }
  const frame = sectionPlaneFrame(plane, millimeterScale, modelUnitMm);
  const entities: DxfEntity[] = [];
  for (const face of faces) {
    for (const wire of kernel.getFaceWires(face)) {
      for (const edge of kernel.getWireEdges(wire)) {
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
export interface SectionOutlineRegion extends SectionBoundaryCheck {
  readonly bodyId: string;
  /** The true area only where `boundary` is `exact`. */
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
 * The kernel's section of a whole document at one plane. Face handles stay
 * behind in the kernel arena: everything here is a copy the viewport and the
 * exporter can keep.
 */
export interface SectionOutlineReport {
  readonly plane: ExactSectionPlane;
  readonly regions: readonly SectionOutlineRegion[];
  readonly refusals: readonly SectionOutlineRefusal[];
}
