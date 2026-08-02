import { GEOMETRY_LINEAR_TOLERANCE } from './tolerance';
import type { ParamValue, SketchPlaneRef } from '@openzcad/shared';

export {
  GEOMETRY_LINEAR_TOLERANCE,
  GEOMETRY_RELATIVE_TOLERANCE,
  geometryTolerance,
  isNearlyZero
} from './tolerance';
export {
  computeSketchProfileAnalysis,
  computeSketchRegions,
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
  FontLibrary,
  TextGeometryError,
  buildTextProfileSet,
  clearTextProfileCache,
  fetchFontDataSource,
  findFontFace,
  findFontFamily,
  flattenLoop,
  fontAssetUrl,
  layoutText,
  localPolygonUnion2d,
  loopSignedArea,
  orientLoop,
  parseFontFace,
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
    const base = PLANE_BASES[ref.plane];
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
  const n = clampSegments(sides, 3, 64);
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
