/**
 * Recognize one symmetric opening in an imported solid whose two ends are
 * rigid and whose connecting section is straight, and describe it as the
 * measured recipe the growing-holder compiler consumes. Everything reported
 * is measured from the exact solid; nothing is inferred from names, files or
 * resemblance. Unsupported or ambiguous geometry is refused with a reason —
 * a caller must never assume editability from a candidate list.
 */
import type { SketchObjectData, Vector3 } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import {
  detectReflectionSymmetries,
  measureAnalyticInventory,
  type AnalyticFaceMeasurement,
  type AnalyticInventory,
  type MeasurementPoint
} from './reconstruction-measurement';

export type OpeningAxis = 'x' | 'y' | 'z';

/** Everything the compiler's recipe needs except a name and a body id. */
export interface RecognizedOpening {
  axis: OpeningAxis;
  envelope: { min: Vector3; max: Vector3 };
  cuts: [number, number];
  center: number;
  sourceOpening: number;
  minimumOpening: number;
  section: SketchObjectData[];
}

export interface OpeningCandidate {
  axis: OpeningAxis;
  faceA: number;
  faceB: number;
  opening: number;
  /** Coordinates of the two inner faces along the axis, negative side first. */
  innerFaces: [number, number];
  overlapArea: number;
}

export interface OpeningEvidence {
  candidate: OpeningCandidate;
  /** Offset of the reflection plane that confirmed the center, and its coverage. */
  symmetry: { planeOffset: number; analyticCoverage: number };
  /** Longest interval between the inner faces whose section never changes. */
  straightRun: [number, number];
  sectionEdges: number;
}

export type OpeningRecognition =
  | { status: 'recognized'; opening: RecognizedOpening; evidence: OpeningEvidence }
  | { status: 'ambiguous'; reason: string; candidates: OpeningCandidate[] }
  | { status: 'unsupported'; reason: string };

export interface OpeningRecognitionOptions {
  /** Restrict candidates to one axis (a guided selection). */
  axis?: OpeningAxis;
  /** Restrict candidates to one face pair (a guided selection), any order. */
  faces?: [number, number];
  /** Linear tolerance in document units. */
  tolerance?: number;
}

const AXES: readonly OpeningAxis[] = ['x', 'y', 'z'];
const DEFAULT_TOLERANCE = 1e-6;
/** Distance kept between a cut and the nearest change of section. */
const CUT_MARGIN = 0.5;
/** A straight run shorter than this cannot host a bridge worth editing. */
const MIN_STRAIGHT_RUN = 2;
/** Bridge length kept at the minimum opening. */
const MIN_BRIDGE = 0.1;
/** Two candidates this close in overlap area are indistinguishable. */
const AMBIGUITY_RATIO = 0.9;
const MAX_SECTION_EDGES = 64;
/** Edge sampling deflection for face extents; coarse is enough for bounds. */
const EXTENT_DEFLECTION = 0.05;
/** Sketch-plane bases, kept identical to `PLANE_BASES` in @openzcad/geometry. */
const SECTION_FRAME: Record<
  OpeningAxis,
  { u: Vector3; v: Vector3; normal: Vector3 }
> = {
  x: { u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 }, normal: { x: 1, y: 0, z: 0 } },
  y: { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 }, normal: { x: 0, y: 1, z: 0 } },
  z: { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } }
};

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const dot = (a: Vector3, b: Vector3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const unsupported = (reason: string): OpeningRecognition => ({
  status: 'unsupported',
  reason
});

function axisOf(normal: MeasurementPoint, tolerance: number): OpeningAxis | null {
  const aligned = AXES.filter((axis) => Math.abs(Math.abs(normal[axis]) - 1) <= tolerance);
  const others = AXES.filter((axis) => Math.abs(normal[axis]) <= tolerance);
  return aligned.length === 1 && others.length === 2 ? aligned[0]! : null;
}

/** A face whose section perpendicular to `axis` is the same at every station. */
function invariantAlong(face: AnalyticFaceMeasurement, axis: OpeningAxis, tolerance: number): boolean {
  if (face.surfaceType === 'plane' && face.normal)
    return Math.abs(face.normal[axis]) <= tolerance;
  if (face.surfaceType === 'cylinder' && face.axisStart && face.axisEnd) {
    const direction = {
      x: face.axisEnd.x - face.axisStart.x,
      y: face.axisEnd.y - face.axisStart.y,
      z: face.axisEnd.z - face.axisStart.z
    };
    const length = Math.hypot(direction.x, direction.y, direction.z);
    return length > 0 && Math.abs(Math.abs(direction[axis]) / length - 1) <= tolerance;
  }
  return false;
}

type Extents = Record<OpeningAxis, [number, number]>;

/**
 * Bounds of every face's boundary, sampled along its edges. Vertices alone
 * would miss most of a circle: a full circular edge has one seam vertex.
 */
function faceExtents(
  kernel: RemusKernel,
  inventory: AnalyticInventory
): Map<number, Extents> {
  const extents = new Map<number, Extents>();
  for (const face of inventory.faces) {
    const extent: Extents = {
      x: [Infinity, -Infinity],
      y: [Infinity, -Infinity],
      z: [Infinity, -Infinity]
    };
    for (const edge of kernel.getFaceEdges(face.face)) {
      const samples = kernel.sampleEdge(edge, EXTENT_DEFLECTION);
      for (let i = 0; i + 2 < samples.length; i += 3) {
        const point = { x: samples[i]!, y: samples[i + 1]!, z: samples[i + 2]! };
        for (const axis of AXES) {
          extent[axis][0] = Math.min(extent[axis][0], point[axis]);
          extent[axis][1] = Math.max(extent[axis][1], point[axis]);
        }
      }
    }
    extents.set(face.face, extent);
  }
  return extents;
}

/**
 * The longest interval strictly between the inner faces over which every
 * face crossing it is invariant along the axis. Face extents come from
 * vertices; the cut margin and the section signature checks guard against
 * a curved face bulging past its own boundary.
 */
function straightRun(
  inventory: AnalyticInventory,
  extents: Map<number, Extents>,
  axis: OpeningAxis,
  inner: [number, number],
  tolerance: number
): [number, number] | null {
  const [lo, hi] = inner;
  const breakpoints = new Set<number>([lo, hi]);
  const spans: { face: number; extent: [number, number]; invariant: boolean }[] = [];
  for (const face of inventory.faces) {
    const extent = extents.get(face.face)?.[axis];
    if (!extent || !Number.isFinite(extent[0]) || !Number.isFinite(extent[1])) return null;
    if (extent[1] <= lo + tolerance || extent[0] >= hi - tolerance) continue;
    spans.push({ face: face.face, extent, invariant: invariantAlong(face, axis, tolerance) });
    for (const value of extent)
      if (value > lo + tolerance && value < hi - tolerance) breakpoints.add(value);
  }
  const stations = [...breakpoints].sort((a, b) => a - b);
  // Between two consecutive stations the set of crossing faces is constant.
  // A run may only join intervals whose crossing sets are identical and all
  // invariant: a face parallel to the axis that starts or ends at a station
  // changes the section there even though both sides are "clear".
  let best: [number, number] | null = null;
  let start: number | null = null;
  let runKey: string | null = null;
  const flush = (end: number) => {
    if (start !== null && (best === null || end - start > best[1] - best[0]))
      best = [start, end];
    start = null;
    runKey = null;
  };
  for (let i = 0; i + 1 < stations.length; i += 1) {
    const a = stations[i]!;
    const b = stations[i + 1]!;
    const crossing = spans.filter(
      ({ extent }) => extent[0] < b - tolerance && extent[1] > a + tolerance
    );
    const clear = crossing.every(({ invariant }) => invariant);
    const key = crossing
      .map(({ face }) => face)
      .sort((l, r) => l - r)
      .join(',');
    if (!clear) {
      flush(a);
      continue;
    }
    if (start !== null && key !== runKey) flush(a);
    if (start === null) {
      start = a;
      runKey = key;
    }
  }
  flush(stations[stations.length - 1]!);
  return best;
}

interface SectionEdge {
  kind: 'line' | 'arc';
  data: SketchObjectData;
  /** Canonical string for comparing sections at different stations. */
  key: string;
}

/** Exact sketch-plane coordinates; callers round once, after any fit. */
function project(point: MeasurementPoint | Vector3, axis: OpeningAxis): { u: number; v: number } {
  const frame = SECTION_FRAME[axis];
  return { u: dot(point, frame.u), v: dot(point, frame.v) };
}

function circleThrough(
  a: { u: number; v: number },
  b: { u: number; v: number },
  c: { u: number; v: number }
): { u: number; v: number; radius: number } | null {
  const d = 2 * (a.u * (b.v - c.v) + b.u * (c.v - a.v) + c.u * (a.v - b.v));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.u * a.u + a.v * a.v;
  const b2 = b.u * b.u + b.v * b.v;
  const c2 = c.u * c.u + c.v * c.v;
  const u = (a2 * (b.v - c.v) + b2 * (c.v - a.v) + c2 * (a.v - b.v)) / d;
  const v = (a2 * (c.u - b.u) + b2 * (a.u - c.u) + c2 * (b.u - a.u)) / d;
  return { u, v, radius: Math.hypot(a.u - u, a.v - v) };
}

const degrees = (radians: number): number => {
  let value = round((radians * 180) / Math.PI);
  while (value < 0) value += 360;
  while (value >= 360) value -= 360;
  return value;
};

/** Read the outer loop of an exact planar face as numeric lines and arcs in the sketch frame. */
function readProfile(
  kernel: RemusKernel,
  face: number,
  axis: OpeningAxis,
  label: string
): SectionEdge[] | string {
  if (kernel.getFaceWires(face).length !== 1)
    return `${label} has an inner loop; a hollow section is not supported.`;
  const edges = Array.from(kernel.getWireEdges(kernel.getFaceOuterWire(face)));
  if (edges.length < 2 || edges.length > MAX_SECTION_EDGES)
    return `${label} has ${edges.length} edges.`;
  const result: SectionEdge[] = [];
  for (const edge of edges) {
    const type = kernel.getEdgeCurveType(edge);
    const ends = Array.from(kernel.getEdgeVertices(edge));
    if (ends.length !== 6 || !ends.every(Number.isFinite))
      return `${label} has an edge without finite endpoints.`;
    const start = project({ x: ends[0]!, y: ends[1]!, z: ends[2]! }, axis);
    const end = project({ x: ends[3]!, y: ends[4]!, z: ends[5]! }, axis);
    if (type === 'LINE') {
      const a = { u: round(start.u), v: round(start.v) };
      const b = { u: round(end.u), v: round(end.v) };
      const [p, q] = [a, b].sort((l, r) => l.u - r.u || l.v - r.v);
      result.push({
        kind: 'line',
        data: { objectKind: 'line', x1: a.u, y1: a.v, x2: b.u, y2: b.v },
        key: `line ${p!.u},${p!.v} ${q!.u},${q!.v}`
      });
      continue;
    }
    if (type !== 'CIRCLE')
      return `${label} has a ${type.toLowerCase()} edge; only lines and arcs are supported.`;
    const samples = Array.from(kernel.sampleEdge(edge, 0.01));
    if (samples.length < 9) return `${label} could not sample an arc.`;
    const middle = Math.floor(samples.length / 3 / 2) * 3;
    const mid = project({ x: samples[middle]!, y: samples[middle + 1]!, z: samples[middle + 2]! }, axis);
    const circle = circleThrough(start, mid, end);
    if (!circle) return `${label} has a degenerate arc.`;
    const angle = (p: { u: number; v: number }) => Math.atan2(p.v - circle.v, p.u - circle.u);
    const ccw = (from: number, to: number) => {
      let sweep = to - from;
      while (sweep <= 0) sweep += 2 * Math.PI;
      return sweep;
    };
    // The sketch arc sweeps counter-clockwise from start to end; orient it so
    // the sampled midpoint lies on the sweep.
    const [s, m, e] = [angle(start), angle(mid), angle(end)];
    const forward = ccw(s, m) < ccw(s, e);
    const [from, to] = forward ? [s, e] : [e, s];
    const data: SketchObjectData = {
      objectKind: 'arc',
      centerX: round(circle.u),
      centerY: round(circle.v),
      radius: round(circle.radius),
      startAngleDeg: degrees(from),
      endAngleDeg: degrees(to)
    };
    result.push({
      kind: 'arc',
      data,
      key: `arc ${data.centerX},${data.centerY} r${data.radius} ${data.startAngleDeg}-${data.endAngleDeg}`
    });
  }
  return result;
}

/**
 * Prove that the solid between the two cuts is a straight extrusion of one
 * closed profile: intersect it with a slab bounded by the cut planes, then
 * require exactly one planar end face at each cut, identical profiles on
 * both, and every other face invariant along the axis. The kernel's
 * `section` query is not used: on NURBS-bearing solids it reports
 * silhouettes rather than cross-sections.
 */
function proveStraightSection(
  kernel: RemusKernel,
  solid: number,
  axis: OpeningAxis,
  cuts: [number, number],
  bounds: { min: Vector3; max: Vector3 },
  tolerance: number
): { section: SectionEdge[] } | string {
  const margin = 1 + 0.05 * Math.max(...AXES.map((a) => bounds.max[a] - bounds.min[a]));
  const min: Vector3 = { x: bounds.min.x - margin, y: bounds.min.y - margin, z: bounds.min.z - margin };
  const max: Vector3 = { x: bounds.max.x + margin, y: bounds.max.y + margin, z: bounds.max.z + margin };
  min[axis] = cuts[0];
  max[axis] = cuts[1];
  let slab: number;
  try {
    const box = kernel.copyAndTransformSolid(
      kernel.makeBox(max.x - min.x, max.y - min.y, max.z - min.z),
      Float64Array.of(1, 0, 0, min.x, 0, 1, 0, min.y, 0, 0, 1, min.z, 0, 0, 0, 1)
    );
    slab = kernel.intersect(solid, box);
    if (kernel.validateSolid(slab) !== 0)
      return 'The material between the proposed cuts is not a valid solid.';
  } catch (error) {
    return `Carving the section between the cuts failed: ${(error as Error).message}`;
  }
  let faces: AnalyticInventory['faces'];
  try {
    faces = measureAnalyticInventory(kernel, slab).faces;
  } catch (error) {
    return (error as Error).message;
  }
  const ends: [number[], number[]] = [[], []];
  for (const face of faces) {
    const isEnd =
      face.surfaceType === 'plane' &&
      !!face.normal &&
      Math.abs(Math.abs(face.normal[axis]) - 1) <= tolerance;
    if (isEnd) {
      const at = face.center[axis];
      if (Math.abs(at - cuts[0]) <= tolerance) ends[0].push(face.face);
      else if (Math.abs(at - cuts[1]) <= tolerance) ends[1].push(face.face);
      else return 'The section changes between the proposed cuts; the region between them is not straight.';
    } else if (!invariantAlong(face, axis, tolerance)) {
      return `A ${face.surfaceType} face between the cuts is not straight along ${axis}; the region is not a plain extrusion.`;
    }
  }
  if (ends[0].length !== 1 || ends[1].length !== 1)
    return `The section between the cuts has ${ends[0].length} and ${ends[1].length} regions; the straight section must be one.`;
  const first = readProfile(kernel, ends[0][0]!, axis, `The section at ${axis} = ${cuts[0]}`);
  if (typeof first === 'string') return first;
  const second = readProfile(kernel, ends[1][0]!, axis, `The section at ${axis} = ${cuts[1]}`);
  if (typeof second === 'string') return second;
  if (sectionSignature(first) !== sectionSignature(second))
    return 'The section differs at the two cuts; the region between them is not straight.';
  return { section: first };
}

const sectionSignature = (edges: SectionEdge[]): string =>
  edges
    .map((edge) => edge.key)
    .sort()
    .join('|');

/**
 * Recognize the opening of `solid`. The candidate opening is a pair of
 * inward-facing parallel planar faces with projected overlap whose gap is
 * empty and whose normal is a world axis; a reflection plane confirms the
 * center; the straight section is the longest axis-invariant run between the
 * faces, verified by identical sections at its ends and middle.
 */
export function recognizeOpening(
  kernel: RemusKernel,
  solid: number,
  options: OpeningRecognitionOptions = {}
): OpeningRecognition {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  let inventory: AnalyticInventory;
  let bounds: { min: Vector3; max: Vector3 };
  try {
    inventory = measureAnalyticInventory(kernel, solid);
    const raw = Array.from(kernel.boundingBox(solid));
    bounds = {
      min: { x: raw[0]!, y: raw[1]!, z: raw[2]! },
      max: { x: raw[3]!, y: raw[4]!, z: raw[5]! }
    };
  } catch (error) {
    return unsupported((error as Error).message);
  }
  if (![bounds.min, bounds.max].every((p) => AXES.every((a) => Number.isFinite(p[a]))))
    return unsupported('The solid has no finite bounds.');
  const extents = faceExtents(kernel, inventory);
  const candidates: OpeningCandidate[] = [];
  // Candidate openings are pairs of planar faces that look at each other
  // along a world axis with an empty gap between them. The kernel's opposing
  // pair query reports back-to-back faces (wall thickness), so the facing
  // pairs are assembled here from the inventory and the gap is proved by
  // classifying the midpoint of their projected overlap.
  const planar = inventory.faces.filter(
    (face): face is AnalyticFaceMeasurement & { normal: MeasurementPoint } =>
      face.surfaceType === 'plane' && !!face.normal
  );
  for (const axis of AXES) {
    if (options.axis && axis !== options.axis) continue;
    const others = AXES.filter((other) => other !== axis) as [OpeningAxis, OpeningAxis];
    const facing = planar.filter((face) => axisOf(face.normal, 1e-9) === axis);
    const toward = facing.filter((face) => face.normal[axis] > 0);
    const away = facing.filter((face) => face.normal[axis] < 0);
    for (const negative of toward) {
      for (const positive of away) {
        if (
          options.faces &&
          !(
            (options.faces[0] === negative.face && options.faces[1] === positive.face) ||
            (options.faces[0] === positive.face && options.faces[1] === negative.face)
          )
        )
          continue;
        const gap = positive.center[axis] - negative.center[axis];
        if (gap <= tolerance) continue;
        const negativeExtents = others.map((other) => extents.get(negative.face)![other]);
        const positiveExtents = others.map((other) => extents.get(positive.face)![other]);
        const overlap = others.map((_, i) => [
          Math.max(negativeExtents[i]![0], positiveExtents[i]![0]),
          Math.min(negativeExtents[i]![1], positiveExtents[i]![1])
        ]);
        const overlapArea = overlap.reduce((area, [lo, hi]) => area * Math.max(0, hi! - lo!), 1);
        if (!(overlapArea > 0)) continue;
        const midpoint: Vector3 = { x: 0, y: 0, z: 0 };
        midpoint[axis] = (negative.center[axis] + positive.center[axis]) / 2;
        others.forEach((other, i) => {
          midpoint[other] = (overlap[i]![0]! + overlap[i]![1]!) / 2;
        });
        let classification: string;
        try {
          classification = kernel.classifyPoint(solid, midpoint.x, midpoint.y, midpoint.z, tolerance);
        } catch {
          continue;
        }
        if (classification !== 'outside') continue;
        candidates.push({
          axis,
          faceA: negative.face,
          faceB: positive.face,
          opening: round(gap),
          innerFaces: [round(negative.center[axis]), round(positive.center[axis])],
          overlapArea
        });
      }
    }
  }
  if (!candidates.length)
    return unsupported('No pair of inward-facing parallel faces with an empty gap along a world axis was found.');
  candidates.sort((l, r) => r.overlapArea - l.overlapArea);
  const [best, runnerUp] = candidates;
  if (runnerUp && runnerUp.overlapArea >= best!.overlapArea * AMBIGUITY_RATIO)
    return {
      status: 'ambiguous',
      reason: 'More than one opening has a comparable facing area; select the intended pair of inner faces.',
      candidates
    };
  const candidate = best!;
  const { axis } = candidate;
  const center = (candidate.innerFaces[0] + candidate.innerFaces[1]) / 2;
  const symmetry = detectReflectionSymmetries(inventory, bounds).find(
    (plane) =>
      axisOf(plane.planeNormal, 1e-6) === axis &&
      Math.abs(Math.abs(plane.planeOffset) - Math.abs(center)) <= Math.max(CUT_MARGIN, tolerance)
  );
  if (!symmetry)
    return unsupported(
      `No reflection plane at ${axis} = ${round(center)} confirms that the two ends are mirror images; asymmetric ends are not supported.`
    );
  const run = straightRun(inventory, extents, axis, candidate.innerFaces, tolerance);
  if (!run || run[1] - run[0] < MIN_STRAIGHT_RUN + 2 * CUT_MARGIN)
    return unsupported('No straight section long enough to grow was found between the inner faces.');
  const cuts: [number, number] = [round(run[0] + CUT_MARGIN), round(run[1] - CUT_MARGIN)];
  const proof = proveStraightSection(kernel, solid, axis, cuts, bounds, Math.max(tolerance, 1e-6));
  if (typeof proof === 'string') return unsupported(proof);
  const sectionLength = cuts[1] - cuts[0];
  return {
    status: 'recognized',
    opening: {
      axis,
      envelope: {
        min: { x: round(bounds.min.x), y: round(bounds.min.y), z: round(bounds.min.z) },
        max: { x: round(bounds.max.x), y: round(bounds.max.y), z: round(bounds.max.z) }
      },
      cuts,
      center: round(center),
      sourceOpening: candidate.opening,
      minimumOpening: round(candidate.opening - sectionLength + MIN_BRIDGE),
      section: proof.section.map((edge) => edge.data)
    },
    evidence: {
      candidate,
      symmetry: {
        planeOffset: symmetry.planeOffset,
        analyticCoverage: symmetry.analyticCoverage
      },
      straightRun: [round(run[0]), round(run[1])],
      sectionEdges: proof.section.length
    }
  };
}
