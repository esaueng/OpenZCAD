import {
  GEOMETRY_LINEAR_TOLERANCE,
  GEOMETRY_RELATIVE_TOLERANCE,
  geometryTolerance
} from './tolerance';
import { boundedPolygonSides } from './regions';
import type {
  CanonicalPlaneBasisRevision,
  ParamValue,
  PlaneId,
  SketchPlaneRef
} from '@openzcad/shared';

export {
  GEOMETRY_LINEAR_TOLERANCE,
  GEOMETRY_RELATIVE_TOLERANCE,
  geometryTolerance,
  isNearlyZero
} from './tolerance';
export {
  computeSketchProfileAnalysis,
  computeSketchRegions,
  boundedArcSweepDegrees,
  boundedPolygonSides,
  mergeAdjacentProfiles,
  profileBoundarySignatures,
  profileContainsPoint,
  profilesShareBoundary,
  regionAtPoint,
  regionFingerprintOf,
  regionLoopSignedArea,
  type BezierControlPoints,
  type BezierRegionCurve,
  type RegionCurve,
  type RegionLoop,
  type SketchProfile,
  type SketchProfileAnalysis,
  type SketchProfileAnalysisOptions,
  type SketchProfileDiagnostic,
  type SketchProfileSource,
  type SketchRegion,
  type SketchRegionObject,
  type Vec2Like
} from './regions';
export {
  DEFAULT_FONT_FAMILY_ID,
  DEFAULT_FONT_STYLE,
  DEFAULT_LINE_HEIGHT,
  FONT_ASSET_BASE,
  FONT_FAMILIES,
  TextGeometryError,
  buildTextProfileSet,
  clearTextProfileCache,
  findFontFace,
  findFontFamily,
  flattenLoop,
  fontAssetUrl,
  layoutText,
  localPolygonUnion2d,
  loopSignedArea,
  orientLoop,
  resolveFontStyle,
  setTextFontProvider,
  textDisplayLoops,
  textFontProvider,
  textProfileSet,
  textProfilesFromFont,
  textSketchProfiles,
  type FontDataSource,
  type FontFaceAsset,
  type FontFamilyEntry,
  type FontLibraryOptions,
  type FontLicense,
  type FontStyle,
  type LoadedFont,
  type PlacedGlyph,
  type PolygonUnion2d,
  type TextAlign,
  type TextBoundingBox,
  type TextFontProvider,
  type TextLayout,
  type TextLoop,
  type TextObjectParameters,
  type TextPoint,
  type TextProfileOptions,
  type TextProfileSet,
  type TextRegion,
  type TextRequest,
  type TextSegment,
  type TextWinding
} from './text';

/**
 * Document-side geometry.
 *
 * OpenZCAD models with one exact B-rep kernel; solids, booleans and sweeps all
 * live inside it. What remains here is the geometry the *document* owns and the
 * kernel consumes: sketch-plane frames, closed 2D profiles, sketch regions,
 * shared tolerances, and the mesh welding used to check imported triangle soup.
 * Nothing in this package constructs or modifies a solid body.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A welded triangle mesh with shared vertices, used to inspect imported mesh
 * data (closure, orientation, enclosed volume) before it reaches a kernel.
 * Faces are index loops into `vertices`.
 */
export interface Solid {
  vertices: Vec3[];
  faces: number[][];
}

/** Default tessellation density for circular profiles. */
export const CIRCLE_SEGMENTS = 48;

export class GeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeometryError';
  }
}

function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function crossProduct(a: Vec3, b: Vec3): Vec3 {
  return vec(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x
  );
}

function dotProduct(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function requirePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new GeometryError(`${label} must be a positive number.`);
  }
  return value;
}

function clampSegments(
  value: number,
  minimum: number,
  maximum: number
): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Sketch planes and 2D profiles.
// ---------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

export interface PlaneBasis {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  normal: Vec3;
}

/**
 * Sketch-plane frames. Bases are right-handed (u × v = normal) so an extrude
 * along +normal of a counter-clockwise profile yields outward-facing walls.
 */
export const PLANE_BASES: Record<'XY' | 'XZ' | 'YZ', PlaneBasis> = {
  XY: {
    origin: vec(0, 0, 0),
    u: vec(1, 0, 0),
    v: vec(0, 1, 0),
    normal: vec(0, 0, 1)
  },
  XZ: {
    origin: vec(0, 0, 0),
    u: vec(1, 0, 0),
    v: vec(0, 0, -1),
    normal: vec(0, 1, 0)
  },
  YZ: {
    origin: vec(0, 0, 0),
    u: vec(0, 1, 0),
    v: vec(0, 0, 1),
    normal: vec(1, 0, 0)
  }
};

/**
 * Revision 2 of the XZ basis: the same plane, turned to face the Front view
 * (which looks along +Y from -Y). Revision 1's XZ has its normal on +Y, so a
 * sketch entered head-on views it from behind the model, where +u runs left
 * and +v runs down and text reads upside down; no camera roll fixes that
 * without turning the model upside down. Here u × v = normal still holds, so
 * a counter-clockwise profile still extrudes outward, toward the viewer, as
 * it does on XY and YZ. See {@link canonicalPlaneBasis}.
 */
export const FRONT_FACING_XZ_BASIS: PlaneBasis = {
  origin: vec(0, 0, 0),
  u: vec(1, 0, 0),
  v: vec(0, 0, 1),
  normal: vec(0, -1, 0)
};

/** The revision new sketches on a canonical plane are written with. */
export const CURRENT_CANONICAL_BASIS_REVISION: CanonicalPlaneBasisRevision = 2;

/**
 * The basis a canonical plane resolves to under a basis revision; absent is
 * revision 1, {@link PLANE_BASES}. Only XZ differs between revisions.
 */
export function canonicalPlaneBasis(
  plane: PlaneId,
  revision?: CanonicalPlaneBasisRevision
): PlaneBasis {
  return plane === 'XZ' && revision === 2
    ? FRONT_FACING_XZ_BASIS
    : PLANE_BASES[plane];
}

/**
 * The plane reference a new sketch on a canonical plane is written with. It
 * carries the current basis revision only where that changes the basis, so
 * XY and YZ refs stay byte-identical to the ones written before revisions.
 */
export function newCanonicalPlaneRef(
  plane: PlaneId,
  offset: ParamValue
): Extract<SketchPlaneRef, { type: 'canonical' }> {
  const basisRevision = CURRENT_CANONICAL_BASIS_REVISION;
  return canonicalPlaneBasis(plane, basisRevision) === PLANE_BASES[plane]
    ? { type: 'canonical', plane, offset }
    : { type: 'canonical', plane, offset, basisRevision };
}

/**
 * Authoring only: preserve a saved basis on the same plane, use the current
 * basis when changing planes. Historical command replay keeps its stored ref.
 */
export function canonicalPlaneRefForEdit(
  previous: SketchPlaneRef,
  plane: PlaneId,
  offset: ParamValue
): Extract<SketchPlaneRef, { type: 'canonical' }> {
  return previous.type === 'canonical' && previous.plane === plane
    ? { ...previous, offset }
    : newCanonicalPlaneRef(plane, offset);
}

/**
 * Pure construction rules for R01 datum planes. Both the production kernel
 * build and the parity reference resolve source frames first and then call
 * these, so a datum means the same plane wherever it is rebuilt.
 *
 * Frames are right-handed: u × v = normal. They live in this barrel rather
 * than a module of their own: the bundler placed a separate module in the
 * worker's exact chunk, and this barrel's re-export then made every geometry
 * import load that chunk (and its mesh-payload split) eagerly.
 */

type DatumVector = PlaneBasis['origin'];

const datumAdd = (a: DatumVector, b: DatumVector): DatumVector => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z
});
const datumSub = (a: DatumVector, b: DatumVector): DatumVector => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});
const datumScale = (a: DatumVector, s: number): DatumVector => ({
  x: a.x * s,
  y: a.y * s,
  z: a.z * s
});
const datumDot = (a: DatumVector, b: DatumVector): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;
const datumCross = (a: DatumVector, b: DatumVector): DatumVector => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const datumLength = (a: DatumVector): number => Math.sqrt(datumDot(a, a));

function requireFrame(frame: PlaneBasis, role: string): void {
  const values = [frame.origin, frame.u, frame.v, frame.normal].flatMap(
    (vector) => [vector.x, vector.y, vector.z]
  );
  if (!values.every(Number.isFinite)) {
    throw new Error(`The ${role} plane has a non-finite frame.`);
  }
  if (Math.abs(datumLength(frame.normal) - 1) > 1e-9) {
    throw new Error(`The ${role} plane has no unit normal.`);
  }
}

/** Reverses the result normal and v, keeping the origin and a right-handed frame. */
function flipped(frame: PlaneBasis): PlaneBasis {
  return {
    origin: frame.origin,
    u: frame.u,
    v: datumScale(frame.v, -1),
    normal: datumScale(frame.normal, -1)
  };
}

/**
 * The source plane moved `offset` along its own normal: positive follows the
 * visible source normal, zero is the source itself. `reverseNormal` flips the
 * result's orientation without moving it.
 */
export function offsetDatumPlane(
  source: PlaneBasis,
  offset: number,
  reverseNormal = false
): PlaneBasis {
  requireFrame(source, 'source');
  if (!Number.isFinite(offset)) {
    throw new Error('The plane offset must be a finite distance.');
  }
  const frame: PlaneBasis = {
    origin: datumAdd(source.origin, datumScale(source.normal, offset)),
    u: source.u,
    v: source.v,
    normal: source.normal
  };
  return reverseNormal ? flipped(frame) : frame;
}

/**
 * The plane halfway between two parallel planes A and B (normals may oppose),
 * keeping A's in-plane origin and axes so that sliding B along itself does
 * not move the result. Nonparallel or coincident sources are refused; no
 * angular bisector is guessed.
 */
export function midDatumPlane(
  a: PlaneBasis,
  b: PlaneBasis,
  reverseNormal = false
): PlaneBasis {
  requireFrame(a, 'first');
  requireFrame(b, 'second');
  if (
    datumLength(datumCross(a.normal, b.normal)) > GEOMETRY_RELATIVE_TOLERANCE
  ) {
    throw new Error(
      'A midplane needs two parallel planes; these are not parallel.'
    );
  }
  const separation = datumDot(datumSub(b.origin, a.origin), a.normal);
  if (
    Math.abs(separation) <=
    geometryTolerance(Math.max(datumLength(a.origin), datumLength(b.origin)))
  ) {
    throw new Error('A midplane needs two separate planes; these coincide.');
  }
  const frame: PlaneBasis = {
    origin: datumAdd(a.origin, datumScale(a.normal, separation / 2)),
    u: a.u,
    v: a.v,
    normal: a.normal
  };
  return reverseNormal ? flipped(frame) : frame;
}

function requirePoint(point: DatumVector, role: string): void {
  if (![point.x, point.y, point.z].every(Number.isFinite)) {
    throw new Error(`The ${role} point is not a finite position.`);
  }
}

const POINT_ROLES = ['first', 'second', 'third'] as const;

/**
 * The plane through three points: the origin is the first, u points at the
 * second, and the normal follows the right-hand rule (first → second →
 * third), so counter-clockwise points seen from above give +Z. Two points
 * closer than the linear tolerance, or a third point within it of the line
 * through the other two, are refused; no plane is guessed.
 */
export function threePointDatumPlane(
  first: DatumVector,
  second: DatumVector,
  third: DatumVector,
  reverseNormal = false
): PlaneBasis {
  const points = [first, second, third];
  points.forEach((point, index) => requirePoint(point, POINT_ROLES[index]!));
  // Scaled by the triangle, not its distance from the origin, so moving the
  // same points elsewhere neither refuses nor accepts them; floored at the
  // rounding noise the coordinates themselves carry far from the origin.
  const span = Math.max(
    datumLength(datumSub(second, first)),
    datumLength(datumSub(third, first)),
    datumLength(datumSub(third, second))
  );
  const magnitude = Math.max(...points.map((point) => datumLength(point)));
  const tolerance = Math.max(
    geometryTolerance(span),
    magnitude * 8 * Number.EPSILON
  );
  for (const [a, b] of [
    [0, 1],
    [0, 2],
    [1, 2]
  ] as const) {
    if (datumLength(datumSub(points[b]!, points[a]!)) <= tolerance) {
      throw new Error(
        `A three-point plane needs three separate points; the ${POINT_ROLES[a]} and ${POINT_ROLES[b]} coincide.`
      );
    }
  }
  const along = datumSub(second, first);
  const across = datumSub(third, first);
  const normal = datumCross(along, across);
  // The third point's distance from the line through the first two.
  if (datumLength(normal) / datumLength(along) <= tolerance) {
    throw new Error(
      'A three-point plane needs points that are not in a line; these are collinear.'
    );
  }
  const unitNormal = datumScale(normal, 1 / datumLength(normal));
  const u = datumScale(along, 1 / datumLength(along));
  const frame: PlaneBasis = {
    origin: first,
    u,
    v: datumCross(unitNormal, u),
    normal: unitNormal
  };
  return reverseNormal ? flipped(frame) : frame;
}

/**
 * The plane parallel to `source` through `point`, keeping the source's axes
 * and normal: the source slid along its normal until it meets the point,
 * with the origin on the point. A point already on the source gives the
 * source plane itself, which is valid (as a zero offset is).
 */
export function parallelDatumPlane(
  source: PlaneBasis,
  point: DatumVector,
  reverseNormal = false
): PlaneBasis {
  requireFrame(source, 'source');
  requirePoint(point, 'through');
  const frame: PlaneBasis = {
    origin: point,
    u: source.u,
    v: source.v,
    normal: source.normal
  };
  return reverseNormal ? flipped(frame) : frame;
}

/** A resolved datum axis: a point on the line and its unit direction. */
export interface DatumAxis {
  origin: DatumVector;
  direction: DatumVector;
}

function axisResult(
  origin: DatumVector,
  direction: DatumVector,
  reverseDirection: boolean
): DatumAxis {
  const unit = datumScale(direction, 1 / datumLength(direction));
  return {
    origin,
    direction: reverseDirection ? datumScale(unit, -1) : unit
  };
}

/**
 * The axis from the first point toward the second, with its origin on the
 * first. Points closer than the linear tolerance (scaled as a three-point
 * plane's are) are refused: they name no direction.
 */
export function twoPointDatumAxis(
  first: DatumVector,
  second: DatumVector,
  reverseDirection = false
): DatumAxis {
  requirePoint(first, 'first');
  requirePoint(second, 'second');
  const along = datumSub(second, first);
  const magnitude = Math.max(datumLength(first), datumLength(second));
  const tolerance = Math.max(
    geometryTolerance(datumLength(along)),
    magnitude * 8 * Number.EPSILON
  );
  if (datumLength(along) <= tolerance) {
    throw new Error(
      'An axis through two points needs two separate points; these coincide.'
    );
  }
  return axisResult(first, along, reverseDirection);
}

/**
 * The axis along a straight edge, from its end 0 toward its end 1. The
 * caller has already checked that the edge is a line; a zero-length one is
 * refused like coincident points.
 */
export function edgeDatumAxis(
  start: DatumVector,
  end: DatumVector,
  reverseDirection = false
): DatumAxis {
  requirePoint(start, 'edge start');
  requirePoint(end, 'edge end');
  const along = datumSub(end, start);
  if (datumLength(along) <= geometryTolerance(datumLength(start))) {
    throw new Error('An axis along an edge needs an edge of non-zero length.');
  }
  return axisResult(start, along, reverseDirection);
}

/**
 * Components at or below this are treated as zero when choosing a surface
 * axis's canonical sense: the ADR-011 direction quantum, so float noise on a
 * near-axis-aligned direction cannot pick a different sign in either kernel.
 */
const AXIS_SENSE_QUANTUM = 1e-6;

/**
 * A surface axis (cylinder or cone) has no preferred sense, and two kernels
 * may report it either way round, so it is made canonical: the first
 * component beyond the direction quantum is positive.
 */
export function canonicalAxisDirection(direction: DatumVector): DatumVector {
  const length = datumLength(direction);
  if (!(length > 0) || !Number.isFinite(length)) {
    throw new Error('The surface axis has no direction.');
  }
  const unit = datumScale(direction, 1 / length);
  for (const component of [unit.x, unit.y, unit.z]) {
    if (Math.abs(component) > AXIS_SENSE_QUANTUM) {
      return component < 0 ? datumScale(unit, -1) : unit;
    }
  }
  return unit;
}

/**
 * The axis of a cylindrical or conical face through `origin` (the middle of
 * a cylinder's axial span, or a cone's apex), in its canonical sense.
 */
export function surfaceDatumAxis(
  origin: DatumVector,
  direction: DatumVector,
  reverseDirection = false
): DatumAxis {
  requirePoint(origin, 'axis');
  return axisResult(
    origin,
    canonicalAxisDirection(direction),
    reverseDirection
  );
}

/**
 * The line where planes A and B meet, running along nA × nB with its origin
 * at the point of the line nearest A's origin. Parallel planes (antiparallel
 * included) are refused with the midplane's parallelism tolerance, on both
 * sides of which the result is tested: there is no line to guess.
 */
export function planeIntersectionDatumAxis(
  a: PlaneBasis,
  b: PlaneBasis,
  reverseDirection = false
): DatumAxis {
  requireFrame(a, 'first');
  requireFrame(b, 'second');
  const direction = datumCross(a.normal, b.normal);
  if (datumLength(direction) <= GEOMETRY_RELATIVE_TOLERANCE) {
    throw new Error(
      'An axis where two planes meet needs planes that are not parallel; these are parallel.'
    );
  }
  // Step from A's origin within plane A, perpendicular to the line, until
  // plane B is reached: that point is the line's nearest to A's origin.
  const within = datumCross(direction, a.normal);
  const step =
    (datumDot(b.normal, b.origin) - datumDot(b.normal, a.origin)) /
    datumDot(b.normal, within);
  return axisResult(
    datumAdd(a.origin, datumScale(within, step)),
    direction,
    reverseDirection
  );
}

/** Largest |axis · sketch normal| a revolve axis may have (small-angle radians). */
const REVOLVE_AXIS_TILT_TOLERANCE = 1e-9;

/**
 * R01: a revolve turns its profile about an axis in the profile's own plane.
 * A datum axis that tilts out of the sketch plane, or runs parallel to it
 * off the plane, is refused by name rather than projected onto it.
 */
export function requireRevolveAxisInPlane(
  axis: DatumAxis,
  basis: PlaneBasis,
  sketchName: string
): void {
  const tilt = Math.abs(datumDot(axis.direction, basis.normal));
  const offset = Math.abs(
    datumDot(datumSub(axis.origin, basis.origin), basis.normal)
  );
  const scale = Math.max(datumLength(axis.origin), datumLength(basis.origin));
  if (tilt > REVOLVE_AXIS_TILT_TOLERANCE || offset > geometryTolerance(scale)) {
    throw new Error(
      `The datum axis does not lie in the plane of sketch "${sketchName}"; a revolve needs an axis in its profile's plane.`
    );
  }
}

/**
 * The row-major 3×4 rigid transform turning `angleDeg` degrees about the
 * line through `origin` along unit `direction`, right-handed (Rodrigues).
 * Points on the line stay fixed.
 */
export function axisRotationMatrix(
  axis: DatumAxis,
  angleDeg: number
): number[] {
  const { x, y, z } = axis.direction;
  const angle = (angleDeg * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const r = [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c]
  ] as const;
  const o = axis.origin;
  const shift = (row: readonly [number, number, number], p: number) =>
    p - (row[0] * o.x + row[1] * o.y + row[2] * o.z);
  return [
    ...r[0],
    shift(r[0], o.x),
    ...r[1],
    shift(r[1], o.y),
    ...r[2],
    shift(r[2], o.z)
  ];
}

/**
 * Resolves a sketch plane reference to a concrete basis. This is the single
 * shared resolution path — the kernel adapter and the viewport must agree on
 * where a sketch plane sits. Canonical refs carry a parametric offset, so the
 * caller supplies the evaluator; frame and face refs embed a fully resolved
 * frame snapshot.
 */
export function frameForPlaneRef(
  ref: SketchPlaneRef,
  resolveOffset: (value: ParamValue) => number
): PlaneBasis {
  if (ref.type === 'canonical') {
    const base = canonicalPlaneBasis(ref.plane, ref.basisRevision);
    const offset = resolveOffset(ref.offset);
    return {
      origin: vec(
        base.origin.x + base.normal.x * offset,
        base.origin.y + base.normal.y * offset,
        base.origin.z + base.normal.z * offset
      ),
      u: base.u,
      v: base.v,
      normal: base.normal
    };
  }
  if (ref.type === 'datum') {
    // A datum resolves once, at its own history position, in the exact
    // build; nothing here can re-derive it without that context.
    throw new Error(
      'A datum-attached plane resolves in the exact build, not from its reference alone.'
    );
  }
  const frame = ref.frame;
  return {
    origin: vec(frame.origin.x, frame.origin.y, frame.origin.z),
    u: vec(frame.xAxis.x, frame.xAxis.y, frame.xAxis.z),
    v: vec(frame.yAxis.x, frame.yAxis.y, frame.yAxis.z),
    normal: vec(frame.zAxis.x, frame.zAxis.y, frame.zAxis.z)
  };
}

export function rectangleProfile(
  width: number,
  height: number,
  centerX = 0,
  centerY = 0
): Vec2[] {
  requirePositive(width, 'Rectangle width');
  requirePositive(height, 'Rectangle height');
  const x = width / 2;
  const y = height / 2;
  return [
    { x: centerX - x, y: centerY - y },
    { x: centerX + x, y: centerY - y },
    { x: centerX + x, y: centerY + y },
    { x: centerX - x, y: centerY + y }
  ];
}

export function circleProfile(
  radius: number,
  centerX = 0,
  centerY = 0,
  segments = CIRCLE_SEGMENTS
): Vec2[] {
  requirePositive(radius, 'Circle radius');
  const n = clampSegments(segments, 8, 128);
  const points: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    points.push({
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    });
  }
  return points;
}

export function polygonProfile(
  sides: number,
  radius: number,
  centerX = 0,
  centerY = 0
): Vec2[] {
  requirePositive(radius, 'Polygon radius');
  const n = boundedPolygonSides(sides);
  const points: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    // Start at the top so flats sit symmetric about the vertical axis.
    const angle = (i / n) * Math.PI * 2 + Math.PI / 2;
    points.push({
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Mesh welding and inspection.
// ---------------------------------------------------------------------------

function weldKey(p: Vec3): string {
  const f = (value: number) =>
    String(Math.round(value / GEOMETRY_LINEAR_TOLERANCE));
  return `${f(p.x)},${f(p.y)},${f(p.z)}`;
}

export interface SolidValidation {
  closed: boolean;
  openEdgeCount: number;
  nonManifoldEdgeCount: number;
}

/** A closed mesh uses every undirected edge exactly twice, once per direction. */
export function validateSolid(solid: Solid): SolidValidation {
  const counts = new Map<string, { forward: number; backward: number }>();
  for (const face of solid.faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]!;
      const b = face[(i + 1) % face.length]!;
      if (a === b) {
        continue;
      }
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = counts.get(key) ?? { forward: 0, backward: 0 };
      if (a < b) {
        entry.forward += 1;
      } else {
        entry.backward += 1;
      }
      counts.set(key, entry);
    }
  }
  let openEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const entry of counts.values()) {
    const total = entry.forward + entry.backward;
    if (total === 2 && entry.forward === 1 && entry.backward === 1) {
      continue;
    }
    if (total < 2) {
      openEdgeCount += 1;
    } else {
      nonManifoldEdgeCount += 1;
    }
  }
  return {
    closed: openEdgeCount === 0 && nonManifoldEdgeCount === 0,
    openEdgeCount,
    nonManifoldEdgeCount
  };
}

/** Signed enclosed volume; negative means the mesh is wound inside-out. */
export function solidVolume(solid: Solid): number {
  let volume = 0;
  for (const face of solid.faces) {
    const origin = solid.vertices[face[0]!]!;
    for (let i = 1; i < face.length - 1; i++) {
      const b = solid.vertices[face[i]!]!;
      const c = solid.vertices[face[i + 1]!]!;
      volume += dotProduct(origin, crossProduct(b, c)) / 6;
    }
  }
  return volume;
}

/** Welds raw triangle soup (e.g. an imported STL mesh) into shared vertices. */
export function solidFromTriangles(
  vertices: number[],
  indices: number[]
): Solid {
  const points: Vec3[] = [];
  const lookup = new Map<string, number>();
  const remap: number[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    const p = vec(vertices[i]!, vertices[i + 1]!, vertices[i + 2]!);
    const key = weldKey(p);
    let index = lookup.get(key);
    if (index === undefined) {
      index = points.push(p) - 1;
      lookup.set(key, index);
    }
    remap.push(index);
  }
  const faces: number[][] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = remap[indices[i]!]!;
    const b = remap[indices[i + 1]!]!;
    const c = remap[indices[i + 2]!]!;
    if (a !== b && b !== c && c !== a) {
      faces.push([a, b, c]);
    }
  }
  return { vertices: points, faces };
}
