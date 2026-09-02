import { geometryTolerance } from '@openzcad/geometry';
import type {
  BodyId,
  FaceTopology,
  FeatureWarning,
  Vector3
} from '@openzcad/shared';
import type { AffectedFeatureTarget } from '../affectedFeatureTargets';
import { directEditRejection } from '../directEdit';
import { splitRefusal, validatedFeatureRejection } from '../featureValidation';
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
        warnings: input.derived.warnings,
        ...(input.derived.featureWarnings
          ? { featureWarnings: input.derived.featureWarnings }
          : {}),
        bodyPresent: Boolean(
          input.derived.bodyRepresentations[target.resultBodyId]
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

  const message = directEditRejection({
    label: input.label,
    warnings: input.derived.warnings,
    ...(input.derived.featureWarnings
      ? { featureWarnings: input.derived.featureWarnings }
      : {}),
    bodyPresent: Boolean(input.derived.bodyRepresentations[input.bodyId]),
    documentMoved: input.documentMoved
  });
  return message ? splitRefusal(message) : null;
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
  offset: number
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
    if (Math.abs(dot(fromExpected, targetNormal)) > linearTolerance) {
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
