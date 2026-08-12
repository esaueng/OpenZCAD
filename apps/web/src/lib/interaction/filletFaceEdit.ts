import { findFeature } from '@openzcad/document-core';
import { geometryTolerance } from '@openzcad/geometry';
import type {
  BodyRepresentation,
  FaceGeometry,
  FaceTopology,
  FeatureId,
  FeatureNode,
  ProjectDocument,
  TopologySelection,
  Vector3
} from '@openzcad/shared';

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

function subtract(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z
  };
}

function addScaled(point: Vector3, direction: Vector3, scale: number): Vector3 {
  return {
    x: point.x + direction.x * scale,
    y: point.y + direction.y * scale,
    z: point.z + direction.z * scale
  };
}

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function distance(left: Vector3, right: Vector3): number {
  return length(subtract(left, right));
}

/** A blend is editable only when exact lineage names a live Fillet feature. */
export function editableFilletFeature(
  document: ProjectDocument,
  face: FaceTopology
): FeatureNode | null {
  const producingFeatureId = face.reference?.producingFeatureId;
  if (
    face.geometry?.featureType !== 'blend' ||
    face.geometry.blendRadius === undefined ||
    !Number.isFinite(face.geometry.blendRadius) ||
    face.geometry.blendRadius <= 0 ||
    !producingFeatureId
  ) {
    return null;
  }
  const feature = findFeature(document, producingFeatureId);
  return feature?.data.featureKind === 'fillet' ? feature : null;
}

/**
 * The imported-body defeature fallback is honest only when removing this
 * blend leaves the kernel's currently supported all-planar face set.
 */
export function canRemoveImportedBlendFace(
  body: BodyRepresentation,
  face: FaceTopology
): boolean {
  return (
    body.source === 'imported-step' &&
    face.geometry?.featureType === 'blend' &&
    (body.topology?.faces ?? []).every(
      (candidate) =>
        candidate.topologyId === face.topologyId ||
        candidate.geometry?.surfaceType === 'plane'
    )
  );
}

/** Exact analytic radial direction for the on-face fillet handle. */
export function blendRadialDirection(
  geometry: FaceGeometry,
  point: Vector3,
  fallback: Vector3
): Vector3 | null {
  if (
    geometry.surfaceType === 'torus' &&
    geometry.torusCenter &&
    geometry.axis &&
    geometry.majorRadius !== undefined
  ) {
    const axis = normalized(geometry.axis);
    if (axis) {
      const fromCenter = subtract(point, geometry.torusCenter);
      const inRingPlane = addScaled(fromCenter, axis, -dot(fromCenter, axis));
      const ringDirection = normalized(inRingPlane);
      if (ringDirection) {
        const tubeCenter = addScaled(
          geometry.torusCenter,
          ringDirection,
          geometry.majorRadius
        );
        const radial = normalized(subtract(point, tubeCenter));
        if (radial) {
          return radial;
        }
      }
    }
  }
  if (
    geometry.surfaceType === 'cylinder' &&
    geometry.axisStart &&
    geometry.axisEnd
  ) {
    const axis = normalized(subtract(geometry.axisEnd, geometry.axisStart));
    if (axis) {
      const fromStart = subtract(point, geometry.axisStart);
      const onAxis = addScaled(geometry.axisStart, axis, dot(fromStart, axis));
      const radial = normalized(subtract(point, onAxis));
      if (radial) {
        return radial;
      }
    }
  }
  return normalized(fallback);
}

/**
 * Re-resolves a changed fillet face without consulting its unstable hash.
 * Producing feature plus blend classification is mandatory; the frozen
 * analytic carrier/centre only disambiguates multiple faces from one feature.
 */
export function resolveFilletBlendFace(
  faces: readonly FaceTopology[],
  producingFeatureId: FeatureId,
  sourceGeometry: FaceGeometry | undefined
): FaceTopology | null {
  const produced = faces.filter(
    (face) =>
      face.geometry?.featureType === 'blend' &&
      face.reference?.producingFeatureId === producingFeatureId
  );
  if (produced.length === 0) {
    return null;
  }
  const sameCarrier = sourceGeometry
    ? produced.filter(
        (face) => face.geometry?.surfaceType === sourceGeometry.surfaceType
      )
    : produced;
  const candidates = sameCarrier.length > 0 ? sameCarrier : produced;
  if (candidates.length === 1 || !sourceGeometry) {
    return candidates.length === 1 ? candidates[0]! : null;
  }
  const ranked = candidates
    .map((face) => ({
      face,
      score:
        distance(face.geometry!.center, sourceGeometry.center) +
        (face.geometry?.torusCenter && sourceGeometry.torusCenter
          ? distance(face.geometry.torusCenter, sourceGeometry.torusCenter)
          : 0)
    }))
    .sort((left, right) => left.score - right.score);
  const closest = ranked[0];
  if (!closest) {
    return null;
  }
  const scale = Math.max(1, length(sourceGeometry.center), closest.score);
  const next = ranked[1];
  return next &&
    Math.abs(next.score - closest.score) <= geometryTolerance(scale) * 8
    ? null
    : closest.face;
}

/** Computes creation-only cyan faces once, when an exact preview publishes. */
export function newBlendFaceSelections(
  base: ProjectDocument,
  preview: ProjectDocument['derived']
): TopologySelection[] {
  const baseHashes = new Set(
    Object.values(base.derived.bodyRepresentations).flatMap((body) =>
      (body.topology?.faces ?? []).map((face) => face.hash)
    )
  );
  return Object.values(preview.bodyRepresentations).flatMap((body) =>
    body.consumed
      ? []
      : (body.topology?.faces ?? []).flatMap((face) =>
          face.geometry?.featureType === 'blend' && !baseHashes.has(face.hash)
            ? [
                {
                  bodyId: body.bodyId,
                  kind: 'face' as const,
                  topologyId: face.topologyId,
                  hash: face.hash,
                  ...(face.reference ? { reference: face.reference } : {})
                }
              ]
            : []
        )
  );
}
