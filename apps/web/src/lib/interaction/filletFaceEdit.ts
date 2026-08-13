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

function distanceToAxis(
  point: Vector3,
  axisPoint: Vector3,
  axisDirection: Vector3
): number {
  const axis = normalized(axisDirection);
  if (!axis) {
    return Infinity;
  }
  const offset = subtract(point, axisPoint);
  return length(subtract(point, addScaled(axisPoint, axis, dot(offset, axis))));
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

export const IMPORTED_BLEND_REMOVABLE_NOTICE =
  'STEP stores topology, not native Fillet history, so this radius is read-only. Use Remove selected feature for a validated direct edit, then recreate the detail as a native Fillet; Undo restores the imported body.';

export const IMPORTED_BLEND_READ_ONLY_NOTICE =
  'This radius is read-only because STEP stores topology, not native Fillet history. The exact kernel has not proved a safe edit path for this face; recreate the detail as a native Fillet to make its radius editable.';

export const IMPORTED_BLEND_EDITABLE_NOTICE =
  'This analytic STEP blend can be resized by the exact kernel. The edit is stored as replayable history; unsupported band geometry is refused without changing the body.';

export interface ImportedBlendSnapshot {
  surfaceClass: 'torus' | 'cylinder';
  radius: number;
  center: Vector3;
  axis: Vector3;
}

/** Exact carrier data required by the replayable imported-blend edit. */
export function importedBlendSnapshot(
  face: FaceTopology
): ImportedBlendSnapshot | null {
  const geometry = face.geometry;
  if (
    geometry?.featureType !== 'blend' ||
    geometry.blendRadius === undefined ||
    !Number.isFinite(geometry.blendRadius) ||
    geometry.blendRadius <= 0
  ) {
    return null;
  }
  if (
    geometry.surfaceType === 'torus' &&
    geometry.torusCenter &&
    geometry.axis
  ) {
    return {
      surfaceClass: 'torus',
      radius: geometry.blendRadius,
      center: geometry.torusCenter,
      axis: geometry.axis
    };
  }
  if (
    geometry.surfaceType === 'cylinder' &&
    geometry.axisStart &&
    geometry.axisEnd
  ) {
    const axis = normalized(subtract(geometry.axisEnd, geometry.axisStart));
    if (!axis) {
      return null;
    }
    return {
      surfaceClass: 'cylinder',
      radius: geometry.blendRadius,
      center: addScaled(
        geometry.axisStart,
        subtract(geometry.axisEnd, geometry.axisStart),
        0.5
      ),
      axis
    };
  }
  return null;
}

/** Re-select a resized imported band by analytic carrier identity, never hash. */
export function resolveImportedBlendFace(
  faces: readonly FaceTopology[],
  source: FaceTopology,
  directEditFeatureId?: string
): FaceTopology | null {
  if (directEditFeatureId) {
    const lineageMatches = faces.filter(
      (face) =>
        face.geometry?.featureType === 'blend' &&
        face.geometry.blendRadius !== undefined &&
        face.reference?.lineageName === 'direct-edit.resize-blend.band' &&
        (String(face.reference.producingFeatureId) === directEditFeatureId ||
          source.reference?.lineageName === 'direct-edit.resize-blend.band')
    );
    if (lineageMatches.length === 1) {
      return lineageMatches[0]!;
    }
  }
  const snapshot = importedBlendSnapshot(source);
  if (!snapshot) {
    return null;
  }
  const tolerance = Math.max(snapshot.radius * 1e-5, 1e-6);
  const matches = faces.filter((face) => {
    const candidate = importedBlendSnapshot(face);
    return (
      candidate?.surfaceClass === snapshot.surfaceClass &&
      (snapshot.surfaceClass === 'torus'
        ? length(subtract(candidate.center, snapshot.center)) <= tolerance
        : distanceToAxis(candidate.center, snapshot.center, snapshot.axis) <=
            tolerance &&
          distanceToAxis(snapshot.center, candidate.center, candidate.axis) <=
            tolerance) &&
      Math.abs(dot(candidate.axis, snapshot.axis)) >= 1 - 1e-6
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** Actionable copy for an imported blend without inventing feature history. */
export function importedBlendEditNotice(
  body: BodyRepresentation,
  face: FaceTopology
): string | null {
  if (
    body.source !== 'imported-step' ||
    face.geometry?.featureType !== 'blend' ||
    face.geometry.blendRadius === undefined
  ) {
    return null;
  }
  if (importedBlendSnapshot(face)) {
    return IMPORTED_BLEND_EDITABLE_NOTICE;
  }
  return canRemoveImportedBlendFace(body, face)
    ? IMPORTED_BLEND_REMOVABLE_NOTICE
    : IMPORTED_BLEND_READ_ONLY_NOTICE;
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
