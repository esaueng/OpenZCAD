import {
  EXTRUDE_TO_FACE_UNRESOLVED,
  MAX_EXTRUDE_DRAFT_DEG,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import type { PlaneBasis, Vec3 } from '@openzcad/geometry';
import type { FeatureNode, ProjectDocument } from '@openzcad/shared';

import type { RemusKernel } from './remus-runtime';
import type { ExactBuildResult } from './exact-types';
import {
  faceAttachmentCandidatesForShape,
  bodyName
} from './exact-shape-utils';
import { resolveFaceAttachment } from './face-attachment';
import { measureFaceGeometry } from './exact-measure';
import { requireValidSolid } from './kernel-validation';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';

type ExtrudeData = Extract<FeatureNode['data'], { featureKind: 'extrude' }>;

/**
 * How far from parallel a to-face target may lean, as the sine of the angle
 * between its normal and the sketch normal. A face leaning more than this
 * meets the profile's walls at different heights, which is a different
 * extent (up to a slanted face) than this slice builds, so it refuses.
 */
const PARALLEL_SINE_LIMIT = 1e-6;

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function unresolved(detail: string): Error {
  return new Error(`${EXTRUDE_TO_FACE_UNRESOLVED} ${detail}`);
}

/**
 * F01 (v29): the signed distance from the sketch plane to the stored target
 * face along the resolved sketch normal, at the feature's history position.
 *
 * The face is re-found only through its verified lineage (the R01 face
 * resolver, which never falls back to a hash or the stored snapshot), and the
 * distance is derived from where it is now, so moving the face moves the
 * extent. Every way the target can fail — its body unavailable here, the
 * face deleted, ambiguous, no longer planar, no longer parallel, or lying on
 * the sketch plane — refuses with {@link EXTRUDE_TO_FACE_UNRESOLVED} first,
 * which the app reads as the unresolved state a re-pick repairs.
 */
export function toFaceDistance(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  data: ExtrudeData,
  result: Pick<ExactBuildResult, 'shapes' | 'consumed' | 'sketchBases'>
): number {
  const target = data.toFace;
  if (!target) {
    throw unresolved('this extrude to a face names no face.');
  }
  const basis = result.sketchBases.get(data.sketchId);
  if (!basis) {
    throw new Error('Extrude sketch plane did not resolve.');
  }
  if (!document.bodyOrder.includes(target.bodyId)) {
    throw unresolved('the body that carried the face was deleted.');
  }
  const owner = bodyName(document, target.bodyId);
  if (result.consumed.has(target.bodyId)) {
    throw unresolved(
      `${owner}, which carried the face, was consumed earlier in history.`
    );
  }
  const shape = result.shapes.get(target.bodyId);
  if (!shape) {
    throw unresolved(
      `${owner}, which carried the face, is not available at this point in history.`
    );
  }
  const source = listFeaturesInOrder(document).find(
    (candidate) =>
      candidate.featureId === target.faceReference.producingFeatureId
  );
  let frame;
  try {
    frame = resolveFaceAttachment({
      reference: target.faceReference,
      candidates: faceAttachmentCandidatesForShape(kernel, shape),
      snapshot: target,
      sketchName: feature.name,
      ownerKind: 'Extrude',
      sourceFeatureName:
        source?.name ?? String(target.faceReference.producingFeatureId)
    });
  } catch (error) {
    throw unresolved(error instanceof Error ? error.message : String(error));
  }
  const alignment = dot(frame.zAxis, basis.normal);
  if (Math.sqrt(Math.max(0, 1 - alignment * alignment)) > PARALLEL_SINE_LIMIT) {
    throw unresolved(
      'the face is no longer parallel to the sketch plane; pick a face parallel to the sketch.'
    );
  }
  const distance = dot(sub(frame.origin, basis.origin), basis.normal);
  const tolerance = 1e-9 * Math.max(1, Math.abs(distance));
  if (!Number.isFinite(distance) || Math.abs(distance) <= tolerance) {
    throw unresolved(
      'the face lies on the sketch plane, so there is nothing to extrude.'
    );
  }
  return distance;
}

/**
 * The blind extrude a to-face extrude stands for at this history position:
 * the derived distance replaces the dormant one, and the extent fields are
 * dropped so the sweep, overlap check and boolean treat it as the blind
 * extrude it now is. The stored feature is never rewritten.
 */
export function toFaceSweepFeature(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  data: ExtrudeData,
  result: Pick<ExactBuildResult, 'shapes' | 'consumed' | 'sketchBases'>
): FeatureNode {
  const distance = toFaceDistance(kernel, document, feature, data, result);
  const { endCondition: _endCondition, toFace: _toFace, ...rest } = data;
  return { ...feature, data: { ...rest, distance } };
}

/**
 * The draft angle a feature carries, resolved; zero for straight walls. An
 * expression resolves here, so its range is checked here too.
 */
export function resolveExtrudeDraftDeg(
  data: ExtrudeData,
  scope: Record<string, number>,
  document: ProjectDocument
): number {
  if (data.draftAngleDeg === undefined) return 0;
  const angle = resolveParamValue(
    data.draftAngleDeg,
    scope,
    'draft angle',
    document.units
  );
  if (!Number.isFinite(angle) || Math.abs(angle) >= MAX_EXTRUDE_DRAFT_DEG) {
    throw new Error(
      `Draft angle must be between -${MAX_EXTRUDE_DRAFT_DEG} and ${MAX_EXTRUDE_DRAFT_DEG} degrees.`
    );
  }
  return angle;
}

/** Why a drafted extrusion is hash-only: see `draftExtrudedSolids`. */
export const DRAFTED_EXTRUDE_HASH_ONLY_REASON =
  'A drafted extrude publishes hash-only references: its walls are tilted by a kernel draft (or rebuilt as a cone), and Remus exposes no verified face evolution for a draft, so the straight-wall extrude roles do not carry over.';

const PARALLEL_DOT = 1 - 1e-9;
const PERPENDICULAR_DOT = 1e-9;

interface FaceClass {
  readonly handle: number;
  readonly role: 'cap' | 'wall';
  readonly surfaceType: string;
}

function classifyFaces(
  kernel: RemusKernel,
  solid: number,
  pull: Vec3,
  label: string
): FaceClass[] {
  return Array.from(kernel.getSolidFaces(solid), (handle) => {
    const surfaceType = kernel.getSurfaceType(handle).toLowerCase();
    if (surfaceType === 'plane') {
      const normal = kernel.getFaceNormal(handle);
      const alignment = Math.abs(
        normal[0]! * pull.x + normal[1]! * pull.y + normal[2]! * pull.z
      );
      if (alignment >= PARALLEL_DOT) {
        return { handle, role: 'cap' as const, surfaceType };
      }
      if (alignment <= PERPENDICULAR_DOT) {
        return { handle, role: 'wall' as const, surfaceType };
      }
    } else if (surfaceType === 'cylinder') {
      const geometry = measureFaceGeometry(kernel, handle);
      if (geometry?.axisStart && geometry.axisEnd) {
        const axis = sub(geometry.axisEnd, geometry.axisStart);
        const length = Math.hypot(axis.x, axis.y, axis.z);
        if (length > 0 && Math.abs(dot(axis, pull)) / length >= PARALLEL_DOT) {
          return { handle, role: 'wall' as const, surfaceType };
        }
      }
    }
    throw new Error(
      `${label} cannot be drafted: one of its faces is neither a cap nor a wall along the extrusion.`
    );
  });
}

/**
 * A circular wall cannot go through the kernel draft (it drafts planar faces
 * only), so the drafted solid is the ruled loft between the two cap circles,
 * whose radii follow the taper from the neutral plane. The loft of two
 * coaxial circles is an exact cone with planar caps.
 */
function draftCircularWall(
  kernel: RemusKernel,
  wall: number,
  neutral: PlaneBasis,
  pull: Vec3,
  tangent: number,
  label: string
): number {
  const geometry = measureFaceGeometry(kernel, wall);
  if (!geometry?.axisStart || !geometry.axisEnd || !geometry.radius) {
    throw new Error(
      `${label} cannot be drafted: its round wall has no exact measurements.`
    );
  }
  const radius = geometry.radius;
  const axisPoint = geometry.axisStart;
  const height = (point: Vec3) => dot(sub(point, neutral.origin), pull);
  const heights = [height(geometry.axisStart), height(geometry.axisEnd)].sort(
    (a, b) => a - b
  );
  const faces = heights.map((at) => {
    const shift = at - height(axisPoint);
    const center = {
      x: axisPoint.x + pull.x * shift,
      y: axisPoint.y + pull.y * shift,
      z: axisPoint.z + pull.z * shift
    };
    const tapered = radius - at * tangent;
    if (!(tapered > 0)) {
      throw new Error(
        `${label} cannot be drafted: the taper closes the round wall to a point before the extrusion ends.`
      );
    }
    const edge = kernel.makeCircleEdge(
      center.x,
      center.y,
      center.z,
      pull.x,
      pull.y,
      pull.z,
      tapered
    );
    return kernel.makePlanarFaceFromWire(
      kernel.makeWire(Uint32Array.of(edge), true)
    );
  });
  return kernel.loftWithOptions(
    Uint32Array.from(faces),
    JSON.stringify({ ruled: true })
  );
}

/**
 * F01 (v29): taper each straight-swept solid's walls by `angleDeg` about the
 * neutral (sketch) plane, along `pull` (the unit direction the extrusion
 * leaves the sketch in). Positive narrows the section away from the plane.
 *
 * Walls that are all planar go through the kernel draft, one call per solid,
 * with the neutral line on the sketch plane so the profile keeps its size.
 * A single circular wall is rebuilt as the exact cone between its tapered
 * cap circles. Anything else — a profile mixing arcs and lines, or a round
 * wall with a hole — refuses by name rather than approximating. A taper
 * that closes the section up, or any result the solid gate rejects, refuses
 * too; so does a result whose volume did not move the way the taper says.
 */
export function draftExtrudedSolids(
  kernel: RemusKernel,
  solids: readonly number[],
  neutral: PlaneBasis,
  pull: Vec3,
  angleDeg: number,
  label: string
): number[] {
  const tangent = Math.tan((angleDeg * Math.PI) / 180);
  return solids.map((solid) => {
    const faces = classifyFaces(kernel, solid, pull, label);
    const walls = faces.filter((face) => face.role === 'wall');
    const caps = faces.filter((face) => face.role === 'cap');
    const before = kernel.volume(solid, MEASUREMENT_DEFLECTION);
    let drafted: number;
    try {
      if (
        walls.length > 0 &&
        walls.every((wall) => wall.surfaceType === 'plane')
      ) {
        drafted = kernel.draft(
          solid,
          Uint32Array.from(walls.map((wall) => wall.handle)),
          pull.x,
          pull.y,
          pull.z,
          neutral.origin.x,
          neutral.origin.y,
          neutral.origin.z,
          // The kernel's positive angle flares the walls outward.
          -angleDeg
        );
      } else if (walls.length === 1 && caps.length === 2) {
        drafted = draftCircularWall(
          kernel,
          walls[0]!.handle,
          neutral,
          pull,
          tangent,
          label
        );
      } else {
        throw new Error(
          `${label} cannot be drafted: draft needs straight-edged walls or one circular wall, and this profile mixes curved and straight walls or has a round hole.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        message.startsWith(label)
          ? message
          : `${label} could not be drafted by ${angleDeg} degrees: ${message}`,
        { cause: error }
      );
    }
    requireValidSolid(
      kernel,
      drafted,
      `${label} drafted by ${angleDeg} degrees is not a valid closed solid; reduce the angle or the distance.`
    );
    const after = kernel.volume(drafted, MEASUREMENT_DEFLECTION);
    const facesAfter = kernel.getSolidFaces(drafted).length;
    if (
      !Number.isFinite(after) ||
      after <= 0 ||
      facesAfter !== faces.length ||
      (angleDeg > 0 ? after >= before : after <= before)
    ) {
      throw new Error(
        `${label} drafted by ${angleDeg} degrees closes up or turns inside out before the extrusion ends; reduce the angle or the distance.`
      );
    }
    return drafted;
  });
}
