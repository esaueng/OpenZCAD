import {
  CsgPolygon,
  csgIntersect,
  csgSubtract,
  csgUnion,
  type CsgVec
} from './csg';

export type Vec3 = CsgVec;

/**
 * Boundary representation of a closed solid: shared vertices plus planar,
 * convex polygon faces whose loops wind counter-clockwise when viewed from
 * outside the solid. This is the single geometry currency of OpenZCAD — the
 * viewport triangulates it, booleans run CSG over it, and the STEP writer
 * emits it as a faceted MANIFOLD_SOLID_BREP.
 */
export interface Solid {
  vertices: Vec3[];
  faces: number[][];
}

export interface TriangleMesh {
  vertices: number[];
  indices: number[];
}

export interface Transform {
  translation: Vec3;
  rotationDeg: Vec3;
}

/** Default tessellation density for curved geometry. */
export const CIRCLE_SEGMENTS = 48;
export const SPHERE_SEGMENTS = 32;
export const SPHERE_RINGS = 16;
export const TORUS_TUBE_SEGMENTS = 24;
export const REVOLVE_SEGMENTS = 48;

const WELD_DECIMALS = 6;
const AXIS_EPSILON = 1e-6;

export class GeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeometryError';
  }
}

function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return vec(a.x - b.x, a.y - b.y, a.z - b.z);
}

function crossProduct(a: Vec3, b: Vec3): Vec3 {
  return vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
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

function clampSegments(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Primitive generators (Y is up, matching the viewport ground grid on XZ).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Primitives.
//
// This polyhedral kernel is the compatibility/preview path; the exact
// BrepKit kernel is authoritative. Every generator here therefore uses
// BrepKit's frame, because the AI preview renders with this kernel and Apply
// rebuilds with BrepKit — any disagreement means the preview shows a model the
// user is not actually agreeing to:
//
//   box            corner at the origin, spanning (0,0,0)-(width, height, depth)
//   cylinder/cone  base on z=0, axis +Z, centred in XY
//   sphere/torus   centred on the origin, torus ring in XY (axis +Z)
//
// test/kernel-conformance.test.ts pins these against the real BrepKit kernel.
// ---------------------------------------------------------------------------

/**
 * Corner at the origin, spanning (0,0,0) to (width, height, depth), matching
 * BrepKit's makeBox primitive.
 */
export function makeBox(width: number, height: number, depth: number): Solid {
  requirePositive(width, 'Box width');
  requirePositive(height, 'Box height');
  requirePositive(depth, 'Box depth');
  const x = width;
  const y = height;
  const z = depth;
  const vertices: Vec3[] = [
    vec(0, 0, 0),
    vec(x, 0, 0),
    vec(x, y, 0),
    vec(0, y, 0),
    vec(0, 0, z),
    vec(x, 0, z),
    vec(x, y, z),
    vec(0, y, z)
  ];
  const faces = [
    [0, 3, 2, 1], // -Z
    [4, 5, 6, 7], // +Z
    [0, 1, 5, 4], // -Y
    [3, 7, 6, 2], // +Y
    [0, 4, 7, 3], // -X
    [1, 2, 6, 5] // +X
  ];
  return orientOutward({ vertices, faces });
}

export function makeCylinder(
  radius: number,
  height: number,
  segments = CIRCLE_SEGMENTS
): Solid {
  return makeCone(radius, radius, height, segments);
}

/**
 * Frustum with independent bottom/top radii; a zero top radius gives a cone.
 * Base on the z=0 plane with the axis along +Z, matching BrepKit.
 */
export function makeCone(
  bottomRadius: number,
  topRadius: number,
  height: number,
  segments = CIRCLE_SEGMENTS
): Solid {
  requirePositive(bottomRadius, 'Cone bottom radius');
  requirePositive(height, 'Cone height');
  if (!Number.isFinite(topRadius) || topRadius < 0) {
    throw new GeometryError('Cone top radius must be zero or positive.');
  }
  const n = clampSegments(segments, 3, 128);
  const vertices: Vec3[] = [];
  const faces: number[][] = [];

  const bottomRing: number[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    bottomRing.push(
      vertices.push(vec(Math.cos(angle) * bottomRadius, Math.sin(angle) * bottomRadius, 0)) - 1
    );
  }

  const pointedTop = topRadius < AXIS_EPSILON;
  const topRing: number[] = [];
  if (pointedTop) {
    const apex = vertices.push(vec(0, 0, height)) - 1;
    for (let i = 0; i < n; i++) {
      topRing.push(apex);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2;
      topRing.push(
        vertices.push(vec(Math.cos(angle) * topRadius, Math.sin(angle) * topRadius, height)) - 1
      );
    }
  }

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (pointedTop) {
      faces.push([bottomRing[i]!, topRing[i]!, bottomRing[j]!]);
    } else {
      faces.push([bottomRing[i]!, topRing[i]!, topRing[j]!, bottomRing[j]!]);
    }
  }
  faces.push([...bottomRing]);
  if (!pointedTop) {
    faces.push([...topRing].reverse());
  }
  return orientOutward({ vertices, faces });
}

export function makeSphere(
  radius: number,
  segments = SPHERE_SEGMENTS,
  rings = SPHERE_RINGS
): Solid {
  requirePositive(radius, 'Sphere radius');
  const n = clampSegments(segments, 3, 96);
  const m = clampSegments(rings, 2, 64);
  const vertices: Vec3[] = [];
  const faces: number[][] = [];

  const south = vertices.push(vec(0, -radius, 0)) - 1;
  const ringStart: number[] = [];
  for (let ring = 1; ring < m; ring++) {
    const phi = (ring / m) * Math.PI - Math.PI / 2;
    const y = Math.sin(phi) * radius;
    const r = Math.cos(phi) * radius;
    ringStart.push(vertices.length);
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2;
      vertices.push(vec(Math.cos(angle) * r, y, Math.sin(angle) * r));
    }
  }
  const north = vertices.push(vec(0, radius, 0)) - 1;

  const first = ringStart[0]!;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([south, first + i, first + j]);
  }
  for (let ring = 0; ring < ringStart.length - 1; ring++) {
    const a = ringStart[ring]!;
    const b = ringStart[ring + 1]!;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push([a + i, b + i, b + j, a + j]);
    }
  }
  const last = ringStart[ringStart.length - 1]!;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([last + i, north, last + j]);
  }
  return orientOutward({ vertices, faces });
}

/** Centred on the origin with the ring in the XY plane and the axis +Z, matching BrepKit. */
export function makeTorus(
  majorRadius: number,
  minorRadius: number,
  segments = CIRCLE_SEGMENTS,
  tubeSegments = TORUS_TUBE_SEGMENTS
): Solid {
  requirePositive(majorRadius, 'Torus major radius');
  requirePositive(minorRadius, 'Torus minor radius');
  if (minorRadius >= majorRadius) {
    throw new GeometryError('Torus minor radius must be smaller than the major radius.');
  }
  const n = clampSegments(segments, 3, 128);
  const m = clampSegments(tubeSegments, 3, 64);
  const vertices: Vec3[] = [];
  const faces: number[][] = [];

  for (let i = 0; i < n; i++) {
    const u = (i / n) * Math.PI * 2;
    for (let k = 0; k < m; k++) {
      const v = (k / m) * Math.PI * 2;
      const r = majorRadius + Math.cos(v) * minorRadius;
      vertices.push(vec(Math.cos(u) * r, Math.sin(u) * r, Math.sin(v) * minorRadius));
    }
  }
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      faces.push([i * m + k, i2 * m + k, i2 * m + k2, i * m + k2]);
    }
  }
  return orientOutward({ vertices, faces });
}

// ---------------------------------------------------------------------------
// Profile sweeps (extrude / revolve).
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
    points.push({ x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius });
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
    points.push({ x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius });
  }
  return points;
}

function profileSignedArea(profile: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i]!;
    const b = profile[(i + 1) % profile.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function ensureCcw(profile: Vec2[]): Vec2[] {
  if (profile.length < 3) {
    throw new GeometryError('A profile needs at least three points.');
  }
  return profileSignedArea(profile) < 0 ? [...profile].reverse() : profile;
}

function planePoint(basis: PlaneBasis, point: Vec2, offset: number): Vec3 {
  return vec(
    basis.origin.x + basis.u.x * point.x + basis.v.x * point.y + basis.normal.x * offset,
    basis.origin.y + basis.u.y * point.x + basis.v.y * point.y + basis.normal.y * offset,
    basis.origin.z + basis.u.z * point.x + basis.v.z * point.y + basis.normal.z * offset
  );
}

/** Extrudes a convex CCW profile from `offset` to `offset + distance` along the plane normal. */
export function extrudeProfile(
  profile: Vec2[],
  basis: PlaneBasis,
  distance: number,
  offset = 0
): Solid {
  if (!Number.isFinite(distance) || Math.abs(distance) < AXIS_EPSILON) {
    throw new GeometryError('Extrude distance must be a non-zero number.');
  }
  const ccw = ensureCcw(profile);
  const n = ccw.length;
  const start = Math.min(offset, offset + distance);
  const end = Math.max(offset, offset + distance);

  const vertices: Vec3[] = [];
  for (const point of ccw) {
    vertices.push(planePoint(basis, point, start));
  }
  for (const point of ccw) {
    vertices.push(planePoint(basis, point, end));
  }

  const faces: number[][] = [];
  faces.push([...Array(n).keys()].reverse()); // bottom, faces -normal
  faces.push([...Array(n).keys()].map((i) => n + i)); // top, faces +normal
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i, j, n + j, n + i]);
  }
  return orientOutward({ vertices, faces });
}

/**
 * Revolves a convex CCW profile a full turn around one of the sketch axes
 * (`vertical` = the v axis / u = 0 line, `horizontal` = the u axis / v = 0
 * line). The profile must lie strictly on one side of that axis.
 */
export function revolveProfile(
  profile: Vec2[],
  basis: PlaneBasis,
  axis: 'horizontal' | 'vertical',
  offset = 0,
  segments = REVOLVE_SEGMENTS
): Solid {
  const ccw = ensureCcw(profile);
  const n = clampSegments(segments, 8, 128);

  // Radial coordinate for each point: distance from the revolve axis.
  const radial = ccw.map((point) => (axis === 'vertical' ? point.x : point.y));
  const along = ccw.map((point) => (axis === 'vertical' ? point.y : point.x));
  const minRadial = Math.min(...radial);
  const maxRadial = Math.max(...radial);
  if (minRadial < AXIS_EPSILON && maxRadial > -AXIS_EPSILON) {
    throw new GeometryError(
      'Revolve profile must lie entirely on one side of the revolve axis.'
    );
  }
  // Frame: axisDir is the in-plane revolve axis, radialDir the in-plane
  // perpendicular, sweepDir completes the right-handed frame out of plane.
  // At angle 0 every point reproduces its in-plane position, so the sweep
  // works for profiles on either side of the axis (orientOutward fixes the
  // winding flip a negative-side profile introduces).
  const axisDir = axis === 'vertical' ? basis.v : basis.u;
  const radialDir = axis === 'vertical' ? basis.u : basis.v;
  const sweepDir = crossProduct(axisDir, radialDir);
  const axisOrigin = vec(
    basis.origin.x + basis.normal.x * offset,
    basis.origin.y + basis.normal.y * offset,
    basis.origin.z + basis.normal.z * offset
  );

  const count = ccw.length;
  const vertices: Vec3[] = [];
  for (let s = 0; s < n; s++) {
    const angle = (s / n) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let i = 0; i < count; i++) {
      const r = radial[i]!;
      const a = along[i]!;
      vertices.push(
        vec(
          axisOrigin.x + axisDir.x * a + r * (cos * radialDir.x + sin * sweepDir.x),
          axisOrigin.y + axisDir.y * a + r * (cos * radialDir.y + sin * sweepDir.y),
          axisOrigin.z + axisDir.z * a + r * (cos * radialDir.z + sin * sweepDir.z)
        )
      );
    }
  }

  const faces: number[][] = [];
  for (let s = 0; s < n; s++) {
    const s2 = (s + 1) % n;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      faces.push([s * count + i, s * count + j, s2 * count + j, s2 * count + i]);
    }
  }
  return orientOutward({ vertices, faces });
}

// ---------------------------------------------------------------------------
// Transforms.
// ---------------------------------------------------------------------------

/**
 * M = Rz · Ry · Rx, i.e. X is applied to the vector first.
 *
 * The exact kernel rotates about X, then Y, then Z (Euler 'ZYX'), and the
 * viewport's Move gizmo composes its transform the same way, so this must too —
 * any other order silently disagrees with the applied model once more than one
 * axis is non-zero.
 */
function rotationMatrix(rotationDeg: Vec3): number[] {
  const rx = (rotationDeg.x * Math.PI) / 180;
  const ry = (rotationDeg.y * Math.PI) / 180;
  const rz = (rotationDeg.z * Math.PI) / 180;
  const ca = Math.cos(rx);
  const sa = Math.sin(rx);
  const cb = Math.cos(ry);
  const sb = Math.sin(ry);
  const cc = Math.cos(rz);
  const sc = Math.sin(rz);
  return [
    cc * cb,
    cc * sb * sa - sc * ca,
    cc * sb * ca + sc * sa,
    sc * cb,
    sc * sb * sa + cc * ca,
    sc * sb * ca - cc * sa,
    -sb,
    cb * sa,
    cb * ca
  ];
}

export function transformSolid(solid: Solid, transform: Transform): Solid {
  const { translation, rotationDeg } = transform;
  const rotate = rotationDeg.x !== 0 || rotationDeg.y !== 0 || rotationDeg.z !== 0;
  const m = rotationMatrix(rotationDeg);
  const vertices = solid.vertices.map((p) => {
    const x = rotate ? m[0]! * p.x + m[1]! * p.y + m[2]! * p.z : p.x;
    const y = rotate ? m[3]! * p.x + m[4]! * p.y + m[5]! * p.z : p.y;
    const z = rotate ? m[6]! * p.x + m[7]! * p.y + m[8]! * p.z : p.z;
    return vec(x + translation.x, y + translation.y, z + translation.z);
  });
  return { vertices, faces: solid.faces.map((face) => [...face]) };
}

export function scaleSolid(solid: Solid, factor: number): Solid {
  return {
    vertices: solid.vertices.map((p) => vec(p.x * factor, p.y * factor, p.z * factor)),
    faces: solid.faces.map((face) => [...face])
  };
}

// ---------------------------------------------------------------------------
// Booleans.
// ---------------------------------------------------------------------------

function solidToPolygons(solid: Solid): CsgPolygon[] {
  const polygons: CsgPolygon[] = [];
  for (const face of solid.faces) {
    const points = face.map((index) => ({ ...solid.vertices[index]! }));
    try {
      polygons.push(new CsgPolygon(points));
    } catch {
      // Skip degenerate faces; they contribute no geometry.
    }
  }
  return polygons;
}

function weldKey(p: Vec3): string {
  const f = (value: number) => {
    const rounded = value.toFixed(WELD_DECIMALS);
    return rounded === `-0.${'0'.repeat(WELD_DECIMALS)}` ? `0.${'0'.repeat(WELD_DECIMALS)}` : rounded;
  };
  return `${f(p.x)},${f(p.y)},${f(p.z)}`;
}

function polygonsToSolid(polygons: CsgPolygon[]): Solid {
  const vertices: Vec3[] = [];
  const lookup = new Map<string, number>();
  const faces: number[][] = [];

  for (const polygon of polygons) {
    const loop: number[] = [];
    for (const point of polygon.vertices) {
      const key = weldKey(point);
      let index = lookup.get(key);
      if (index === undefined) {
        index = vertices.push({ ...point }) - 1;
        lookup.set(key, index);
      }
      // Welding can collapse consecutive points; keep the loop simple.
      if (loop.length === 0 || (loop[loop.length - 1] !== index && loop[0] !== index)) {
        loop.push(index);
      } else if (loop[0] === index && loop.length >= 3) {
        break;
      }
    }
    if (loop.length >= 3) {
      faces.push(loop);
    }
  }
  return { vertices, faces };
}

export function booleanSolids(
  operation: 'union' | 'subtract' | 'intersect',
  a: Solid,
  b: Solid
): Solid {
  const left = solidToPolygons(a);
  const right = solidToPolygons(b);
  const combined =
    operation === 'union'
      ? csgUnion(left, right)
      : operation === 'subtract'
        ? csgSubtract(left, right)
        : csgIntersect(left, right);
  return healTJunctions(polygonsToSolid(combined));
}

// ---------------------------------------------------------------------------
// Healing, validation, measurement, triangulation.
// ---------------------------------------------------------------------------

const HEAL_VERTEX_LIMIT = 20000;
const ON_EDGE_TOLERANCE = 1e-5;

/**
 * BSP clipping can leave T-junctions: a vertex of one face lying in the
 * middle of a neighboring face's edge. Splitting those edges restores the
 * shared-edge topology that watertightness checks and STEP topology rely on.
 */
export function healTJunctions(solid: Solid): Solid {
  if (solid.vertices.length > HEAL_VERTEX_LIMIT) {
    return solid;
  }
  const { vertices } = solid;
  const faces = solid.faces.map((face) => {
    const result: number[] = [];
    for (let i = 0; i < face.length; i++) {
      const aIndex = face[i]!;
      const bIndex = face[(i + 1) % face.length]!;
      result.push(aIndex);
      const a = vertices[aIndex]!;
      const b = vertices[bIndex]!;
      const ab = subtract(b, a);
      const lengthSq = dotProduct(ab, ab);
      if (lengthSq < AXIS_EPSILON * AXIS_EPSILON) {
        continue;
      }

      const inserts: { t: number; index: number }[] = [];
      for (let candidate = 0; candidate < vertices.length; candidate++) {
        if (candidate === aIndex || candidate === bIndex) {
          continue;
        }
        const p = vertices[candidate]!;
        // Cheap reject before the projection math.
        if (
          p.x < Math.min(a.x, b.x) - ON_EDGE_TOLERANCE ||
          p.x > Math.max(a.x, b.x) + ON_EDGE_TOLERANCE ||
          p.y < Math.min(a.y, b.y) - ON_EDGE_TOLERANCE ||
          p.y > Math.max(a.y, b.y) + ON_EDGE_TOLERANCE ||
          p.z < Math.min(a.z, b.z) - ON_EDGE_TOLERANCE ||
          p.z > Math.max(a.z, b.z) + ON_EDGE_TOLERANCE
        ) {
          continue;
        }
        const ap = subtract(p, a);
        const t = dotProduct(ap, ab) / lengthSq;
        if (t <= 1e-4 || t >= 1 - 1e-4) {
          continue;
        }
        const closest = vec(a.x + ab.x * t, a.y + ab.y * t, a.z + ab.z * t);
        const offset = subtract(p, closest);
        if (dotProduct(offset, offset) < ON_EDGE_TOLERANCE * ON_EDGE_TOLERANCE) {
          inserts.push({ t, index: candidate });
        }
      }
      inserts.sort((lhs, rhs) => lhs.t - rhs.t);
      for (const insert of inserts) {
        if (result[result.length - 1] !== insert.index) {
          result.push(insert.index);
        }
      }
    }
    return result;
  });
  return { vertices, faces };
}

export interface SolidValidation {
  closed: boolean;
  openEdgeCount: number;
  nonManifoldEdgeCount: number;
}

/** A closed solid uses every undirected edge exactly twice, once per direction. */
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

/** Flips face winding when the signed volume is negative (inside-out solid). */
function orientOutward(solid: Solid): Solid {
  if (solidVolume(solid) < 0) {
    return { vertices: solid.vertices, faces: solid.faces.map((face) => [...face].reverse()) };
  }
  return solid;
}

export interface SolidBounds {
  min: Vec3;
  max: Vec3;
}

export function solidBounds(solid: Solid): SolidBounds {
  const min = vec(Infinity, Infinity, Infinity);
  const max = vec(-Infinity, -Infinity, -Infinity);
  for (const p of solid.vertices) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
  }
  if (solid.vertices.length === 0) {
    return { min: vec(0, 0, 0), max: vec(0, 0, 0) };
  }
  return { min, max };
}

/**
 * Triangulates by fanning each convex face. Vertices are not shared between
 * faces so the viewport's per-vertex normals stay flat across facets, giving
 * crisp CAD-style shading.
 */
export function triangulateSolid(solid: Solid): TriangleMesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const face of solid.faces) {
    if (face.length < 3) {
      continue;
    }
    const base = vertices.length / 3;
    for (const index of face) {
      const p = solid.vertices[index]!;
      vertices.push(p.x, p.y, p.z);
    }
    for (let i = 1; i < face.length - 1; i++) {
      indices.push(base, base + i, base + i + 1);
    }
  }
  return { vertices, indices };
}

/** Builds a solid from raw triangle soup (e.g. an imported STL mesh). */
export function solidFromTriangles(vertices: number[], indices: number[]): Solid {
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
