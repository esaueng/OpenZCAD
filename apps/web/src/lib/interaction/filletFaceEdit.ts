import { findFeature } from '@openzcad/document-core';
import { geometryTolerance } from '@openzcad/geometry';
import type {
  BodyRepresentation,
  FaceGeometry,
  FaceTopology,
  FeatureNode,
  ProjectDocument,
  TopologySelection,
  Vector3
} from '@openzcad/shared';

const FILLET_FACE_LINEAGE_PREFIX = 'modifier.fillet.face.band-between.';

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

function hasFilletFaceEvolutionLineage(face: FaceTopology): boolean {
  const reference = face.reference;
  return Boolean(
    reference &&
    reference.lineageName.startsWith(FILLET_FACE_LINEAGE_PREFIX) &&
    reference.lineageName.length > FILLET_FACE_LINEAGE_PREFIX.length
  );
}

function hasSameLineage(left: FaceTopology, right: FaceTopology): boolean {
  return Boolean(
    left.reference &&
    right.reference &&
    left.reference.producingFeatureId === right.reference.producingFeatureId &&
    left.reference.lineageName === right.reference.lineageName
  );
}

/** A blend is editable only when one evolution identity names a live Fillet. */
export function editableFilletFeature(
  document: ProjectDocument,
  face: FaceTopology,
  faces: readonly FaceTopology[]
): FeatureNode | null {
  const producingFeatureId = face.reference?.producingFeatureId;
  if (
    face.geometry?.featureType !== 'blend' ||
    face.geometry.blendRadius === undefined ||
    !Number.isFinite(face.geometry.blendRadius) ||
    face.geometry.blendRadius <= 0 ||
    !producingFeatureId ||
    !hasFilletFaceEvolutionLineage(face) ||
    faces.filter((candidate) => hasSameLineage(candidate, face)).length !== 1
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
 * Re-resolves a changed fillet face by its exact evolution identity. Hashes,
 * carrier type, and geometric proximity are deliberately not fallbacks: a
 * missing or duplicate identity leaves the edit unarmed.
 */
export function resolveFilletBlendFace(
  faces: readonly FaceTopology[],
  source: FaceTopology
): FaceTopology | null {
  if (!hasFilletFaceEvolutionLineage(source)) {
    return null;
  }
  const matches = faces.filter(
    (face) =>
      face.geometry?.featureType === 'blend' &&
      face.geometry.blendRadius !== undefined &&
      Number.isFinite(face.geometry.blendRadius) &&
      face.geometry.blendRadius > 0 &&
      hasSameLineage(face, source)
  );
  return matches.length === 1 ? matches[0]! : null;
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
