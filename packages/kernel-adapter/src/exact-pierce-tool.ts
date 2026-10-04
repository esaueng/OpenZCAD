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
 * Ceiling on the cap triangles sampled by the side test. A glyph cap
 * tessellates to a few hundred; the stride keeps a pathological cap from
 * turning a refusal into a long stall.
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
 * Whether piercing the tool by `travel` along `direction` provably leaves the
 * boolean's result unchanged, to the extent the kernel can be asked:
 *
 * 1. the partner has a planar face in the sketch plane (the remus#953
 *    trigger — without it there is nothing to work around);
 * 2. the tool has its start cap in that plane;
 * 3. at every sampled interior point of that cap, the partner's material lies
 *    on exactly the expected side of the plane: for a cut, air on the pierce
 *    side and material on the tool side; for an add, material on the pierce
 *    side and air on the tool side. That is the footprint sitting on a
 *    boundary face of the partner, so the pierced sliver lies wholly in air
 *    (cut) or wholly in material (add) and cannot change the result.
 *
 * Any sample the kernel cannot classify, or that lands on a boundary, fails
 * the gate: the original refusal stands.
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
  if (
    coplanarFaces(kernel, input.partnerSolids, input.plane, tolerance)
      .length === 0
  ) {
    return false;
  }
  const caps = coplanarFaces(kernel, input.toolSolids, input.plane, tolerance);
  if (caps.length === 0) return false;
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
