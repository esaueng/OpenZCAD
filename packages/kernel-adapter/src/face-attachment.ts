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

/**
 * Persisted schema snapshot, written when the user chose the face.
 *
 * It never resolves a face — the fail-closed lineage resolver alone decides
 * that, and this is included in the errors it raises. `frame` additionally
 * anchors the orientation of the frame derived from whichever face the
 * resolver picked; see `deterministicFrame`.
 */
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
    `normal ${vector(snapshot.sourceNormal)}. The snapshot orients a resolved frame and was not used to resolve a face.`
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

/**
 * Below this, a seeded axis carries no usable direction and the world-axis
 * rule takes over. It is a sine: the stored xAxis projected onto the new plane
 * has length `sin(angle between that axis and the new normal)`, so 1e-3 is
 * about 0.057 degrees away from parallel. Inside that band the projection is
 * numerical noise rather than an orientation.
 */
const SEED_DEGENERATE_LIMIT = 1e-3;

function worldHelperAxis(zAxis: Vector3): Vector3 | null {
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
  return normalized(subtract(helper, scale(zAxis, dot(helper, zAxis))));
}

/**
 * The frame of the evolved face, anchored to the frame the sketch was attached
 * with.
 *
 * Deriving orientation from the normal alone cannot work, and not because the
 * old rule was written badly: a sphere carries no continuous field of tangent
 * directions, so every normal-only rule has a discontinuity somewhere and can
 * only move it. The old rule had two, and ordinary parametric edits walked into
 * both. Choosing the world axis least aligned with the normal flips which axis
 * wins the moment two components tie — measured, a 30-degree-tilted face nudged
 * from 44.9 to 45.1 degrees about Z rotated its sketch 81.8 degrees. And
 * `canonicalNormal` orients by the sign of the first non-zero component, so a
 * normal crossing that component's zero reverses, taking `yAxis` with it and
 * mirroring the sketch. Neither raised a warning.
 *
 * So the fix is an anchor, and `snapshot.frame` — written when the user chose
 * the face — is the only one available. Both degrees of freedom are seeded from
 * it: the normal keeps the sense the stored `zAxis` had, and the in-plane axis
 * is the stored `xAxis` projected back onto the evolved plane. The world-axis
 * rule stays underneath for the degenerate cases and for a caller with no seed.
 *
 * Still deterministic, which is what the name promises and what replay needs:
 * the result is a pure function of the resolved center, the resolved normal and
 * the persisted frame, all of which live in the document. And it cannot drift,
 * because every rebuild seeds from that same stored snapshot rather than from
 * the previous rebuild's output.
 */
function deterministicFrame(
  center: Vector3,
  rawNormal: Vector3,
  seed?: SketchPlaneFrame
): SketchPlaneFrame | null {
  if (!finiteVector(center)) {
    return null;
  }
  const canonical = canonicalNormal(rawNormal);
  if (!canonical) {
    return null;
  }
  // Only the sense comes from the seed, never the direction: the resolved
  // plane's own normal stays authoritative. Past the limit the face has turned
  // roughly perpendicular to where it was attached, so the sign carries no
  // meaning and the canonical rule keeps it.
  const seedZ = seed ? normalized(seed.zAxis) : null;
  const alignment = seedZ ? dot(canonical, seedZ) : 0;
  const zAxis =
    Math.abs(alignment) > SEED_DEGENERATE_LIMIT && alignment < 0
      ? cleaned(scale(canonical, -1))
      : canonical;

  const seedX = seed ? normalized(seed.xAxis) : null;
  const projectedSeed = seedX
    ? subtract(seedX, scale(zAxis, dot(seedX, zAxis)))
    : null;
  const xAxis =
    projectedSeed && magnitude(projectedSeed) >= SEED_DEGENERATE_LIMIT
      ? normalized(projectedSeed)
      : worldHelperAxis(zAxis);
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
    candidate.plane.normal,
    input.snapshot.frame
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
