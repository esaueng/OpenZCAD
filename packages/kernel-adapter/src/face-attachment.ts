import type {
  EdgeTopologyReferenceV5,
  FaceTopologyReferenceV5,
  SketchPlaneFrame,
  Vector3
} from '@openzcad/shared';

import { edgeEndPoint, quantizeCoordinate } from './topology-fingerprint';
import type { NativeVertexPointEvidence } from './remus-native-vertices';
import {
  resolveTopologyReference,
  type EdgeTopologyResolutionCandidate,
  type FaceTopologyResolutionCandidate,
  type TopologyResolutionCandidate,
  type TopologyResolutionFailureReason
} from './topology-lineage';

const VECTOR_EPSILON = 1e-12;

export interface ExactPlanarFaceAttachmentData {
  readonly center: Vector3;
  /** Area centroid; null when the face's boundary could not be walked. */
  readonly centroid: Vector3 | null;
  readonly normal: Vector3;
}

/**
 * One exact face as it existed at the attached sketch's history position.
 * `plane` is null for an exact non-planar carrier.
 */
export interface FaceAttachmentCandidate extends FaceTopologyResolutionCandidate {
  readonly plane: ExactPlanarFaceAttachmentData | null;
  /**
   * R01 datum axes: the exact axis of a cylindrical or conical face, through
   * the middle of a cylinder's axial span or a cone's apex. Absent for any
   * other carrier, or where the kernel publishes no exact axis.
   */
  readonly revolution?: ExactRevolutionAxisData | null;
}

export interface ExactRevolutionAxisData {
  readonly kind: 'cylinder' | 'cone';
  readonly point: Vector3;
  readonly direction: Vector3;
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
  /**
   * Present only for sketches placed on the face's area centroid. Its presence
   * — not its value — selects which point the rebuilt frame is anchored on;
   * see `SketchPlaneRef`'s face variant.
   */
  readonly sourceCentroid?: Vector3;
  readonly sourceNormal: Vector3;
  readonly frame: SketchPlaneFrame;
}

export interface ResolveFaceAttachmentInput {
  readonly reference: FaceTopologyReferenceV5;
  readonly candidates: readonly FaceAttachmentCandidate[];
  readonly snapshot: FaceAttachmentSnapshot;
  readonly sketchName: string;
  /** What attaches, for messages: a sketch unless an R01 datum says otherwise. */
  readonly ownerKind?: 'Sketch' | 'Extrude' | DatumOwnerKind;
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
    (snapshot.sourceCentroid
      ? `centroid ${vector(snapshot.sourceCentroid)}, `
      : '') +
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
    `${input.ownerKind ?? 'Sketch'} "${sketch}" cannot attach to source feature "${source}": ${detail} ${snapshotDiagnostic(input.snapshot)}`
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
 * the result is a pure function of the resolved origin, the resolved normal and
 * the persisted frame, all of which live in the document. And it cannot drift,
 * because every rebuild seeds from that same stored snapshot rather than from
 * the previous rebuild's output.
 *
 * `origin` is the caller's choice of anchor on the resolved face, not a degree
 * of freedom this function resolves: see `resolveFaceAttachment`.
 */
function deterministicFrame(
  origin: Vector3,
  rawNormal: Vector3,
  seed?: SketchPlaneFrame
): SketchPlaneFrame | null {
  if (!finiteVector(origin)) {
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
    origin: { ...origin },
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
  // A centroid-anchored sketch fails closed rather than quietly re-anchoring
  // on the vertex mean: the two points are a whole radius apart on a round
  // face, so the silent fallback would move the sketch's geometry.
  if (input.snapshot.sourceCentroid && !candidate.plane.centroid) {
    throw failure(
      input,
      'invalid',
      'the attached face no longer reports an area centroid, and this sketch is placed on one.'
    );
  }
  const anchor = input.snapshot.sourceCentroid
    ? candidate.plane.centroid!
    : candidate.plane.center;
  const frame = deterministicFrame(
    anchor,
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

/**
 * One exact edge at a datum's history position, with its exact endpoints
 * (null for a closed edge, which has no end vertex).
 */
export interface EdgeVertexCandidate extends EdgeTopologyResolutionCandidate {
  readonly endpoints: readonly [Vector3, Vector3] | null;
  /** Native points in the same start/end order; absent preserves legacy R01. */
  readonly nativeEndpoints?: readonly [
    NativeVertexPointEvidence | undefined,
    NativeVertexPointEvidence | undefined
  ];
}

export interface ResolveEdgeVertexInput {
  readonly reference: EdgeTopologyReferenceV5;
  readonly end: 0 | 1;
  readonly candidates: readonly EdgeVertexCandidate[];
  readonly datumName: string;
  readonly sourceFeatureName: string;
  /** Which kind of datum reads the vertex; defaults to a datum plane. */
  readonly ownerKind?: DatumOwnerKind;
}

export type DatumOwnerKind = 'Datum plane' | 'Datum axis';

/**
 * R01: the exact vertex a datum's edge-vertex source names, re-found solely
 * through verified lineage at the datum's history position. A deleted,
 * ambiguous or now-closed edge refuses by name; the stored witness never
 * stands in for the edge, and no vertex is chosen by proximity.
 */
export function resolveEdgeVertex(input: ResolveEdgeVertexInput): Vector3 {
  const fail = (detail: string) =>
    new Error(
      `${input.ownerKind ?? 'Datum plane'} "${named(input.datumName, '<unnamed datum>')}" cannot use a vertex of source feature "${named(input.sourceFeatureName, '<unnamed source feature>')}": ${detail}`
    );
  const resolution = resolveTopologyReference(
    input.reference,
    input.candidates
  );
  if (resolution.status === 'failed') {
    throw fail(
      mappedFailureReason(resolution.reason) === 'deleted'
        ? `its edge was deleted or no longer exists. ${resolution.message}`
        : resolution.message
    );
  }
  if (resolution.via !== 'lineage') {
    throw fail(
      'a vertex source requires verified lineage; hash fallback is not accepted.'
    );
  }
  const candidate = input.candidates.find(
    (entry) => entry === resolution.candidate
  );
  if (!candidate?.endpoints) {
    throw fail('its edge is now closed and has no end vertex.');
  }
  const point = edgeEndPoint(candidate.endpoints, input.end);
  const native =
    candidate.nativeEndpoints?.[point === candidate.endpoints[0] ? 0 : 1];
  if (native) {
    if (native.status !== 'qualified')
      throw fail(
        `its advertised native vertex evidence is ${native.reason}; endpoint fallback is not accepted.`
      );
    const key = (value: Vector3) =>
      [value.x, value.y, value.z].map(quantizeCoordinate);
    if (
      !finiteVector(native.point) ||
      !key(point).every((value, index) => value === key(native.point)[index])
    ) {
      throw fail(
        'its advertised native vertex contradicts the resolved edge endpoint; endpoint fallback is not accepted.'
      );
    }
    return { ...native.point };
  }
  if (!finiteVector(point)) {
    throw fail('the resolved vertex is not a finite position.');
  }
  return { x: point.x, y: point.y, z: point.z };
}

/** Resolves a topology reference through verified lineage only, or throws. */
function lineageCandidate<T extends TopologyResolutionCandidate>(
  reference: EdgeTopologyReferenceV5 | FaceTopologyReferenceV5,
  candidates: readonly T[],
  fail: (detail: string) => Error,
  what: string
): T {
  const resolution = resolveTopologyReference(reference, candidates);
  if (resolution.status === 'failed') {
    throw fail(
      mappedFailureReason(resolution.reason) === 'deleted'
        ? `its ${what} was deleted or no longer exists. ${resolution.message}`
        : resolution.message
    );
  }
  if (resolution.via !== 'lineage') {
    throw fail(
      'an axis source requires verified lineage; hash fallback is not accepted.'
    );
  }
  const candidate = candidates.find((entry) => entry === resolution.candidate);
  if (!candidate) {
    throw fail(`the resolved ${what} has no exact data.`);
  }
  return candidate;
}

export interface ResolveDatumAxisEdgeInput {
  readonly reference: EdgeTopologyReferenceV5;
  readonly candidates: readonly EdgeVertexCandidate[];
  readonly datumName: string;
  readonly sourceFeatureName: string;
}

/**
 * R01: the two ends of the straight edge a datum axis runs along, end 0
 * first (quantized order, as for a vertex source), re-found solely through
 * verified lineage at the axis's history position. A deleted, ambiguous,
 * closed or curved edge refuses by name.
 */
export function resolveDatumAxisEdge(
  input: ResolveDatumAxisEdgeInput
): [Vector3, Vector3] {
  const fail = (detail: string) =>
    new Error(
      `Datum axis "${named(input.datumName, '<unnamed datum>')}" cannot run along an edge of source feature "${named(input.sourceFeatureName, '<unnamed source feature>')}": ${detail}`
    );
  const candidate = lineageCandidate(
    input.reference,
    input.candidates,
    fail,
    'edge'
  );
  if (!candidate.endpoints) {
    throw fail('the edge is closed, so it is not a straight edge.');
  }
  if (candidate.witness.curveType.toLowerCase() !== 'line') {
    throw fail(
      `the edge is a ${candidate.witness.curveType.toLowerCase()}, not a straight edge.`
    );
  }
  const start = edgeEndPoint(candidate.endpoints, 0);
  const end = edgeEndPoint(candidate.endpoints, 1);
  if (!finiteVector(start) || !finiteVector(end)) {
    throw fail('the resolved edge has a non-finite end.');
  }
  return [
    { x: start.x, y: start.y, z: start.z },
    { x: end.x, y: end.y, z: end.z }
  ];
}

export interface ResolveDatumAxisFaceInput {
  readonly reference: FaceTopologyReferenceV5;
  readonly candidates: readonly FaceAttachmentCandidate[];
  readonly datumName: string;
  readonly sourceFeatureName: string;
}

/**
 * R01: the exact axis of the cylindrical or conical face a datum axis
 * follows, re-found solely through verified lineage. A deleted, ambiguous
 * or non-revolution face refuses by name; no axis is fitted to a mesh.
 */
export function resolveDatumAxisFace(
  input: ResolveDatumAxisFaceInput
): ExactRevolutionAxisData {
  const fail = (detail: string) =>
    new Error(
      `Datum axis "${named(input.datumName, '<unnamed datum>')}" cannot follow a face of source feature "${named(input.sourceFeatureName, '<unnamed source feature>')}": ${detail}`
    );
  const candidate = lineageCandidate(
    input.reference,
    input.candidates,
    fail,
    'face'
  );
  const revolution = candidate.revolution;
  if (!revolution) {
    throw fail(
      `the face is a ${candidate.witness.surfaceType.toLowerCase()}, not an exact cylinder or cone.`
    );
  }
  if (
    !finiteVector(revolution.point) ||
    !finiteVector(revolution.direction) ||
    magnitude(revolution.direction) <= VECTOR_EPSILON
  ) {
    throw fail('the resolved axis is not a finite line.');
  }
  return revolution;
}
