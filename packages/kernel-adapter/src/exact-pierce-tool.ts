/**
 * Coplanar-cap pierce: a kernel-side workaround for remus#953.
 *
 * The exact boolean refuses (`exact_only_unattainable`) a Bezier-walled
 * prism whose planar cap lies on, or within about a micrometre of, a planar
 * face of the body it is cut from or united with. On-face text is the case
 * that hits it: "Boa" at em 8 sketched on a slab's top face and extruded
 * 2 mm into it, or 2 mm out of it, is refused, while the very same tool given
 * a hair of travel across the face — a two-sided extrude with a 0.01 back
 * distance — cuts and embosses to the exact closed-form volume.
 *
 * So when the plain tool is refused by that code, and only then, the tool is
 * rebuilt with that hair of travel on the side of the face where it cannot
 * change the result:
 *
 * - a cut extends into the AIR side of the face (material removed from where
 *   there is none);
 * - an add/union extends into the BODY (material added where there already
 *   is some).
 *
 * The document is never touched. The stored feature keeps the user's
 * distance, and the travel exists only on the transient feature node handed
 * to the sweep builder for this one kernel call.
 *
 * Retrying after the refusal, rather than piercing up front, is deliberate:
 * every on-face boolean the kernel already builds keeps exactly the tool and
 * topology it had, and the day the kernel fixes the coplanar case this path
 * simply stops running.
 */
import { findFeature, resolveParamValue } from '@openzcad/document-core';
import {
  geometryTolerance,
  type PlaneBasis,
  type Vec3
} from '@openzcad/geometry';
import type { FeatureNode } from '@openzcad/shared';
import { buildSweep } from './exact-profile-builders';
import { classifySolidPoint } from './exact-measure';
import { isBuildCancelled } from './exact-cancellation';
import { readFacePlaneFrame } from './exact-face-plane-frame';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
import { tessellatedFaceBounds } from './exact-boolean-helpers';
import { kernelRefusalRecordOf } from './kernel-refusal';
import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import type { FeatureBuildContext, FeatureDataOf } from './exact-build-loop';

/**
 * How far the pierced tool travels across the face, as a multiple of the
 * linear geometry tolerance at the model's scale. The kernel's tolerances are
 * absolute in model (document) units, so the travel is too: 1e4 × 1e-6 =
 * 0.01 document units, which is 0.01 mm in a millimetre document — the travel
 * measured to clear the refusal (so did 0.5) — and four orders of magnitude
 * outside the ~1 µm band in which the refusal was measured.
 */
const PIERCE_TRAVEL_TOLERANCES = 1e4;

/**
 * How close the sketch plane and a face must be to count as coplanar: ten
 * linear tolerances, wide enough for the ~1 µm band the refusal was measured
 * in, and far below anything the pierce could visibly add or remove.
 */
const COPLANAR_TOLERANCES = 10;

/** Parallel planes: |cos| between the normals at least this close to 1. */
const PARALLEL_COSINE = 1 - 1e-9;

/**
 * Ceiling on the cap triangles sampled by the side test. That test only says
 * which side of the face is air; coverage of the footprint is proved from the
 * loops by `capsOnPartnerFaces`, so the stride cannot let a hole through.
 */
const MAX_SIDE_SAMPLES = 512;

/** The kernel refusal remus#953 produces, and the only one retried here. */
export function isCoplanarCapRefusal(error: unknown): boolean {
  const record = kernelRefusalRecordOf(error);
  return (
    record !== undefined &&
    record.family === 'boolean' &&
    record.code === 'exact_only_unattainable'
  );
}

/**
 * Retry a refused boolean on pierced operands.
 *
 * Runs `retry` on what `pierce` returns when `error` is the coplanar-cap
 * refusal and the gate produced operands. In every other case — a different
 * error, a gate that does not hold, or a pierce or retry that fails in turn —
 * the user's original `error` is rethrown, so the workaround can never
 * replace an honest refusal with a stranger one. A cancellation always
 * propagates as itself.
 */
export function retryCoplanarRefusal<P, T>(
  error: unknown,
  pierce: () => P | null,
  retry: (pierced: P) => T
): T {
  if (!isCoplanarCapRefusal(error)) throw error;
  let pierced: P | null;
  try {
    pierced = pierce();
  } catch (pierceError) {
    if (isBuildCancelled(pierceError)) throw pierceError;
    throw error;
  }
  if (pierced === null) throw error;
  try {
    return retry(pierced);
  } catch (retryError) {
    if (isBuildCancelled(retryError)) throw retryError;
    throw error;
  }
}

/**
 * The pierce travel for a model whose coordinates reach `scale`, in document
 * units.
 */
export function pierceTravel(scale: number): number {
  return PIERCE_TRAVEL_TOLERANCES * geometryTolerance(scale);
}

function modelScale(kernel: RemusKernel, solids: readonly number[]): number {
  let scale = 1;
  for (const solid of solids) {
    for (const value of kernel.boundingBox(solid)) {
      if (Number.isFinite(value)) scale = Math.max(scale, Math.abs(value));
    }
  }
  return scale;
}

function planeDistance(plane: PlaneBasis, point: Vec3): number {
  return (
    plane.normal.x * (point.x - plane.origin.x) +
    plane.normal.y * (point.y - plane.origin.y) +
    plane.normal.z * (point.z - plane.origin.z)
  );
}

/** The planar faces of `solids` that lie in `plane`, within `tolerance`. */
function coplanarFaces(
  kernel: RemusKernel,
  solids: readonly number[],
  plane: PlaneBasis,
  tolerance: number
): number[] {
  const faces: number[] = [];
  for (const solid of solids) {
    for (const face of Array.from(kernel.getSolidFaces(solid))) {
      let frame;
      try {
        frame = readFacePlaneFrame(kernel, face);
      } catch {
        continue;
      }
      if (frame.surfaceType !== 'plane' || !frame.normal) continue;
      const cosine =
        frame.normal.x * plane.normal.x +
        frame.normal.y * plane.normal.y +
        frame.normal.z * plane.normal.z;
      if (Math.abs(cosine) < PARALLEL_COSINE) continue;
      if (Math.abs(planeDistance(plane, frame.center)) > tolerance) continue;
      faces.push(face);
    }
  }
  return faces;
}

/** Interior points of `faces`: the centroids of their display triangles. */
function capSamples(kernel: RemusKernel, faces: readonly number[]): Vec3[] {
  const samples: Vec3[] = [];
  for (const face of faces) {
    const mesh = kernel.tessellateFace(face, MEASUREMENT_DEFLECTION);
    try {
      const { positions, indices } = mesh;
      for (let at = 0; at + 2 < indices.length; at += 3) {
        const corner = (offset: number, axis: number): number =>
          positions[indices[at + offset]! * 3 + axis]!;
        samples.push({
          x: (corner(0, 0) + corner(1, 0) + corner(2, 0)) / 3,
          y: (corner(0, 1) + corner(1, 1) + corner(2, 1)) / 3,
          z: (corner(0, 2) + corner(1, 2) + corner(2, 2)) / 3
        });
      }
    } finally {
      mesh.free();
    }
  }
  if (samples.length <= MAX_SIDE_SAMPLES) return samples;
  const stride = samples.length / MAX_SIDE_SAMPLES;
  return Array.from(
    { length: MAX_SIDE_SAMPLES },
    (_, index) => samples[Math.floor(index * stride)]!
  );
}

function offsetPoint(point: Vec3, direction: Vec3, distance: number): Vec3 {
  return {
    x: point.x + direction.x * distance,
    y: point.y + direction.y * distance,
    z: point.z + direction.z * distance
  };
}

/** True when the point is inside at least one of `solids`. */
function insideAny(
  kernel: RemusKernel,
  solids: readonly number[],
  point: Vec3
): boolean | null {
  let inside = false;
  for (const solid of solids) {
    const verdict = classifySolidPoint(kernel, solid, point);
    if (verdict === 'inside') inside = true;
    else if (verdict !== 'outside') return null;
  }
  return inside;
}

/** A face loop flattened into the sketch plane: a closed segment soup. */
interface PlaneLoop {
  /** `[x1, y1, x2, y2]` per chord, in plane (u, v) coordinates. */
  segments: Float64Array[];
  /** A point on the loop, for side tests once the loops are separated. */
  probe: [number, number];
  /** Axis-aligned bounds of the chords: `[minX, minY, maxX, maxY]`. */
  bounds: [number, number, number, number];
}

interface PlaneRegion {
  outer: PlaneLoop;
  inner: PlaneLoop[];
}

/**
 * A planar face's loops (outer first, then its holes) in plane coordinates.
 * Each edge is sampled by the kernel at `deflection`, so a chord sits within
 * `deflection` of the true curve; the containment test widens every
 * clearance by that much on both sides, so flattening can only make it more
 * conservative.
 */
function planeRegion(
  kernel: RemusKernel,
  face: number,
  plane: PlaneBasis,
  deflection: number
): PlaneRegion {
  const wires = Array.from(kernel.getFaceWires(face));
  if (wires.length === 0 || wires[0] !== kernel.getFaceOuterWire(face)) {
    throw new Error('Face wires did not lead with the outer wire.');
  }
  const loops = wires.map((wire): PlaneLoop => {
    const segments: Float64Array[] = [];
    const bounds: [number, number, number, number] = [
      Infinity,
      Infinity,
      -Infinity,
      -Infinity
    ];
    let probe: [number, number] | null = null;
    for (const edge of Array.from(kernel.getWireEdges(wire))) {
      const values = kernel.sampleEdge(edge, deflection);
      let previous: [number, number] | null = null;
      for (let at = 0; at + 2 < values.length; at += 3) {
        const dx = values[at]! - plane.origin.x;
        const dy = values[at + 1]! - plane.origin.y;
        const dz = values[at + 2]! - plane.origin.z;
        const point: [number, number] = [
          dx * plane.u.x + dy * plane.u.y + dz * plane.u.z,
          dx * plane.v.x + dy * plane.v.y + dz * plane.v.z
        ];
        probe ??= point;
        bounds[0] = Math.min(bounds[0], point[0]);
        bounds[1] = Math.min(bounds[1], point[1]);
        bounds[2] = Math.max(bounds[2], point[0]);
        bounds[3] = Math.max(bounds[3], point[1]);
        if (previous) {
          segments.push(
            Float64Array.of(previous[0], previous[1], point[0], point[1])
          );
        }
        previous = point;
      }
    }
    if (!probe || segments.length === 0) {
      throw new Error('A face loop sampled to nothing.');
    }
    return { segments, probe, bounds };
  });
  return { outer: loops[0]!, inner: loops.slice(1) };
}

function pointSegmentDistance(
  x: number,
  y: number,
  segment: Float64Array
): number {
  const x1 = segment[0]!;
  const y1 = segment[1]!;
  const dx = segment[2]! - x1;
  const dy = segment[3]! - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared)
        );
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function orientation(segment: Float64Array, x: number, y: number): number {
  return (
    (segment[2]! - segment[0]!) * (y - segment[1]!) -
    (segment[3]! - segment[1]!) * (x - segment[0]!)
  );
}

function segmentDistance(a: Float64Array, b: Float64Array): number {
  const crosses =
    orientation(b, a[0]!, a[1]!) * orientation(b, a[2]!, a[3]!) < 0 &&
    orientation(a, b[0]!, b[1]!) * orientation(a, b[2]!, b[3]!) < 0;
  if (crosses) return 0;
  return Math.min(
    pointSegmentDistance(a[0]!, a[1]!, b),
    pointSegmentDistance(a[2]!, a[3]!, b),
    pointSegmentDistance(b[0]!, b[1]!, a),
    pointSegmentDistance(b[2]!, b[3]!, a)
  );
}

/** Whether two loops' chords stay more than `clearance` apart everywhere. */
function loopsSeparated(
  left: PlaneLoop,
  right: PlaneLoop,
  clearance: number
): boolean {
  if (
    left.bounds[0] - right.bounds[2] > clearance ||
    right.bounds[0] - left.bounds[2] > clearance ||
    left.bounds[1] - right.bounds[3] > clearance ||
    right.bounds[1] - left.bounds[3] > clearance
  ) {
    return true;
  }
  for (const a of left.segments) {
    for (const b of right.segments) {
      if (segmentDistance(a, b) <= clearance) return false;
    }
  }
  return true;
}

/** Even-odd ray test against a closed segment soup. */
function insideLoop(point: [number, number], loop: PlaneLoop): boolean {
  const [x, y] = point;
  let inside = false;
  for (const segment of loop.segments) {
    const y1 = segment[1]!;
    const y2 = segment[3]!;
    if (y1 > y !== y2 > y) {
      const x1 = segment[0]!;
      const crossing = x1 + ((y - y1) * (segment[2]! - x1)) / (y2 - y1);
      if (crossing > x) inside = !inside;
    }
  }
  return inside;
}

function insideRegion(point: [number, number], region: PlaneRegion): boolean {
  return (
    insideLoop(point, region.outer) &&
    !region.inner.some((hole) => insideLoop(point, hole))
  );
}

/**
 * Whether the cap region lies inside the face region — on the face's
 * material, clear of its outer boundary and of every hole — with every loop
 * of each kept more than `clearance` from every loop of the other. Once that
 * separation holds no loop crosses another, so one probe point per loop
 * decides which side of the other region it lies on.
 */
function regionContains(
  face: PlaneRegion,
  cap: PlaneRegion,
  clearance: number
): boolean {
  const faceLoops = [face.outer, ...face.inner];
  for (const capLoop of [cap.outer, ...cap.inner]) {
    for (const faceLoop of faceLoops) {
      if (!loopsSeparated(capLoop, faceLoop, clearance)) return false;
    }
  }
  // The cap's outline stands on the face's material...
  if (!insideRegion(cap.outer.probe, face)) return false;
  // ...and no hole of the face opens under the cap's material. A hole inside
  // a counter of the cap (the eye of an "o") is not under it.
  return !face.inner.some((hole) => insideRegion(hole.probe, cap));
}

/**
 * Whether every tool cap lies wholly on ONE of the partner's coplanar faces,
 * decided from the loops themselves rather than by sampling the cap's
 * interior. A cap spanning two faces, touching or crossing a boundary, or
 * over any hole fails, and so does anything the kernel cannot sample.
 * Returns the caps' combined plane bounds `[minU, minV, maxU, maxV]` when
 * they all pass, null otherwise.
 */
function capsOnPartnerFaces(
  kernel: RemusKernel,
  partnerFaces: readonly number[],
  caps: readonly number[],
  plane: PlaneBasis,
  deflection: number,
  clearance: number
): [number, number, number, number] | null {
  let regions: PlaneRegion[];
  let capRegions: PlaneRegion[];
  try {
    regions = partnerFaces.map((face) =>
      planeRegion(kernel, face, plane, deflection)
    );
    capRegions = caps.map((cap) => planeRegion(kernel, cap, plane, deflection));
  } catch {
    return null;
  }
  const covered = capRegions.every(
    (capRegion) =>
      regions.filter((region) => regionContains(region, capRegion, clearance))
        .length === 1
  );
  if (!covered) return null;
  return capRegions.reduce<[number, number, number, number]>(
    (bounds, region) => [
      Math.min(bounds[0], region.outer.bounds[0]),
      Math.min(bounds[1], region.outer.bounds[1]),
      Math.max(bounds[2], region.outer.bounds[2]),
      Math.max(bounds[3], region.outer.bounds[3])
    ],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
}

/**
 * Whether the slab the pierce sweeps through is free of every partner face
 * but the ones that bound it by construction.
 *
 * The band runs from the sketch plane to `depth` past it along `direction`,
 * over the footprint's plane bounds. The coplanar faces themselves, and every
 * face sharing an edge with them (the walls the loop check already keeps the
 * cap clear of), are excluded; ANY other face whose bounds reach into the
 * band — the roof of a sealed cavity under an emboss, an internal void, an
 * overhang just above a cut — declines the retry. Bounds of bounds, so this
 * errs toward declining, and it needs no boolean: an intersect of the sliver
 * is the very coplanar Bezier boolean that refuses.
 */
function pierceBandClear(
  kernel: RemusKernel,
  partnerSolids: readonly number[],
  partnerFaces: readonly number[],
  footprint: readonly [number, number, number, number],
  plane: PlaneBasis,
  direction: Vec3,
  depth: number,
  tolerance: number
): boolean {
  const boundingEdges = new Set<number>();
  for (const face of partnerFaces) {
    for (const edge of Array.from(kernel.getFaceEdges(face))) {
      boundingEdges.add(edge);
    }
  }
  const excluded = new Set(partnerFaces);
  for (const solid of partnerSolids) {
    for (const face of Array.from(kernel.getSolidFaces(solid))) {
      if (excluded.has(face)) continue;
      if (
        Array.from(kernel.getFaceEdges(face)).some((edge) =>
          boundingEdges.has(edge)
        )
      ) {
        continue;
      }
      let bounds: Float64Array;
      try {
        bounds = tessellatedFaceBounds(kernel, face);
      } catch {
        return false;
      }
      // The face's box in the band's frame: (u, v) across the plane, w along
      // the pierce. Projecting all eight corners keeps it a superset.
      const range = [
        Infinity,
        Infinity,
        Infinity,
        -Infinity,
        -Infinity,
        -Infinity
      ];
      for (let corner = 0; corner < 8; corner += 1) {
        const dx = bounds[corner & 1 ? 3 : 0]! - plane.origin.x;
        const dy = bounds[corner & 2 ? 4 : 1]! - plane.origin.y;
        const dz = bounds[corner & 4 ? 5 : 2]! - plane.origin.z;
        const frame = [
          dx * plane.u.x + dy * plane.u.y + dz * plane.u.z,
          dx * plane.v.x + dy * plane.v.y + dz * plane.v.z,
          dx * direction.x + dy * direction.y + dz * direction.z
        ];
        for (let axis = 0; axis < 3; axis += 1) {
          range[axis] = Math.min(range[axis]!, frame[axis]!);
          range[axis + 3] = Math.max(range[axis + 3]!, frame[axis]!);
        }
      }
      const inBand =
        range[0]! <= footprint[2] + tolerance &&
        range[3]! >= footprint[0] - tolerance &&
        range[1]! <= footprint[3] + tolerance &&
        range[4]! >= footprint[1] - tolerance &&
        range[5]! > tolerance &&
        range[2]! < depth + tolerance;
      if (inBand) return false;
    }
  }
  return true;
}

export interface PierceGateInput {
  /** The body the tool is cut from or united with: its material. */
  partnerSolids: readonly number[];
  /** The plain (user-distance) tool. */
  toolSolids: readonly number[];
  /** The sketch plane, where the tool's start cap lies. */
  plane: PlaneBasis;
  /** Unit direction the pierce travel extends the tool: across the plane. */
  direction: Vec3;
  /** `cut` pierces into air; `add` pierces into the partner's material. */
  mode: 'cut' | 'add';
  travel: number;
}

/**
 * Whether piercing the tool by `travel` along `direction` leaves the
 * boolean's result unchanged:
 *
 * 1. the partner has a planar face in the sketch plane (the remus#953
 *    trigger — without it there is nothing to work around);
 * 2. the tool has its start cap in that plane;
 * 3. DECIDING: every cap lies wholly on a single one of those partner faces,
 *    proved from the loops themselves — inside the face's outer loop, clear
 *    of every hole, each cap loop more than the sampling allowance plus
 *    tolerance from every face loop. The face then covers the whole
 *    footprint, and no pre-existing hole or recess, however small, sits under
 *    it for the sliver to fill or cut;
 * 4. DECIDING: the band the sliver sweeps — `travel` deep, over the
 *    footprint — meets no partner face but the coplanar ones and their
 *    neighbours, so nothing lies inside the sliver's thickness either: no
 *    sealed cavity under a thin roof, no void, no overhang
 *    (`pierceBandClear`);
 * 5. GUARD: at sampled interior points of the cap the partner's material lies
 *    on the expected side of the plane — for a cut, air on the pierce side
 *    and material on the tool side; for an add, the reverse. This says which
 *    side of the face is air, which a Remus face normal cannot.
 *
 * Anything the kernel cannot sample or classify, or that lands on a
 * boundary, fails the gate: the original refusal stands.
 */
export function pierceGateHolds(
  kernel: RemusKernel,
  input: PierceGateInput
): boolean {
  const scale = modelScale(kernel, [
    ...input.partnerSolids,
    ...input.toolSolids
  ]);
  const tolerance = COPLANAR_TOLERANCES * geometryTolerance(scale);
  const partnerFaces = coplanarFaces(
    kernel,
    input.partnerSolids,
    input.plane,
    tolerance
  );
  if (partnerFaces.length === 0) return false;
  const caps = coplanarFaces(kernel, input.toolSolids, input.plane, tolerance);
  if (caps.length === 0) return false;
  // Chords within a tenth of the travel of the true curves. Either side of a
  // clearance can be off by that much, so loops must stay twice that plus the
  // coplanar tolerance apart; closer than that counts as touching.
  const deflection = input.travel / 10;
  const footprint = capsOnPartnerFaces(
    kernel,
    partnerFaces,
    caps,
    input.plane,
    deflection,
    2 * deflection + tolerance
  );
  if (!footprint) return false;
  if (
    !pierceBandClear(
      kernel,
      input.partnerSolids,
      partnerFaces,
      footprint,
      input.plane,
      input.direction,
      input.travel,
      tolerance
    )
  ) {
    return false;
  }
  const samples = capSamples(kernel, caps);
  if (samples.length === 0) return false;
  const half = input.travel / 2;
  for (const sample of samples) {
    const pierceSide = insideAny(
      kernel,
      input.partnerSolids,
      offsetPoint(sample, input.direction, half)
    );
    const toolSide = insideAny(
      kernel,
      input.partnerSolids,
      offsetPoint(sample, input.direction, -half)
    );
    if (pierceSide === null || toolSide === null) return false;
    const expected = input.mode === 'add';
    if (pierceSide !== expected || toolSide !== !expected) return false;
  }
  return true;
}

/**
 * The extrude feature rebuilt with `travel` of back distance: a transient
 * node for the sweep builder, never written to the document. Null for an
 * extrude whose start cap is not on its sketch plane (symmetric, or already
 * two-sided), where the coplanar trigger cannot be the start cap.
 */
function piercedFeatureNode(
  feature: FeatureNode,
  scope: Record<string, number>,
  travel: number
): FeatureNode | null {
  const data = feature.data;
  if (data.featureKind !== 'extrude' || data.symmetric) return null;
  if (
    data.backDistance !== undefined &&
    resolveParamValue(data.backDistance, scope, 'back distance') !== 0
  ) {
    return null;
  }
  return { ...feature, data: { ...data, backDistance: travel } };
}

/**
 * The pierced twin of an extrude's tool, or null when the gate does not hold.
 * `partnerSolids` is the body the extrude is combined with; `toolSolids` is
 * the plain tool as built from the user's distance.
 */
export function piercedExtrudeTool(
  ctx: Pick<FeatureBuildContext, 'kernel' | 'document' | 'scope' | 'result'>,
  feature: FeatureNode,
  partnerSolids: readonly number[],
  toolSolids: readonly number[],
  mode: 'cut' | 'add'
): ExactShape | null {
  const { kernel, document, scope, result } = ctx;
  if (feature.data.featureKind !== 'extrude') return null;
  const data: FeatureDataOf<'extrude'> = feature.data;
  const plane = result.sketchBases.get(data.sketchId);
  if (!plane) return null;
  const distance = resolveParamValue(
    data.distance,
    scope,
    'distance',
    document.units
  );
  if (distance === 0) return null;
  const travel = pierceTravel(
    modelScale(kernel, [...partnerSolids, ...toolSolids])
  );
  const node = piercedFeatureNode(feature, scope, travel);
  if (!node) return null;
  // The tool runs from the plane along sign(distance) × normal; the pierce
  // runs the other way, across the plane.
  const sign = distance < 0 ? -1 : 1;
  const direction = {
    x: -sign * plane.normal.x,
    y: -sign * plane.normal.y,
    z: -sign * plane.normal.z
  };
  if (
    !pierceGateHolds(kernel, {
      partnerSolids,
      toolSolids,
      plane,
      direction,
      mode,
      travel
    })
  ) {
    return null;
  }
  // Advisory warnings (a flattened outline, say) were already raised by the
  // plain build of this very feature; the twin must not raise them twice.
  return buildSweep(
    kernel,
    document,
    node,
    scope,
    result.sketchBases,
    () => {}
  );
}

/**
 * The pierced twin of a body the boolean feature combines, when that body is
 * still exactly the tool a new-body extrude produced. The handle comparison
 * is the proof: any feature that moved, edited or replaced the body produced
 * new handles, and then nothing about the extrude describes it any more.
 */
export function piercedBodyTool(
  ctx: Pick<FeatureBuildContext, 'kernel' | 'document' | 'scope' | 'result'>,
  shape: ExactShape,
  partnerSolids: readonly number[],
  mode: 'cut' | 'add'
): ExactShape | null {
  const source = shape.sweepSource;
  if (
    !source ||
    source.solids.length !== shape.solids.length ||
    source.solids.some((solid, index) => solid !== shape.solids[index])
  ) {
    return null;
  }
  const feature = findFeature(ctx.document, source.featureId);
  if (!feature) return null;
  return piercedExtrudeTool(ctx, feature, partnerSolids, shape.solids, mode);
}
