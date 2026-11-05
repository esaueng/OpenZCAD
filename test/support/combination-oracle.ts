/**
 * Independent volume oracles for the K10 combination matrix.
 *
 * Nothing here calls the kernel. Each primitive is modelled in its own
 * frame (the frames the product's primitives use: a box spans
 * [0,w]×[0,h]×[0,d], a cylinder and a cone stand on the origin along +z, a
 * sphere and a torus are centred on it, the torus about +z), placed by the
 * same Move steps the history records, and measured by:
 *
 * - closed forms for each primitive;
 * - inclusion–exclusion for the boolean, where the one non-closed term, the
 *   overlap, is integrated along chords parallel to one operand's axis over
 *   that operand's exact cross-section (equal-area polar rings for round
 *   sections, a midpoint grid for a box), so its own boundary carries no
 *   sampling error. The overlap is integrated at two resolutions and the
 *   difference is returned as the error estimate the tolerance is built on;
 * - Pappus or prism sections for a fillet or chamfer on a straight edge or a
 *   circular seam between two meridian lines (any corner angle).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Row-major 3×3. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number
];

export type SolidModel =
  | { family: 'box'; width: number; height: number; depth: number }
  | { family: 'cylinder'; radius: number; height: number }
  | { family: 'sphere'; radius: number }
  | {
      family: 'cone';
      bottomRadius: number;
      topRadius: number;
      height: number;
    }
  | { family: 'torus'; majorRadius: number; minorRadius: number };

/** One Move: rotate about the world origin (Z·Y·X Euler), then translate. */
export interface MoveStep {
  translation: Vec3;
  rotationDeg?: Vec3;
}

/** world = rotation · local + translation */
export interface Placed {
  solid: SolidModel;
  rotation: Mat3;
  translation: Vec3;
}

export const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 =>
  vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 =>
  vec(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 =>
  vec(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;
export const norm = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const unit = (a: Vec3): Vec3 => scale(a, 1 / norm(a));

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(m: Mat3, v: Vec3): Vec3 {
  return vec(
    m[0] * v.x + m[1] * v.y + m[2] * v.z,
    m[3] * v.x + m[4] * v.y + m[5] * v.z,
    m[6] * v.x + m[7] * v.y + m[8] * v.z
  );
}

/** m transposed times v: the inverse rotation. */
function mulT(m: Mat3, v: Vec3): Vec3 {
  return vec(
    m[0] * v.x + m[3] * v.y + m[6] * v.z,
    m[1] * v.x + m[4] * v.y + m[7] * v.z,
    m[2] * v.x + m[5] * v.y + m[8] * v.z
  );
}

function compose(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      r.push(
        a[i * 3]! * b[j]! +
          a[i * 3 + 1]! * b[3 + j]! +
          a[i * 3 + 2]! * b[6 + j]!
      );
    }
  }
  return r as unknown as Mat3;
}

/** Rz(z)·Ry(y)·Rx(x), degrees: a body turns about X first. */
export function rotationMatrix(deg: Vec3): Mat3 {
  const r = (d: number) => (d * Math.PI) / 180;
  const [cx, sx] = [Math.cos(r(deg.x)), Math.sin(r(deg.x))];
  const [cy, sy] = [Math.cos(r(deg.y)), Math.sin(r(deg.y))];
  const [cz, sz] = [Math.cos(r(deg.z)), Math.sin(r(deg.z))];
  const rx: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rz: Mat3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return compose(rz, compose(ry, rx));
}

export function place(solid: SolidModel, steps: readonly MoveStep[]): Placed {
  let rotation = IDENTITY;
  let translation = vec(0, 0, 0);
  for (const step of steps) {
    const turn = step.rotationDeg ? rotationMatrix(step.rotationDeg) : IDENTITY;
    rotation = compose(turn, rotation);
    translation = add(mul(turn, translation), step.translation);
  }
  return { solid, rotation, translation };
}

export function toWorld(placed: Placed, local: Vec3): Vec3 {
  return add(mul(placed.rotation, local), placed.translation);
}

export function directionToWorld(placed: Placed, local: Vec3): Vec3 {
  return mul(placed.rotation, local);
}

export function closedFormVolume(solid: SolidModel): number {
  switch (solid.family) {
    case 'box':
      return solid.width * solid.height * solid.depth;
    case 'cylinder':
      return Math.PI * solid.radius ** 2 * solid.height;
    case 'sphere':
      return (4 / 3) * Math.PI * solid.radius ** 3;
    case 'cone':
      return (
        (Math.PI *
          solid.height *
          (solid.bottomRadius ** 2 +
            solid.bottomRadius * solid.topRadius +
            solid.topRadius ** 2)) /
        3
      );
    case 'torus':
      return 2 * Math.PI ** 2 * solid.majorRadius * solid.minorRadius ** 2;
  }
}

/** Exact world axis-aligned bounds. */
export function worldBounds(placed: Placed): { min: Vec3; max: Vec3 } {
  const { solid } = placed;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const take = (p: Vec3, pad: [number, number, number] = [0, 0, 0]) => {
    const c = [p.x, p.y, p.z];
    for (let i = 0; i < 3; i += 1) {
      lo[i] = Math.min(lo[i]!, c[i]! - pad[i]!);
      hi[i] = Math.max(hi[i]!, c[i]! + pad[i]!);
    }
  };
  const axis = directionToWorld(placed, vec(0, 0, 1));
  const disc = (radius: number): [number, number, number] =>
    [axis.x, axis.y, axis.z].map(
      (a) => radius * Math.sqrt(Math.max(0, 1 - a * a))
    ) as [number, number, number];
  switch (solid.family) {
    case 'box':
      for (const x of [0, solid.width])
        for (const y of [0, solid.height])
          for (const z of [0, solid.depth]) take(toWorld(placed, vec(x, y, z)));
      break;
    case 'cylinder':
      take(toWorld(placed, vec(0, 0, 0)), disc(solid.radius));
      take(toWorld(placed, vec(0, 0, solid.height)), disc(solid.radius));
      break;
    case 'cone':
      take(toWorld(placed, vec(0, 0, 0)), disc(solid.bottomRadius));
      take(toWorld(placed, vec(0, 0, solid.height)), disc(solid.topRadius));
      break;
    case 'sphere':
      take(toWorld(placed, vec(0, 0, 0)), [
        solid.radius,
        solid.radius,
        solid.radius
      ]);
      break;
    case 'torus': {
      const ring = disc(solid.majorRadius);
      take(
        toWorld(placed, vec(0, 0, 0)),
        ring.map((value) => value + solid.minorRadius) as [
          number,
          number,
          number
        ]
      );
      break;
    }
  }
  return {
    min: vec(lo[0]!, lo[1]!, lo[2]!),
    max: vec(hi[0]!, hi[1]!, hi[2]!)
  };
}

type Interval = readonly [number, number] | null;

/**
 * Inside test in the solid's own frame, used to pick the inside segment
 * between the candidate roots of a convex quadric chord.
 */
function insideLocal(solid: SolidModel, p: Vec3): boolean {
  switch (solid.family) {
    case 'box':
      return (
        p.x >= 0 &&
        p.x <= solid.width &&
        p.y >= 0 &&
        p.y <= solid.height &&
        p.z >= 0 &&
        p.z <= solid.depth
      );
    case 'cylinder':
      return (
        p.z >= 0 &&
        p.z <= solid.height &&
        p.x * p.x + p.y * p.y <= solid.radius ** 2
      );
    case 'sphere':
      return dot(p, p) <= solid.radius ** 2;
    case 'cone': {
      if (p.z < 0 || p.z > solid.height) return false;
      const r =
        solid.bottomRadius +
        ((solid.topRadius - solid.bottomRadius) * p.z) / solid.height;
      return p.x * p.x + p.y * p.y <= r * r;
    }
    case 'torus': {
      const rho = Math.hypot(p.x, p.y) - solid.majorRadius;
      return rho * rho + p.z * p.z <= solid.minorRadius ** 2;
    }
  }
}

function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-300) {
    return Math.abs(b) < 1e-300 ? [] : [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(disc));
  const roots = [q / a];
  if (q !== 0) roots.push(c / q);
  return roots;
}

/**
 * The chord of a convex primitive along o + t·u in its local frame. Every
 * candidate boundary crossing (slab planes, quadric roots) is collected and
 * the segments between them are kept when their midpoint is inside, which
 * is exact for a convex solid.
 */
function chordLocal(solid: SolidModel, o: Vec3, u: Vec3): Interval {
  if (solid.family === 'torus') {
    // Only along the torus axis, where the meridian section is a disc.
    if (Math.abs(Math.abs(u.z) - 1) > 1e-12) {
      throw new Error('A torus chord is only integrated along its axis.');
    }
    const rho = Math.hypot(o.x, o.y) - solid.majorRadius;
    const half = solid.minorRadius ** 2 - rho * rho;
    if (half <= 0) return null;
    const s = Math.sqrt(half);
    const t0 = (-s - o.z) * u.z;
    const t1 = (s - o.z) * u.z;
    return [Math.min(t0, t1), Math.max(t0, t1)];
  }
  const candidates: number[] = [];
  const slab = (origin: number, direction: number, lo: number, hi: number) => {
    if (Math.abs(direction) > 1e-300) {
      candidates.push((lo - origin) / direction, (hi - origin) / direction);
    }
  };
  let span = 0;
  switch (solid.family) {
    case 'box':
      slab(o.x, u.x, 0, solid.width);
      slab(o.y, u.y, 0, solid.height);
      slab(o.z, u.z, 0, solid.depth);
      span = solid.width + solid.height + solid.depth;
      break;
    case 'cylinder': {
      slab(o.z, u.z, 0, solid.height);
      candidates.push(
        ...quadraticRoots(
          u.x * u.x + u.y * u.y,
          2 * (o.x * u.x + o.y * u.y),
          o.x * o.x + o.y * o.y - solid.radius ** 2
        )
      );
      span = solid.height + 2 * solid.radius;
      break;
    }
    case 'sphere':
      candidates.push(
        ...quadraticRoots(
          dot(u, u),
          2 * dot(o, u),
          dot(o, o) - solid.radius ** 2
        )
      );
      span = 2 * solid.radius;
      break;
    case 'cone': {
      slab(o.z, u.z, 0, solid.height);
      const k = (solid.topRadius - solid.bottomRadius) / solid.height;
      const r0 = solid.bottomRadius + k * o.z;
      const rk = k * u.z;
      candidates.push(
        ...quadraticRoots(
          u.x * u.x + u.y * u.y - rk * rk,
          2 * (o.x * u.x + o.y * u.y - r0 * rk),
          o.x * o.x + o.y * o.y - r0 * r0
        )
      );
      span = solid.height + 2 * Math.max(solid.bottomRadius, solid.topRadius);
      break;
    }
  }
  const finite = candidates.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  // Rays parallel to a slab never produce its roots; bracket the candidates
  // so a chord that starts or ends on a quadric alone is still found.
  const reach = Math.abs(dot(o, o)) ** 0.5 + span + 1;
  const points = [-reach * 4, ...finite, reach * 4];
  let start = Number.NaN;
  let end = Number.NaN;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b - a <= 0) continue;
    const mid = (a + b) / 2;
    if (insideLocal(solid, add(o, scale(u, mid)))) {
      if (Number.isNaN(start)) start = a;
      end = b;
    }
  }
  return Number.isNaN(start) ? null : [start, end];
}

/** World chord of a placed solid along origin + t·direction (unit). */
export function chord(placed: Placed, origin: Vec3, direction: Vec3): Interval {
  const o = mulT(placed.rotation, sub(origin, placed.translation));
  const u = mulT(placed.rotation, direction);
  return chordLocal(placed.solid, o, u);
}

/**
 * Cross-section samples of a solid along its local +z, each with its area
 * weight. Round sections use rings in a variable that makes the solid's own
 * chord smooth up to the rim: ρ² for flat-ended solids, the chord's half
 * length for a sphere, the meridian angle for a torus. The chord of a
 * sphere or torus has a square-root edge at the rim, which plain equal-area
 * rings integrate only to O(n^-1.5).
 */
function footprint(
  solid: SolidModel,
  resolution: number
): { points: Array<[number, number, number]>; z0: number } {
  const points: Array<[number, number, number]> = [];
  const sectors = resolution * 2;
  const ring = (rho: number, area: number) => {
    for (let j = 0; j < sectors; j += 1) {
      const theta = (2 * Math.PI * (j + 0.5)) / sectors;
      points.push([
        rho * Math.cos(theta),
        rho * Math.sin(theta),
        area / sectors
      ]);
    }
  };
  const disc = (radius: number) => {
    for (let i = 0; i < resolution; i += 1) {
      ring(
        radius * Math.sqrt((i + 0.5) / resolution),
        (Math.PI * radius * radius) / resolution
      );
    }
  };
  switch (solid.family) {
    case 'box': {
      const n = resolution;
      const area = (solid.width * solid.height) / (n * n);
      for (let i = 0; i < n; i += 1)
        for (let j = 0; j < n; j += 1)
          points.push([
            (solid.width * (i + 0.5)) / n,
            (solid.height * (j + 0.5)) / n,
            area
          ]);
      return { points, z0: -1 };
    }
    case 'cylinder':
      disc(solid.radius);
      return { points, z0: -1 };
    case 'cone':
      disc(Math.max(solid.bottomRadius, solid.topRadius));
      return { points, z0: -1 };
    case 'sphere': {
      // v = half chord / r: ρ = r·√(1 − v²), dA = 2π r² v dv.
      const r = solid.radius;
      for (let i = 0; i < resolution; i += 1) {
        const v = (i + 0.5) / resolution;
        ring(r * Math.sqrt(1 - v * v), (2 * Math.PI * r * r * v) / resolution);
      }
      return { points, z0: -r - 1 };
    }
    case 'torus': {
      // ρ = R + r·sin ψ, ψ ∈ (−π/2, π/2): dA = 2π ρ · r cos ψ dψ.
      const { majorRadius: big, minorRadius: r } = solid;
      for (let i = 0; i < resolution; i += 1) {
        const psi = -Math.PI / 2 + (Math.PI * (i + 0.5)) / resolution;
        const rho = big + r * Math.sin(psi);
        ring(
          rho,
          (2 * Math.PI * rho * r * Math.cos(psi) * Math.PI) / resolution
        );
      }
      return { points, z0: -r - 1 };
    }
  }
}

/**
 * Volume of `footprintSolid ∩ other`, integrated along chords parallel to
 * the footprint solid's own axis.
 */
export function overlapVolume(
  footprintSolid: Placed,
  other: Placed,
  resolution: number
): number {
  const { points, z0 } = footprint(footprintSolid.solid, resolution);
  const direction = directionToWorld(footprintSolid, vec(0, 0, 1));
  let total = 0;
  for (const [x, y, weight] of points) {
    const origin = toWorld(footprintSolid, vec(x, y, z0));
    const own = chordLocal(footprintSolid.solid, vec(x, y, z0), vec(0, 0, 1));
    if (!own) continue;
    const theirs = chord(other, origin, direction);
    if (!theirs) continue;
    const length = Math.min(own[1], theirs[1]) - Math.max(own[0], theirs[0]);
    if (length > 0) total += length * weight;
  }
  return total;
}

/** The overlap at two resolutions; `error` is their difference. */
export function overlapWithError(
  footprintSolid: Placed,
  other: Placed,
  resolution = 256
): { value: number; error: number } {
  const fine = overlapVolume(footprintSolid, other, resolution);
  const coarse = overlapVolume(footprintSolid, other, resolution / 2);
  return { value: fine, error: Math.abs(fine - coarse) };
}

/** A unit direction in a 2D section plane. */
export type Dir2 = readonly [number, number];

export interface Section {
  area: number;
  centroid: [number, number];
}

function polygonSection(points: ReadonlyArray<Dir2>): Section {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    const c = x0 * y1 - x1 * y0;
    area += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  area /= 2;
  return { area: Math.abs(area), centroid: [cx / (6 * area), cy / (6 * area)] };
}

/**
 * The region a fillet of radius r fills or removes at a corner whose faces
 * leave the edge along unit d1 and d2 (angle α < π between them): the kite
 * (corner, two tangent points, arc centre) minus the arc's sector.
 */
export function filletSection(d1: Dir2, d2: Dir2, r: number): Section {
  const alpha = Math.acos(
    Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]))
  );
  const t = r / Math.tan(alpha / 2);
  const bl = Math.hypot(d1[0] + d2[0], d1[1] + d2[1]);
  const bis: Dir2 = [(d1[0] + d2[0]) / bl, (d1[1] + d2[1]) / bl];
  const centreDistance = r / Math.sin(alpha / 2);
  const o: Dir2 = [bis[0] * centreDistance, bis[1] * centreDistance];
  const kite = polygonSection([
    [0, 0],
    [d1[0] * t, d1[1] * t],
    o,
    [d2[0] * t, d2[1] * t]
  ]);
  const theta = Math.PI - alpha;
  const sectorArea = (theta * r * r) / 2;
  const reach = (4 * r * Math.sin(theta / 2)) / (3 * theta);
  const sector: [number, number] = [
    o[0] - bis[0] * reach,
    o[1] - bis[1] * reach
  ];
  const area = kite.area - sectorArea;
  return {
    area,
    centroid: [
      (kite.area * kite.centroid[0] - sectorArea * sector[0]) / area,
      (kite.area * kite.centroid[1] - sectorArea * sector[1]) / area
    ]
  };
}

/** The triangle a symmetric chamfer with setback s cuts or fills. */
export function chamferSection(d1: Dir2, d2: Dir2, s: number): Section {
  return polygonSection([
    [0, 0],
    [d1[0] * s, d1[1] * s],
    [d2[0] * s, d2[1] * s]
  ]);
}

/**
 * A modelled edge: a straight edge of length L, or a circular edge of
 * radius ρ whose section lies in the meridian (radial, axial) plane. d1 and
 * d2 are the two faces' directions away from the edge in that section.
 */
export type Corner =
  | {
      kind: 'line';
      start: Vec3;
      end: Vec3;
      d1: Dir2;
      d2: Dir2;
      convex: boolean;
    }
  | {
      kind: 'circle';
      center: Vec3;
      axis: Vec3;
      radius: number;
      d1: Dir2;
      d2: Dir2;
      convex: boolean;
    };

/** Signed volume change of a fillet or chamfer on one modelled edge. */
export function cornerVolumeChange(
  corner: Corner,
  modifier: 'fillet' | 'chamfer',
  size: number
): number {
  const section =
    modifier === 'fillet'
      ? filletSection(corner.d1, corner.d2, size)
      : chamferSection(corner.d1, corner.d2, size);
  const sign = corner.convex ? -1 : 1;
  if (corner.kind === 'line') {
    return sign * section.area * norm(sub(corner.end, corner.start));
  }
  // Pappus: the section sweeps a circle through its centroid.
  return (
    sign * section.area * 2 * Math.PI * (corner.radius + section.centroid[0])
  );
}

/**
 * The corner two boundary lines make at a circular seam, in the meridian
 * plane (radial, axial) with the seam at the origin. Each operand is the
 * half-plane `dot(p, outward) < 0` bounded by the line along `along`.
 * Returns the one wedge that differs from the other three, or null when the
 * boolean leaves no edge there.
 */
export function seamWedge(
  a: { along: Dir2; outward: Dir2 },
  b: { along: Dir2; outward: Dir2 },
  material: (inA: boolean, inB: boolean) => boolean
): { d1: Dir2; d2: Dir2; convex: boolean } | null {
  const rays: Dir2[] = [
    a.along,
    b.along,
    [-a.along[0], -a.along[1]],
    [-b.along[0], -b.along[1]]
  ];
  rays.sort((p, q) => Math.atan2(p[1], p[0]) - Math.atan2(q[1], q[0]));
  const wedges = rays.map((d1, i) => {
    const d2 = rays[(i + 1) % rays.length]!;
    const mid: Dir2 = [d1[0] + d2[0], d1[1] + d2[1]];
    const inside = (h: { outward: Dir2 }) =>
      mid[0] * h.outward[0] + mid[1] * h.outward[1] < 0;
    return { d1, d2, solid: material(inside(a), inside(b)) };
  });
  const solid = wedges.filter((wedge) => wedge.solid);
  if (solid.length === 1) {
    const w = solid[0]!;
    return { d1: w.d1, d2: w.d2, convex: true };
  }
  if (solid.length === 3) {
    const w = wedges.find((wedge) => !wedge.solid)!;
    return { d1: w.d1, d2: w.d2, convex: false };
  }
  return null;
}
