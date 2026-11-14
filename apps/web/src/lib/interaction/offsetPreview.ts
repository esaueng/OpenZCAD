import { geometryTolerance } from '@openzcad/geometry';
import { ownEntry } from '@openzcad/shared';
import type {
  BodyId,
  FaceTopology,
  FeatureWarning,
  Vector3
} from '@openzcad/shared';
import type { AffectedFeatureTarget } from '../affectedFeatureTargets';
import { createdFeatureId, directEditRejection } from '../directEdit';
import {
  refusingWarningDetail,
  splitRefusal,
  validatedFeatureRejection
} from '../featureValidation';
import type { CommandDiagnostic } from './machine';

export interface OffsetPreviewFaceTarget {
  /** World-space point originally picked on the face. */
  point: Vector3;
  /** Outward unit-ish normal captured by the pick. */
  normal: Vector3;
  /** Frozen measured face center, used only to disambiguate coplanar faces. */
  center?: Vector3;
}

export interface OffsetPreviewVerdictInput {
  label: string;
  bodyId: BodyId;
  /**
   * The command the preview applied. A command that adds one feature has its
   * warnings attributed by that feature's id, not by the shared label.
   */
  command?: { readonly payload: unknown };
  validationTargets?: readonly AffectedFeatureTarget[];
  derived: {
    bodyRepresentations: Partial<Record<BodyId, unknown>>;
    warnings: readonly string[];
    featureWarnings?: readonly FeatureWarning[];
  };
  documentMoved: boolean;
}

/** Applies the final direct-edit safety verdict to an ephemeral offset preview. */
export function offsetPreviewRejection(
  input: OffsetPreviewVerdictInput
): CommandDiagnostic | null {
  if (input.validationTargets) {
    for (const target of input.validationTargets) {
      const rejection = validatedFeatureRejection({
        featureName: target.featureName,
        featureId: target.featureId,
        ...(target.dependent ? { dependent: true } : {}),
        warnings: input.derived.warnings,
        ...(input.derived.featureWarnings
          ? { featureWarnings: input.derived.featureWarnings }
          : {}),
        bodyPresent: Boolean(
          ownEntry(input.derived.bodyRepresentations, target.resultBodyId)
        ),
        documentMoved: input.documentMoved
      });
      if (rejection) {
        return rejection;
      }
    }
    if (input.validationTargets.length === 0 && input.documentMoved) {
      return {
        message: 'The document changed while the preview was rebuilding.'
      };
    }
    return null;
  }

  const featureId = input.command ? createdFeatureId(input.command) : undefined;
  const message = directEditRejection({
    label: input.label,
    warnings: input.derived.warnings,
    ...(input.derived.featureWarnings
      ? { featureWarnings: input.derived.featureWarnings }
      : {}),
    ...(featureId ? { featureId } : {}),
    bodyPresent: Boolean(
      ownEntry(input.derived.bodyRepresentations, input.bodyId)
    ),
    documentMoved: input.documentMoved
  });
  const warning = refusingWarningDetail(
    input.label,
    input.derived.warnings,
    input.derived.featureWarnings,
    featureId
  );
  if (!message) return null;
  const limit = warning?.kernelRefusal?.limit;
  return {
    ...splitRefusal(message, warning?.kernelRefusal ?? warning?.category),
    // How far the face can go, when the kernel named it: the chip shows it
    // and the way out offers the value just inside it.
    ...(limit !== undefined ? { limit } : {})
  };
}

function length(vector: Vector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalized(vector: Vector3): Vector3 | null {
  const magnitude = length(vector);
  if (
    !Number.isFinite(magnitude) ||
    magnitude <= geometryTolerance(magnitude)
  ) {
    return null;
  }
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude
  };
}

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function translated(point: Vector3, normal: Vector3, offset: number): Vector3 {
  return {
    x: point.x + normal.x * offset,
    y: point.y + normal.y * offset,
    z: point.z + normal.z * offset
  };
}

function distance(left: Vector3, right: Vector3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

/**
 * Finds the planar face moved by an exact offset preview after topology IDs
 * and hashes have both changed.
 *
 * The operation's immutable witnesses are stronger than mesh order: the face
 * remains on the source plane translated by the requested signed distance.
 * A frozen center breaks ties between distinct coplanar faces. If that still
 * leaves an indistinguishable pair, resolution fails closed instead of
 * tinting unrelated material cyan.
 */
export function resolveOffsetPreviewFace(
  faces: readonly FaceTopology[],
  target: OffsetPreviewFaceTarget,
  offset: number,
  /**
   * Extra distance, in model units, the face's plane may sit from the
   * expected one: how far a stored value's rounding can move it.
   */
  planeSlack = 0
): FaceTopology | null {
  if (!Number.isFinite(offset)) {
    return null;
  }
  const targetNormal = normalized(target.normal);
  if (!targetNormal) {
    return null;
  }
  const expectedPlanePoint = translated(target.point, targetNormal, offset);
  const expectedCenter = target.center
    ? translated(target.center, targetNormal, offset)
    : expectedPlanePoint;
  const scale = Math.max(
    1,
    length(expectedPlanePoint),
    length(expectedCenter),
    Math.abs(offset)
  );
  const linearTolerance = geometryTolerance(scale) * 8;
  const planeTolerance = linearTolerance + Math.max(0, planeSlack);
  const angularTolerance = geometryTolerance(1) * 8;

  const matches = faces.flatMap((face) => {
    const geometry = face.geometry;
    const normal = geometry?.normal ? normalized(geometry.normal) : null;
    if (geometry?.surfaceType !== 'plane' || !normal) {
      return [];
    }
    if (1 - Math.abs(dot(targetNormal, normal)) > angularTolerance) {
      return [];
    }
    const fromExpected = {
      x: geometry.center.x - expectedPlanePoint.x,
      y: geometry.center.y - expectedPlanePoint.y,
      z: geometry.center.z - expectedPlanePoint.z
    };
    if (Math.abs(dot(fromExpected, targetNormal)) > planeTolerance) {
      return [];
    }
    return [{ face, score: distance(geometry.center, expectedCenter) }];
  });
  matches.sort((left, right) => left.score - right.score);
  const closest = matches[0];
  if (!closest) {
    return null;
  }
  const next = matches[1];
  if (next && Math.abs(next.score - closest.score) <= linearTolerance) {
    return null;
  }
  return closest.face;
}

/**
 * The resolution a committed face offset is stored at (faceOffsetPlan rounds
 * a drag, an extrude distance or a box side to 0.001 of a model unit), so a
 * committed face can land up to half of it from the dragged plane.
 */
export const COMMITTED_OFFSET_RESOLUTION = 0.001;

/**
 * Finds the face a committed offset moved, and how far it actually moved.
 *
 * The commit stores a rounded value: a +1 mm drag on an 8.1234 mm extrusion
 * stores 9.123 mm, so its cap lands 0.9996 mm from where it was picked. The
 * exact plane is tried first; failing that, the plane may sit within the
 * stored value's rounding, still failing closed on an indistinguishable
 * pair. The returned displacement is measured on the face found, so a handle
 * re-armed on it starts from where the face really is.
 */
export function resolveCommittedOffsetFace(
  faces: readonly FaceTopology[],
  target: OffsetPreviewFaceTarget,
  offset: number
): { face: FaceTopology; displacement: number } | null {
  const face =
    resolveOffsetPreviewFace(faces, target, offset) ??
    resolveOffsetPreviewFace(
      faces,
      target,
      offset,
      COMMITTED_OFFSET_RESOLUTION / 2
    );
  const normal = normalized(target.normal);
  if (!face?.geometry || !normal) return null;
  const displacement = dot(
    {
      x: face.geometry.center.x - target.point.x,
      y: face.geometry.center.y - target.point.y,
      z: face.geometry.center.z - target.point.z
    },
    normal
  );
  return Number.isFinite(displacement) ? { face, displacement } : null;
}
