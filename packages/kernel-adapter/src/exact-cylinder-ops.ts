/**
 * Analytic cylinder constructions: exact cap offsets, coaxial cuts, and
 * through-hole fills built by revolving radial profiles instead of running a
 * general boolean. Returning undefined here means "not the simple analytic
 * case" and the caller falls through to the general path.
 */
import type { RemusKernel } from './remus-runtime';
import type { Vec2, Vec3 } from '@openzcad/geometry';
import {
  measureFaceGeometry,
  type ThroughHoleGeometry
} from './exact-measure';
import {
  readAnalyticCylinder,
  type AnalyticCylinder
} from './exact-brep';
import {
  ANALYTIC_MATCH_EPSILON,
  GEOMETRY_EPSILON,
  coordinateFrameMatrix,
  dot,
  length,
  normalized,
  scale,
  subtract
} from './exact-math';

/** Revolve a radial/axial section around local +Z, then place it in world space. */
export function revolveRadialProfile(
  kernel: RemusKernel,
  profile: Vec2[],
  cylinder: AnalyticCylinder
): number {
  const edges = profile.map((point, index) => {
    const next = profile[(index + 1) % profile.length]!;
    return kernel.makeLineEdge(point.x, 0, point.y, next.x, 0, next.y);
  });
  const wire = kernel.makeWire(Uint32Array.from(edges), true);
  const face = kernel.makePlanarFaceFromWire(wire);
  const local = kernel.revolve(face, 0, 0, 0, 0, 0, 1, 360);
  return kernel.copyAndTransformSolid(
    local,
    coordinateFrameMatrix(cylinder.origin, cylinder.axis)
  );
}

/**
 * Move either cap of a simple analytic cylinder by rebuilding the equivalent
 * primitive in the cylinder's world-space frame. Repeated cylindrical
 * resizes leave a valid analytic solid, but Remus's generic cap boolean can
 * accumulate a mismatched circular boundary and fail its exact volume gate.
 * This path is deliberately limited to the three-face cylinder case; every
 * more complex prismatic face still uses the general push/pull operation.
 */
export function tryExactAnalyticCylinderCapOffset(
  kernel: RemusKernel,
  solid: number,
  face: number,
  offset: number
): number | null {
  const cylinder = readAnalyticCylinder(kernel, solid);
  const cap = measureFaceGeometry(kernel, face);
  if (
    !cylinder ||
    cap?.surfaceType !== 'plane' ||
    !cap.normal ||
    !Number.isFinite(offset)
  ) {
    return null;
  }

  const normal = normalized(cap.normal);
  if (!normal) {
    return null;
  }
  const alignment = dot(normal, cylinder.axis);
  const span = Math.max(
    1,
    cylinder.radius,
    cylinder.axialMax - cylinder.axialMin
  );
  const linearTolerance = ANALYTIC_MATCH_EPSILON * span;
  const areaTolerance = Math.max(
    // Face area is measured through Remus's bounded-deflection integration,
    // so a circular cap is not bit-exact even though its surface is analytic.
    Math.PI * cylinder.radius * cylinder.radius * 5e-4,
    1e-7
  );
  const expectedCapArea = Math.PI * cylinder.radius * cylinder.radius;
  if (
    Math.abs(Math.abs(alignment) - 1) > ANALYTIC_MATCH_EPSILON ||
    Math.abs(cap.area - expectedCapArea) > areaTolerance
  ) {
    return null;
  }

  const capAxialPosition = dot(
    subtract(cap.center, cylinder.origin),
    cylinder.axis
  );
  const isBottom =
    Math.abs(capAxialPosition - cylinder.axialMin) <= linearTolerance;
  const isTop =
    Math.abs(capAxialPosition - cylinder.axialMax) <= linearTolerance;
  if (isBottom === isTop) {
    return null;
  }

  let axialMin = cylinder.axialMin;
  let axialMax = cylinder.axialMax;
  if (isBottom) {
    axialMin -= offset;
  } else {
    axialMax += offset;
  }
  const height = axialMax - axialMin;
  if (height <= GEOMETRY_EPSILON) {
    return null;
  }

  const base = {
    x: cylinder.origin.x + cylinder.axis.x * axialMin,
    y: cylinder.origin.y + cylinder.axis.y * axialMin,
    z: cylinder.origin.z + cylinder.axis.z * axialMin
  };
  const local = kernel.makeCylinder(cylinder.radius, height);
  return kernel.copyAndTransformSolid(
    local,
    coordinateFrameMatrix(base, cylinder.axis)
  );
}

/**
 * Preserve analytic cylinder walls for the common hollow-part operation.
 * Remus's generic boolean currently falls back to a triangular B-rep when a
 * smaller coaxial cylinder opens exactly onto either cap. Revolving the exact
 * radial section is the equivalent CSG result, but keeps true cylindrical
 * surfaces in the document and exported STEP file.
 */
export function tryExactCoaxialCylinderCut(
  kernel: RemusKernel,
  targetSolid: number,
  toolSolid: number
): number | null {
  const target = readAnalyticCylinder(kernel, targetSolid);
  const tool = readAnalyticCylinder(kernel, toolSolid);
  if (!target || !tool) {
    return null;
  }

  const alignment = dot(target.axis, tool.axis);
  if (Math.abs(Math.abs(alignment) - 1) > ANALYTIC_MATCH_EPSILON) {
    return null;
  }

  const offset = subtract(tool.origin, target.origin);
  const axialOffset = dot(offset, target.axis);
  const perpendicularOffset = subtract(offset, scale(target.axis, axialOffset));
  const span = Math.max(
    1,
    target.radius,
    tool.radius,
    target.axialMax - target.axialMin,
    tool.axialMax - tool.axialMin
  );
  const tolerance = ANALYTIC_MATCH_EPSILON * span;
  if (
    length(perpendicularOffset) > tolerance ||
    tool.radius >= target.radius - tolerance
  ) {
    return null;
  }

  const toolA = axialOffset + alignment * tool.axialMin;
  const toolB = axialOffset + alignment * tool.axialMax;
  const toolMin = Math.min(toolA, toolB);
  const toolMax = Math.max(toolA, toolB);
  const cutMin = Math.max(target.axialMin, toolMin);
  const cutMax = Math.min(target.axialMax, toolMax);
  if (cutMax - cutMin <= tolerance) {
    return null;
  }

  const opensBottom = toolMin <= target.axialMin + tolerance;
  const opensTop = toolMax >= target.axialMax - tolerance;
  if (!opensBottom && !opensTop) {
    // A fully enclosed tool is already handled analytically by Remus as an
    // inner shell. Only the cap-opening cases need this construction.
    return null;
  }

  const inner = tool.radius;
  const outer = target.radius;
  let profile: Vec2[];
  if (opensBottom && opensTop) {
    profile = [
      { x: inner, y: target.axialMin },
      { x: outer, y: target.axialMin },
      { x: outer, y: target.axialMax },
      { x: inner, y: target.axialMax }
    ];
  } else if (opensTop) {
    profile = [
      { x: 0, y: target.axialMin },
      { x: outer, y: target.axialMin },
      { x: outer, y: target.axialMax },
      { x: inner, y: target.axialMax },
      { x: inner, y: cutMin },
      { x: 0, y: cutMin }
    ];
  } else {
    profile = [
      { x: inner, y: target.axialMin },
      { x: outer, y: target.axialMin },
      { x: outer, y: target.axialMax },
      { x: 0, y: target.axialMax },
      { x: 0, y: cutMax },
      { x: inner, y: cutMax }
    ];
  }

  return revolveRadialProfile(kernel, profile, target);
}

/** Solid cylinder between two world points, optionally extended past both. */
export function cylinderAlongAxis(
  kernel: RemusKernel,
  start: Vec3,
  end: Vec3,
  radius: number,
  extension = 0
): number {
  const vector = subtract(end, start);
  const axis = normalized(vector);
  const axialLength = length(vector);
  if (!axis || axialLength <= GEOMETRY_EPSILON) {
    throw new Error('Cylindrical feature has a degenerate axis.');
  }
  const origin = subtract(start, scale(axis, extension));
  const local = kernel.makeCylinder(radius, axialLength + extension * 2);
  return kernel.copyAndTransformSolid(
    local,
    coordinateFrameMatrix(origin, axis)
  );
}

/**
 * Close exactly the selected through-hole span by fusing a plug of the bore's
 * own radius and merging the seams the fuse leaves behind.
 *
 * Remus's boolean drops to a co-refined mesh when its general face assembly
 * will not accept the result, and closing a hole — collapsing a handle in the
 * body — is a configuration it declines often enough to matter. A mesh result
 * still encloses roughly the right space, so it is caught by counting faces
 * instead of measuring volume: a real fill deletes the bore and merges its two
 * openings back into their host faces, while the mesh fallback replaces every
 * analytic surface with a fan of triangles and multiplies the face count.
 */
export function fillThroughHole(
  kernel: RemusKernel,
  solid: number,
  geometry: ThroughHoleGeometry
): number {
  const facesBefore = kernel.getSolidFaces(solid).length;
  const filler = cylinderAlongAxis(
    kernel,
    geometry.axisStart,
    geometry.axisEnd,
    geometry.radius
  );
  let filled: number;
  try {
    filled = kernel.fuse(solid, filler);
  } catch (error) {
    throw new Error(
      `Filling the through-hole failed: ${
        error instanceof Error ? error.message : 'the kernel rejected the fuse'
      }.`,
      { cause: error }
    );
  }
  kernel.unifyFaces(filled);
  if (kernel.validateSolid(filled) !== 0) {
    throw new Error('Filling the through-hole did not produce a valid solid.');
  }
  if (kernel.getSolidFaces(filled).length >= facesBefore) {
    throw new Error(
      "Filling the through-hole fell back to a faceted mesh boolean, which would replace the body's exact surfaces with triangles."
    );
  }
  return filled;
}

export interface HoleToolSpec {
  /** Point on the entry face where the hole axis crosses it. */
  surfacePoint: Vec3;
  /** Unit drilling direction, INTO the body. */
  axis: Vec3;
  radius: number;
  /** Axial bore length from the surface; through-holes span the whole body. */
  depth: number;
  style: 'simple' | 'counterbore' | 'countersink';
  counterboreRadius?: number;
  counterboreDepth?: number;
  countersinkRadius?: number;
  /** Full included countersink angle, radians. */
  countersinkAngle?: number;
  /**
   * How far the tool overshoots the entry surface (and, for through-holes,
   * the exit) so a bore through a face that is not perfectly flat to the
   * tool still cuts cleanly. Zero on the exit side keeps a blind floor exact.
   */
  entryExtension: number;
  exitExtension: number;
}

/**
 * Cuts one hole — simple, counterbore, or countersink — as a compound cut of
 * analytic tool solids, then proves the result: still a valid solid, material
 * actually removed but not all of it, no mesh-boolean face explosion, and the
 * requested bores read back as analytic cylinders at their radii. Every
 * failure is a thrown message for the feature's warning, never a silent
 * approximation.
 */
export function drillHole(
  kernel: RemusKernel,
  solid: number,
  spec: HoleToolSpec
): number {
  const facesBefore = kernel.getSolidFaces(solid).length;
  const volumeBefore = kernel.volume(solid, HOLE_PROOF_DEFLECTION);
  const start = subtract(
    spec.surfacePoint,
    scale(spec.axis, spec.entryExtension)
  );
  const boreEnd = {
    x: spec.surfacePoint.x + spec.axis.x * (spec.depth + spec.exitExtension),
    y: spec.surfacePoint.y + spec.axis.y * (spec.depth + spec.exitExtension),
    z: spec.surfacePoint.z + spec.axis.z * (spec.depth + spec.exitExtension)
  };
  const tools = [cylinderAlongAxis(kernel, start, boreEnd, spec.radius)];
  if (spec.style === 'counterbore') {
    if (
      spec.counterboreRadius === undefined ||
      spec.counterboreDepth === undefined
    ) {
      throw new Error('A counterbore needs its diameter and depth.');
    }
    const counterboreEnd = {
      x: spec.surfacePoint.x + spec.axis.x * spec.counterboreDepth,
      y: spec.surfacePoint.y + spec.axis.y * spec.counterboreDepth,
      z: spec.surfacePoint.z + spec.axis.z * spec.counterboreDepth
    };
    tools.push(
      cylinderAlongAxis(kernel, start, counterboreEnd, spec.counterboreRadius)
    );
  } else if (spec.style === 'countersink') {
    if (
      spec.countersinkRadius === undefined ||
      spec.countersinkAngle === undefined
    ) {
      throw new Error('A countersink needs its diameter and angle.');
    }
    const halfTangent = Math.tan(spec.countersinkAngle / 2);
    if (!(halfTangent > GEOMETRY_EPSILON)) {
      throw new Error('Countersink angle must be strictly between 0 and 180°.');
    }
    const sinkDepth = (spec.countersinkRadius - spec.radius) / halfTangent;
    if (!(sinkDepth > GEOMETRY_EPSILON)) {
      throw new Error(
        'Countersink diameter must be larger than the hole diameter.'
      );
    }
    // The cone keeps its own taper through the entry overshoot, so the
    // countersink meets the surface at exactly the requested diameter.
    const entryRadius =
      spec.countersinkRadius + spec.entryExtension * halfTangent;
    const cone = kernel.makeCone(
      entryRadius,
      spec.radius,
      spec.entryExtension + sinkDepth
    );
    tools.push(
      kernel.copyAndTransformSolid(cone, coordinateFrameMatrix(start, spec.axis))
    );
  }

  const cut = kernel.compoundCut(solid, Uint32Array.from(tools));
  kernel.unifyFaces(cut);
  if (kernel.validateSolid(cut) !== 0) {
    throw new Error('The hole cut did not produce a valid solid.');
  }
  const volumeAfter = kernel.volume(cut, HOLE_PROOF_DEFLECTION);
  if (!(volumeAfter < volumeBefore - GEOMETRY_EPSILON)) {
    throw new Error('The hole removed no material — it misses the body.');
  }
  if (!(volumeAfter > GEOMETRY_EPSILON)) {
    throw new Error('The hole removed the whole body.');
  }
  // A mesh-boolean fallback replaces a handful of analytic faces with
  // hundreds of triangles; a real hole adds at most a few faces per style.
  if (kernel.getSolidFaces(cut).length > facesBefore + 8) {
    throw new Error(
      'The hole cut fell back to a faceted mesh boolean, which would replace exact surfaces with triangles.'
    );
  }
  const bores = coaxialCylinderRadii(
    kernel,
    cut,
    spec.surfacePoint,
    spec.axis,
    ANALYTIC_MATCH_EPSILON
  );
  const expected = [spec.radius];
  if (spec.style === 'counterbore' && spec.counterboreRadius !== undefined) {
    expected.push(spec.counterboreRadius);
  }
  for (const radius of expected) {
    if (
      !bores.some(
        (bore) => Math.abs(bore - radius) <= ANALYTIC_MATCH_EPSILON * radius
      )
    ) {
      throw new Error(
        `The hole's ${radius * 2} bore did not come back as an analytic cylinder.`
      );
    }
  }
  return cut;
}

/** Matches the adapter's measurement tessellation for volume proofs. */
const HOLE_PROOF_DEFLECTION = 0.08;

/** Radii of every analytic cylinder in `solid` sharing the given axis line. */
export function coaxialCylinderRadii(
  kernel: RemusKernel,
  solid: number,
  axisPoint: Vec3,
  axisDirection: Vec3,
  tolerance: number
): number[] {
  return Array.from(kernel.getSolidFaces(solid)).flatMap((handle) => {
    const measured = measureFaceGeometry(kernel, handle);
    if (
      measured?.surfaceType !== 'cylinder' ||
      measured.radius === undefined ||
      !measured.axisStart
    ) {
      return [];
    }
    const toAxis = subtract(measured.axisStart, axisPoint);
    const along = dot(toAxis, axisDirection);
    return length(subtract(toAxis, scale(axisDirection, along))) <= tolerance
      ? [measured.radius]
      : [];
  });
}
