import type {
  FaceTopologyReferenceV5,
  SketchPlaneFrame,
  Vector3
} from '@openzcad/shared';

import {
  resolveTopologyReference,
  type FaceTopologyResolutionCandidate,
  type TopologyResolutionFailureReason
} from './topology-lineage';

const VECTOR_EPSILON = 1e-12;

export interface ExactPlanarFaceAttachmentData {
  readonly center: Vector3;
  readonly normal: Vector3;
}

/**
 * One exact face as it existed at the attached sketch's history position.
 * `plane` is null for an exact non-planar carrier.
 */
export interface FaceAttachmentCandidate extends FaceTopologyResolutionCandidate {
  readonly plane: ExactPlanarFaceAttachmentData | null;
}

/** Persisted schema snapshot. It is included in errors and never resolves a face. */
export interface FaceAttachmentSnapshot {
  readonly sourceArea: number;
  readonly sourceCenter: Vector3;
  readonly sourceNormal: Vector3;
  readonly frame: SketchPlaneFrame;
}

export interface ResolveFaceAttachmentInput {
  readonly reference: FaceTopologyReferenceV5;
  readonly candidates: readonly FaceAttachmentCandidate[];
  readonly snapshot: FaceAttachmentSnapshot;
  readonly sketchName: string;
  readonly sourceFeatureName: string;
}

export type FaceAttachmentFailureReason =
  'deleted' | 'ambiguous' | 'non-planar' | 'invalid' | 'unsupported';

export class FaceAttachmentResolutionError extends Error {
  readonly reason: FaceAttachmentFailureReason;

  constructor(reason: FaceAttachmentFailureReason, message: string) {
    super(message);
    this.name = 'FaceAttachmentResolutionError';
    this.reason = reason;
  }
}

function named(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function snapshotDiagnostic(snapshot: FaceAttachmentSnapshot): string {
  const vector = (value: Vector3) => `(${value.x}, ${value.y}, ${value.z})`;
  return (
    `Stored snapshot: area ${snapshot.sourceArea}, center ${vector(snapshot.sourceCenter)}, ` +
    `normal ${vector(snapshot.sourceNormal)}. The snapshot is diagnostic only and was not used as a fallback.`
  );
}

function failure(
  input: ResolveFaceAttachmentInput,
  reason: FaceAttachmentFailureReason,
  detail: string
): FaceAttachmentResolutionError {
  const sketch = named(input.sketchName, '<unnamed sketch>');
  const source = named(input.sourceFeatureName, '<unnamed source feature>');
  return new FaceAttachmentResolutionError(
    reason,
    `Sketch "${sketch}" cannot attach to source feature "${source}": ${detail} ${snapshotDiagnostic(input.snapshot)}`
  );
}

function mappedFailureReason(
  reason: TopologyResolutionFailureReason
): FaceAttachmentFailureReason {
  switch (reason) {
    case 'lineage-not-found':
    case 'hash-not-found':
      return 'deleted';
    case 'ambiguous-lineage':
    case 'ambiguous-hash':
      return 'ambiguous';
    case 'unsupported-witness':
    case 'lineage-unverified':
      return 'unsupported';
    case 'invalid-reference':
      return 'invalid';
  }
}

function finiteVector(value: Vector3): boolean {
  return [value.x, value.y, value.z].every(Number.isFinite);
}

function magnitude(value: Vector3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function scale(value: Vector3, factor: number): Vector3 {
  return {
    x: value.x * factor,
    y: value.y * factor,
    z: value.z * factor
  };
}

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z
  };
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x
  };
}

function normalized(value: Vector3): Vector3 | null {
  if (!finiteVector(value)) {
    return null;
  }
  const length = magnitude(value);
  return Number.isFinite(length) && length > VECTOR_EPSILON
    ? scale(value, 1 / length)
    : null;
}

function cleaned(value: Vector3): Vector3 {
  const clean = (component: number) =>
    Math.abs(component) <= VECTOR_EPSILON ? 0 : component;
  return { x: clean(value.x), y: clean(value.y), z: clean(value.z) };
}

function canonicalNormal(value: Vector3): Vector3 | null {
  const unit = normalized(value);
  if (!unit) {
    return null;
  }
  const signComponent = [unit.x, unit.y, unit.z].find(
    (component) => Math.abs(component) > VECTOR_EPSILON
  );
  if (signComponent === undefined) {
    return null;
  }
  return cleaned(signComponent < 0 ? scale(unit, -1) : unit);
}

function deterministicFrame(
  center: Vector3,
  rawNormal: Vector3
): SketchPlaneFrame | null {
  if (!finiteVector(center)) {
    return null;
  }
  const zAxis = canonicalNormal(rawNormal);
  if (!zAxis) {
    return null;
  }
  const worldAxes: readonly Vector3[] = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 }
  ];
  const helper = worldAxes.reduce((best, candidate) =>
    Math.abs(dot(zAxis, candidate)) < Math.abs(dot(zAxis, best))
      ? candidate
      : best
  );
  const projected = subtract(helper, scale(zAxis, dot(helper, zAxis)));
  const xAxis = normalized(projected);
  if (!xAxis) {
    return null;
  }
  const yAxis = normalized(cross(zAxis, xAxis));
  if (!yAxis) {
    return null;
  }
  return {
    origin: { ...center },
    xAxis: cleaned(xAxis),
    yAxis: cleaned(yAxis),
    zAxis
  };
}

/**
 * Resolve a schema-v5 attachment solely through verified lineage at the
 * sketch's history position, then derive a deterministic right-handed frame.
 */
export function resolveFaceAttachment(
  input: ResolveFaceAttachmentInput
): SketchPlaneFrame {
  const resolution = resolveTopologyReference(
    input.reference,
    input.candidates
  );
  if (resolution.status === 'failed') {
    const reason = mappedFailureReason(resolution.reason);
    const detail =
      reason === 'deleted'
        ? `the attached face was deleted or no longer exists. ${resolution.message}`
        : resolution.message;
    throw failure(input, reason, detail);
  }
  if (resolution.via !== 'lineage') {
    throw failure(
      input,
      'unsupported',
      'schema-v5 face attachment requires verified lineage; hash fallback is not accepted.'
    );
  }
  const candidate = input.candidates.find(
    (entry) => entry === resolution.candidate
  );
  if (!candidate) {
    throw failure(
      input,
      'invalid',
      'the resolved topology candidate has no exact attachment data.'
    );
  }
  if (
    candidate.witness.surfaceType.toLowerCase() !== 'plane' ||
    candidate.witness.analytic.kind !== 'plane' ||
    !candidate.plane
  ) {
    throw failure(
      input,
      'non-planar',
      'the attached face is no longer an exact planar face.'
    );
  }
  const frame = deterministicFrame(
    candidate.plane.center,
    candidate.plane.normal
  );
  if (!frame) {
    throw failure(
      input,
      'invalid',
      'the resolved plane has a non-finite center or a degenerate normal.'
    );
  }
  return frame;
}
