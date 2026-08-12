import type {
  EdgeWitnessV1,
  FaceAnalyticWitnessV1,
  FaceWitnessV1,
  FeatureId,
  QuantizedTopologyPoint,
  TopologyReferenceV5
} from '@openzcad/shared';

export type {
  EdgeTopologyReferenceV5,
  EdgeWitnessV1,
  FaceAnalyticWitnessV1,
  FaceTopologyReferenceV5,
  FaceWitnessV1,
  QuantizedTopologyPoint,
  TopologyReferenceV5
} from '@openzcad/shared';

import { fingerprintOfSignature } from './topology-fingerprint';

/**
 * Kernel-neutral persistent-topology contracts from ADR-013.
 *
 * These values contain only frozen ADR-011 quantized integers. Kernel handles,
 * traversal positions, tessellation measurements, and proximity scores are
 * deliberately absent, so callers cannot use this module to silently rebind a
 * reference to nearby geometry.
 */

export type TopologyKind = 'edge' | 'face';

export type TopologyWitnessV1 = EdgeWitnessV1 | FaceWitnessV1;

/**
 * The only safe information available on documents written before schema v5.
 * Resolution retains ADR-011's unique-hash behavior and never treats the hash
 * as an ordinal.
 */
export interface LegacyTopologyHashReference {
  readonly kind: TopologyKind;
  readonly currentHash: number;
}

export interface TopologyLineageIdentity {
  readonly producingFeatureId: FeatureId;
  readonly lineageName: string;
}

export type TopologyLineageOperation =
  | 'primitive'
  | 'sweep'
  | 'imported-step'
  | 'imported-mesh'
  | 'rigid-transform'
  | 'mirror'
  | 'shell'
  | 'solid-offset'
  | 'pattern'
  | 'boolean'
  | 'fillet'
  | 'chamfer'
  | 'direct-edit';

/**
 * `verified-evolution-only` is deliberately absent: capabilities describe
 * lineage the production adapter actually publishes, not bridge potential.
 */
export type TopologyLineageCapability =
  | { readonly status: 'semantic' }
  | { readonly status: 'derived' }
  | {
      readonly status: 'unsupported';
      readonly fallback: 'hash-only';
      readonly reason: string;
    };

const OPERATION_CAPABILITIES: Readonly<
  Record<TopologyLineageOperation, TopologyLineageCapability>
> = {
  primitive: { status: 'semantic' },
  sweep: { status: 'semantic' },
  /**
   * K0.6. An imported B-rep is the ROOT of its own lineage rather than a
   * transition out of an earlier one, so ADR-013's "imported STEP provenance is
   * hash-only" applies to provenance THROUGH the import, not to identity within
   * it. The name is derived from the import feature plus the face's own
   * independently measured exact witness — document data and geometry, never a
   * kernel handle or a traversal ordinal — which is exactly the `derived`
   * contract that rigid transforms and patterns already use.
   */
  'imported-step': { status: 'derived' },
  'imported-mesh': {
    status: 'unsupported',
    fallback: 'hash-only',
    reason:
      'An imported mesh has no feature provenance: its facets come from the source file, not from an OpenZCAD operation.'
  },
  'rigid-transform': { status: 'derived' },
  mirror: {
    status: 'unsupported',
    fallback: 'hash-only',
    reason:
      'Mirror lineage is bridge-gated until reflected orientation and the complete output relation are verified.'
  },
  shell: {
    status: 'unsupported',
    fallback: 'hash-only',
    reason:
      'Shell lineage is bridge-gated until removed, offset, and generated faces have a complete output relation.'
  },
  'solid-offset': {
    status: 'unsupported',
    fallback: 'hash-only',
    reason:
      'Solid-offset lineage is bridge-gated until every offset and generated face has a complete output relation.'
  },
  /**
   * Fillet is derived only for generated blend faces whose construction
   * history, exact support witnesses, and one-to-one role all verify. The
   * other operations below retain their shipped hash-only behavior.
   */
  pattern: {
    status: 'unsupported',
    fallback: 'hash-only',
    reason:
      'Pattern instances may be fused when they overlap, so the result faces have no complete output relation to the source body.'
  },
  boolean: {
    status: 'unsupported',
    fallback: 'hash-only',
    reason:
      'The production boolean result may be face-unified after the kernel operation, so no unverified history payload is accepted.'
  },
  fillet: { status: 'derived' },
  chamfer: {
    status: 'unsupported',
    fallback: 'hash-only',
    reason:
      'Chamfer lineage remains hash-only because generated bevel faces are not blend faces.'
  },
  'direct-edit': {
    status: 'unsupported',
    fallback: 'hash-only',
    reason:
      'Direct-edit lineage is bridge-gated until the complete output relation is exposed.'
  }
};

export function topologyLineageCapability(
  operation: TopologyLineageOperation
): TopologyLineageCapability {
  return OPERATION_CAPABILITIES[operation];
}

export type WitnessInspection =
  | { readonly status: 'supported' }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'unsupported'; readonly reason: string };

function isQuantizedInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

function inspectPoint(
  point: QuantizedTopologyPoint,
  label: string
): WitnessInspection {
  if (
    !Array.isArray(point) ||
    point.length !== 3 ||
    !point.every(isQuantizedInteger)
  ) {
    return {
      status: 'invalid',
      reason: `${label} must contain exactly three safe quantized integers.`
    };
  }
  return { status: 'supported' };
}

function comparePoints(
  left: QuantizedTopologyPoint,
  right: QuantizedTopologyPoint
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function isCanonicalDirection(direction: QuantizedTopologyPoint): boolean {
  for (const component of direction) {
    if (component !== 0) {
      return component > 0;
    }
  }
  return false;
}

function isFreeFormClass(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replaceAll('_', '')
    .replaceAll('-', '');
  return normalized.includes('bspline') || normalized.includes('nurbs');
}

function inspectEdgeWitness(witness: EdgeWitnessV1): WitnessInspection {
  if (witness.curveType.trim().length === 0) {
    return { status: 'invalid', reason: 'Edge curveType must not be empty.' };
  }
  if (!isQuantizedInteger(witness.length)) {
    return {
      status: 'invalid',
      reason: 'Edge length must be a safe quantized integer.'
    };
  }
  if (witness.length < 0) {
    return {
      status: 'invalid',
      reason: 'Edge length must not be negative.'
    };
  }

  if (!witness.closed) {
    const start = inspectPoint(witness.endpoints[0], 'Edge endpoint');
    if (start.status !== 'supported') {
      return start;
    }
    const end = inspectPoint(witness.endpoints[1], 'Edge endpoint');
    if (end.status !== 'supported') {
      return end;
    }
    const midpoint = inspectPoint(witness.midpoint, 'Edge midpoint');
    if (midpoint.status !== 'supported') {
      return midpoint;
    }
    if (comparePoints(witness.endpoints[0], witness.endpoints[1]) > 0) {
      return {
        status: 'invalid',
        reason: 'Open-edge endpoints must be stored in lexicographic order.'
      };
    }
    return { status: 'supported' };
  }

  const center = inspectPoint(witness.center, 'Closed-edge center');
  if (center.status !== 'supported') {
    return center;
  }
  if (witness.axis) {
    const axis = inspectPoint(witness.axis, 'Closed-edge axis');
    if (axis.status !== 'supported') {
      return axis;
    }
    if (!isCanonicalDirection(witness.axis)) {
      return {
        status: 'invalid',
        reason: 'Closed-edge axis must be non-zero and sign-canonical.'
      };
    }
  }
  if (isFreeFormClass(witness.curveType)) {
    return {
      status: 'unsupported',
      reason: 'Closed B-spline/NURBS edges have no cross-kernel exact witness.'
    };
  }
  return { status: 'supported' };
}

function inspectAnalyticWitness(
  witness: FaceAnalyticWitnessV1
): WitnessInspection {
  if (witness.kind === 'none') {
    return { status: 'supported' };
  }
  if (witness.kind === 'plane') {
    const normal = inspectPoint(witness.normal, 'Plane normal');
    if (normal.status !== 'supported') {
      return normal;
    }
    if (!isCanonicalDirection(witness.normal)) {
      return {
        status: 'invalid',
        reason: 'Plane normal must be non-zero and sign-canonical.'
      };
    }
    if (!isQuantizedInteger(witness.offset)) {
      return {
        status: 'invalid',
        reason: 'Plane offset must be a safe quantized integer.'
      };
    }
    return { status: 'supported' };
  }

  const axis = inspectPoint(witness.axis, 'Cylinder axis');
  if (axis.status !== 'supported') {
    return axis;
  }
  if (!isCanonicalDirection(witness.axis)) {
    return {
      status: 'invalid',
      reason: 'Cylinder axis must be non-zero and sign-canonical.'
    };
  }
  const foot = inspectPoint(witness.axisFoot, 'Cylinder axis foot');
  if (foot.status !== 'supported') {
    return foot;
  }
  if (!isQuantizedInteger(witness.radius) || witness.radius < 0) {
    return {
      status: 'invalid',
      reason: 'Cylinder radius must be a non-negative quantized integer.'
    };
  }
  return { status: 'supported' };
}

function inspectFaceWitness(witness: FaceWitnessV1): WitnessInspection {
  if (witness.surfaceType.trim().length === 0) {
    return {
      status: 'invalid',
      reason: 'Face surfaceType must not be empty.'
    };
  }
  if (!isQuantizedInteger(witness.perimeter) || witness.perimeter < 0) {
    return {
      status: 'invalid',
      reason: 'Face perimeter must be a non-negative quantized integer.'
    };
  }
  if (witness.centroid) {
    const centroid = inspectPoint(witness.centroid, 'Face centroid');
    if (centroid.status !== 'supported') {
      return centroid;
    }
  }
  const analytic = inspectAnalyticWitness(witness.analytic);
  if (analytic.status !== 'supported') {
    return analytic;
  }
  const normalizedSurfaceType = witness.surfaceType.toLowerCase();
  if (
    (normalizedSurfaceType === 'plane' && witness.analytic.kind !== 'plane') ||
    (normalizedSurfaceType === 'cylinder' &&
      witness.analytic.kind !== 'cylinder') ||
    (normalizedSurfaceType !== 'plane' &&
      normalizedSurfaceType !== 'cylinder' &&
      witness.analytic.kind !== 'none')
  ) {
    return {
      status: 'invalid',
      reason: 'Face analytic witness must match its exact surface class.'
    };
  }
  if (isFreeFormClass(witness.surfaceType)) {
    if (witness.closure.u !== 'open' || witness.closure.v !== 'open') {
      return {
        status: 'unsupported',
        reason:
          'Closed or unknown B-spline/NURBS surface closure is unsupported.'
      };
    }
  }
  return { status: 'supported' };
}

export function inspectTopologyWitness(
  kind: 'edge',
  witness: EdgeWitnessV1
): WitnessInspection;
export function inspectTopologyWitness(
  kind: 'face',
  witness: FaceWitnessV1
): WitnessInspection;
export function inspectTopologyWitness(
  kind: TopologyKind,
  witness: TopologyWitnessV1
): WitnessInspection {
  return inspectWitnessByKind(kind, witness);
}

function inspectWitnessByKind(
  kind: TopologyKind,
  witness: TopologyWitnessV1
): WitnessInspection {
  return kind === 'edge'
    ? inspectEdgeWitness(witness as EdgeWitnessV1)
    : inspectFaceWitness(witness as FaceWitnessV1);
}

function pointSignature(point: QuantizedTopologyPoint): string {
  return point.join(',');
}

function edgeSignatureOfWitness(witness: EdgeWitnessV1): string {
  if (witness.closed) {
    return [
      witness.curveType,
      witness.length,
      'C',
      pointSignature(witness.center),
      witness.axis ? pointSignature(witness.axis) : 'na'
    ].join(':');
  }
  return [
    witness.curveType,
    witness.length,
    ...witness.endpoints[0],
    ...witness.endpoints[1],
    ...witness.midpoint
  ].join(':');
}

function analyticSignatureOfWitness(witness: FaceAnalyticWitnessV1): string {
  switch (witness.kind) {
    case 'none':
      return '';
    case 'plane':
      return `pl${pointSignature(witness.normal)};d${witness.offset}`;
    case 'cylinder':
      return (
        `cy${pointSignature(witness.axis)};` +
        `ft${pointSignature(witness.axisFoot)};r${witness.radius}`
      );
  }
}

function faceSignatureOfWitness(witness: FaceWitnessV1): string {
  return [
    witness.surfaceType,
    'P',
    witness.perimeter,
    analyticSignatureOfWitness(witness.analytic),
    witness.centroid ? pointSignature(witness.centroid) : 'nc'
  ].join(':');
}

export function topologyHashOfWitness(
  kind: 'edge',
  witness: EdgeWitnessV1
): number;
export function topologyHashOfWitness(
  kind: 'face',
  witness: FaceWitnessV1
): number;
export function topologyHashOfWitness(
  kind: TopologyKind,
  witness: TopologyWitnessV1
): number {
  return fingerprintOfSignature(
    kind === 'edge'
      ? edgeSignatureOfWitness(witness as EdgeWitnessV1)
      : faceSignatureOfWitness(witness as FaceWitnessV1)
  );
}

/**
 * The lineage name an imported STEP face or edge carries (K0.6).
 *
 * A modelled body names its topology from the feature contract — a box has an
 * `x.min` face because the command said so. An import has no such contract: the
 * file is the whole of the semantic input, and the only kernel-neutral thing
 * that identifies one face within it is the face's own exact ADR-011 witness.
 * So the name IS the fingerprint, in hex.
 *
 * That satisfies ADR-013's prohibition — this is neither a kernel handle nor a
 * traversal ordinal nor a viewport id, it is a deterministic function of exact
 * geometry — and it makes the name cross-kernel stable everywhere ADR-011
 * fingerprints already are. Uniqueness is not assumed: the callers publish a
 * reference only when the name and the candidate are both one-to-one, so two
 * faces with identical witnesses (a sphere's two hemispheres) publish nothing
 * rather than something ambiguous.
 */
export function importedStepLineageName(
  kind: TopologyKind,
  hash: number
): string {
  return `import.step.${kind}.${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function witnessKey(kind: TopologyKind, witness: TopologyWitnessV1): string {
  if (kind === 'edge') {
    const edge = witness as EdgeWitnessV1;
    return `edge:${edgeSignatureOfWitness(edge)}`;
  }
  const face = witness as FaceWitnessV1;
  return [
    'face',
    faceSignatureOfWitness(face),
    face.closure.u,
    face.closure.v
  ].join(':');
}

export function topologyWitnessesEqual(
  kind: TopologyKind,
  left: TopologyWitnessV1,
  right: TopologyWitnessV1
): boolean {
  return witnessKey(kind, left) === witnessKey(kind, right);
}

/**
 * A witness derived by transforming quantized coordinates cannot promise the
 * same integers as a witness measured on the transformed body: the source's
 * half-quantum placement error rotates into every component, and the two
 * pipelines round independently. The reals differ by under one quantum, so
 * after both roundings each integer differs by at most ~2. Two quanta of a
 * 1e-6 grid is still sub-nanometre — far inside geometric tolerance — while
 * the surrounding uniqueness gates keep resolution fail-closed: a band that
 * matches two candidates is reported as ambiguous, never bound.
 */
const KNOWN_TRANSFORM_QUANTUM_SLACK = 2;

function quantaNearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= KNOWN_TRANSFORM_QUANTUM_SLACK;
}

function pointsNearlyEqual(
  left: QuantizedTopologyPoint,
  right: QuantizedTopologyPoint
): boolean {
  return (
    quantaNearlyEqual(left[0], right[0]) &&
    quantaNearlyEqual(left[1], right[1]) &&
    quantaNearlyEqual(left[2], right[2])
  );
}

/**
 * Canonicalization picks a direction's sign from its leading nonzero
 * component; noise straddling zero can flip the two pipelines' choices, so a
 * near-match must accept the negated form too.
 */
function directionsNearlyAligned(
  left: QuantizedTopologyPoint,
  right: QuantizedTopologyPoint
): { aligned: boolean; flipped: boolean } {
  if (pointsNearlyEqual(left, right)) {
    return { aligned: true, flipped: false };
  }
  if (pointsNearlyEqual(left, [-right[0], -right[1], -right[2]])) {
    return { aligned: true, flipped: true };
  }
  return { aligned: false, flipped: false };
}

function analyticsNearlyEqual(
  left: FaceAnalyticWitnessV1,
  right: FaceAnalyticWitnessV1
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'none') {
    return true;
  }
  if (left.kind === 'plane' && right.kind === 'plane') {
    const alignment = directionsNearlyAligned(left.normal, right.normal);
    return (
      alignment.aligned &&
      quantaNearlyEqual(
        left.offset,
        alignment.flipped ? -right.offset : right.offset
      )
    );
  }
  if (left.kind === 'cylinder' && right.kind === 'cylinder') {
    // Negating the axis leaves the perpendicular foot unchanged, so the foot
    // compares directly under either orientation.
    return (
      directionsNearlyAligned(left.axis, right.axis).aligned &&
      pointsNearlyEqual(left.axisFoot, right.axisFoot) &&
      quantaNearlyEqual(left.radius, right.radius)
    );
  }
  return false;
}

/**
 * Equality up to independent-rounding noise, for matching a witness that was
 * *derived* (transformed in quantized space) against one that was *measured*.
 * Discrete structure — curve/surface type, closedness, closure, null-ness —
 * still compares exactly; only quantized numbers get the slack, and endpoint
 * order and direction sign accept the tie-noise permutations the exact
 * comparators are known to flip on.
 */
export function topologyWitnessesNearlyEqual(
  kind: TopologyKind,
  left: TopologyWitnessV1,
  right: TopologyWitnessV1
): boolean {
  if (kind === 'edge') {
    const first = left as EdgeWitnessV1;
    const second = right as EdgeWitnessV1;
    if (
      first.curveType !== second.curveType ||
      first.closed !== second.closed ||
      !quantaNearlyEqual(first.length, second.length)
    ) {
      return false;
    }
    if (first.closed && second.closed) {
      if (!pointsNearlyEqual(first.center, second.center)) {
        return false;
      }
      if (first.axis === null || second.axis === null) {
        return first.axis === second.axis;
      }
      return directionsNearlyAligned(first.axis, second.axis).aligned;
    }
    if (!first.closed && !second.closed) {
      // Endpoints sort by quantized lexicographic order, which noise can
      // swap when the endpoints tie on a leading axis; accept either pairing.
      return (
        pointsNearlyEqual(first.midpoint, second.midpoint) &&
        ((pointsNearlyEqual(first.endpoints[0], second.endpoints[0]) &&
          pointsNearlyEqual(first.endpoints[1], second.endpoints[1])) ||
          (pointsNearlyEqual(first.endpoints[0], second.endpoints[1]) &&
            pointsNearlyEqual(first.endpoints[1], second.endpoints[0])))
      );
    }
    return false;
  }
  const first = left as FaceWitnessV1;
  const second = right as FaceWitnessV1;
  if (
    first.surfaceType !== second.surfaceType ||
    first.closure.u !== second.closure.u ||
    first.closure.v !== second.closure.v ||
    !quantaNearlyEqual(first.perimeter, second.perimeter)
  ) {
    return false;
  }
  if (first.centroid === null || second.centroid === null) {
    if (first.centroid !== second.centroid) {
      return false;
    }
  } else if (!pointsNearlyEqual(first.centroid, second.centroid)) {
    return false;
  }
  return analyticsNearlyEqual(first.analytic, second.analytic);
}

export type EvolutionRelation =
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'known-transform';
      /** Independently derived by applying the document transform exactly. */
      readonly expectedResultWitness: TopologyWitnessV1;
    }
  | { readonly kind: 'analytic-carrier' };

export interface TopologyEvolutionInput {
  readonly operation:
    'rigid-transform' | 'boolean' | 'fillet' | 'chamfer' | 'direct-edit';
  readonly kind: TopologyKind;
  readonly sourceWitness: TopologyWitnessV1;
  readonly resultWitness: TopologyWitnessV1;
  readonly relation: EvolutionRelation;
}

export interface VerifiedTopologyEvolution {
  readonly status: 'verified';
  readonly operation: 'rigid-transform' | 'boolean' | 'fillet';
  readonly kind: TopologyKind;
  readonly sourceWitness: TopologyWitnessV1;
  readonly resultWitness: TopologyWitnessV1;
  readonly resultHash: number;
}

export type TopologyEvolutionVerification =
  | VerifiedTopologyEvolution
  | {
      readonly status: 'rejected';
      readonly reason: string;
    }
  | {
      readonly status: 'unsupported';
      readonly fallback: 'hash-only';
      readonly reason: string;
    };

function analyticCarriersEqual(
  kind: TopologyKind,
  sourceWitness: TopologyWitnessV1,
  resultWitness: TopologyWitnessV1
): boolean {
  if (kind !== 'face') {
    return false;
  }
  const source = sourceWitness as FaceWitnessV1;
  const result = resultWitness as FaceWitnessV1;
  if (source.analytic.kind !== result.analytic.kind) {
    return false;
  }
  if (source.analytic.kind === 'plane' && result.analytic.kind === 'plane') {
    return (
      pointSignature(source.analytic.normal) ===
        pointSignature(result.analytic.normal) &&
      source.analytic.offset === result.analytic.offset
    );
  }
  if (
    source.analytic.kind === 'cylinder' &&
    result.analytic.kind === 'cylinder'
  ) {
    return (
      pointSignature(source.analytic.axis) ===
        pointSignature(result.analytic.axis) &&
      pointSignature(source.analytic.axisFoot) ===
        pointSignature(result.analytic.axisFoot) &&
      source.analytic.radius === result.analytic.radius
    );
  }
  return false;
}

export function verifyTopologyEvolution(
  input: TopologyEvolutionInput
): TopologyEvolutionVerification {
  if (input.operation === 'chamfer' || input.operation === 'direct-edit') {
    const unsupported = topologyLineageCapability(input.operation);
    if (unsupported.status === 'unsupported') {
      return unsupported;
    }
    return {
      status: 'rejected',
      reason: 'Unsupported-operation capability table is inconsistent.'
    };
  }

  const sourceInspection = inspectWitnessByKind(
    input.kind,
    input.sourceWitness
  );
  if (sourceInspection.status !== 'supported') {
    return {
      status: 'rejected',
      reason: `Source witness is ${sourceInspection.status}: ${sourceInspection.reason}`
    };
  }
  const resultInspection = inspectWitnessByKind(
    input.kind,
    input.resultWitness
  );
  if (resultInspection.status !== 'supported') {
    return {
      status: 'rejected',
      reason: `Result witness is ${resultInspection.status}: ${resultInspection.reason}`
    };
  }

  let compatible = false;
  switch (input.relation.kind) {
    case 'unchanged':
      compatible = topologyWitnessesEqual(
        input.kind,
        input.sourceWitness,
        input.resultWitness
      );
      break;
    case 'known-transform': {
      if (input.operation !== 'rigid-transform') {
        return {
          status: 'rejected',
          reason: 'Known-transform evidence is valid only for rigid transforms.'
        };
      }
      const expectedInspection = inspectWitnessByKind(
        input.kind,
        input.relation.expectedResultWitness
      );
      // The expected witness was derived in quantized space, so it carries
      // rounding noise a measured witness does not; exact integer equality
      // here would reject every rotation that is not grid-preserving.
      compatible =
        expectedInspection.status === 'supported' &&
        topologyWitnessesNearlyEqual(
          input.kind,
          input.relation.expectedResultWitness,
          input.resultWitness
        );
      break;
    }
    case 'analytic-carrier':
      if (input.operation !== 'boolean' && input.operation !== 'fillet') {
        return {
          status: 'rejected',
          reason:
            'Analytic-carrier evidence is enabled only for gated boolean and fillet transitions.'
        };
      }
      compatible = analyticCarriersEqual(
        input.kind,
        input.sourceWitness,
        input.resultWitness
      );
      break;
  }

  if (!compatible) {
    return {
      status: 'rejected',
      reason: `The ${input.relation.kind} witness relation does not match exactly.`
    };
  }

  return {
    status: 'verified',
    operation: input.operation,
    kind: input.kind,
    sourceWitness: input.sourceWitness,
    resultWitness: input.resultWitness,
    resultHash:
      input.kind === 'edge'
        ? topologyHashOfWitness('edge', input.resultWitness as EdgeWitnessV1)
        : topologyHashOfWitness('face', input.resultWitness as FaceWitnessV1)
  };
}

export type CandidateLineage =
  | {
      readonly source: 'semantic' | 'derived';
      readonly identity: TopologyLineageIdentity;
    }
  | {
      readonly source: 'kernel-evolution';
      readonly identity: TopologyLineageIdentity;
      readonly verification: TopologyEvolutionVerification;
    };

interface TopologyResolutionCandidateCommon {
  readonly currentHash: number;
  readonly witnessVersion: 1;
  readonly lineage?: CandidateLineage;
  /** Opaque caller value, such as a kernel-local sub-shape handle. */
  readonly value?: unknown;
}

export interface EdgeTopologyResolutionCandidate extends TopologyResolutionCandidateCommon {
  readonly kind: 'edge';
  readonly witness: EdgeWitnessV1;
}

export interface FaceTopologyResolutionCandidate extends TopologyResolutionCandidateCommon {
  readonly kind: 'face';
  readonly witness: FaceWitnessV1;
}

export type TopologyResolutionCandidate =
  EdgeTopologyResolutionCandidate | FaceTopologyResolutionCandidate;

export type LineageAvailability =
  | { readonly status: 'available' }
  | {
      readonly status: 'unsupported';
      readonly operation: TopologyLineageOperation;
      readonly reason?: string;
    };

export type TopologyResolutionFailureReason =
  | 'invalid-reference'
  | 'unsupported-witness'
  | 'lineage-not-found'
  | 'lineage-unverified'
  | 'ambiguous-lineage'
  | 'hash-not-found'
  | 'ambiguous-hash';

export type TopologyResolutionResult =
  | {
      readonly status: 'resolved';
      readonly via: 'lineage' | 'hash-fallback' | 'legacy-hash';
      readonly candidate: TopologyResolutionCandidate;
    }
  | {
      readonly status: 'failed';
      readonly reason: TopologyResolutionFailureReason;
      readonly message: string;
    };

function isTopologyReferenceV5(
  reference: TopologyReferenceV5 | LegacyTopologyHashReference
): reference is TopologyReferenceV5 {
  return 'producingFeatureId' in reference;
}

function validLineageIdentity(identity: TopologyLineageIdentity): boolean {
  return (
    String(identity.producingFeatureId).trim().length > 0 &&
    identity.lineageName.trim().length > 0
  );
}

function sameLineageIdentity(
  left: TopologyLineageIdentity,
  right: TopologyLineageIdentity
): boolean {
  return (
    left.producingFeatureId === right.producingFeatureId &&
    left.lineageName === right.lineageName
  );
}

function candidateInspection(
  candidate: TopologyResolutionCandidate
): WitnessInspection {
  const inspection =
    candidate.kind === 'edge'
      ? inspectTopologyWitness('edge', candidate.witness)
      : inspectTopologyWitness('face', candidate.witness);
  if (inspection.status !== 'supported') {
    return inspection;
  }
  const expectedHash =
    candidate.kind === 'edge'
      ? topologyHashOfWitness('edge', candidate.witness)
      : topologyHashOfWitness('face', candidate.witness);
  if (candidate.currentHash !== expectedHash) {
    return {
      status: 'invalid',
      reason: 'Candidate hash does not match its exact witness.'
    };
  }
  return { status: 'supported' };
}

function kernelEvolutionIsBound(
  candidate: TopologyResolutionCandidate,
  lineage: Extract<CandidateLineage, { source: 'kernel-evolution' }>
): boolean {
  const verification = lineage.verification;
  return (
    verification.status === 'verified' &&
    verification.kind === candidate.kind &&
    verification.resultHash === candidate.currentHash &&
    topologyWitnessesEqual(
      candidate.kind,
      verification.resultWitness,
      candidate.witness
    )
  );
}

function resolveByHash(
  reference: TopologyReferenceV5 | LegacyTopologyHashReference,
  candidates: readonly TopologyResolutionCandidate[],
  via: 'hash-fallback' | 'legacy-hash'
): TopologyResolutionResult {
  const matches = candidates.filter((candidate) => {
    if (
      candidate.kind !== reference.kind ||
      candidate.currentHash !== reference.currentHash ||
      candidateInspection(candidate).status !== 'supported'
    ) {
      return false;
    }
    if (!isTopologyReferenceV5(reference)) {
      return true;
    }
    return topologyWitnessesEqual(
      reference.kind,
      reference.witness,
      candidate.witness
    );
  });

  if (matches.length === 1) {
    return { status: 'resolved', via, candidate: matches[0]! };
  }
  if (matches.length > 1) {
    return {
      status: 'failed',
      reason: 'ambiguous-hash',
      message: `The selected ${reference.kind} hash matches multiple exact candidates.`
    };
  }
  return {
    status: 'failed',
    reason: 'hash-not-found',
    message: `The selected ${reference.kind} no longer has a unique exact hash match.`
  };
}

/**
 * Resolves only exact, unique candidates. A v5 lineage failure is terminal;
 * hash fallback is enabled solely for legacy references or an operation that
 * the caller explicitly marks unsupported by ADR-013.
 */
export function resolveTopologyReference(
  reference: TopologyReferenceV5 | LegacyTopologyHashReference,
  candidates: readonly TopologyResolutionCandidate[],
  lineageAvailability: LineageAvailability = { status: 'available' }
): TopologyResolutionResult {
  if (
    !Number.isSafeInteger(reference.currentHash) ||
    reference.currentHash <= 0
  ) {
    return {
      status: 'failed',
      reason: 'invalid-reference',
      message: 'Topology reference hash must be a positive safe integer.'
    };
  }
  if (!isTopologyReferenceV5(reference)) {
    return resolveByHash(reference, candidates, 'legacy-hash');
  }
  if (!validLineageIdentity(reference)) {
    return {
      status: 'failed',
      reason: 'invalid-reference',
      message:
        'Topology lineage identity must contain a feature and stable name.'
    };
  }
  const referenceInspection =
    reference.kind === 'edge'
      ? inspectTopologyWitness('edge', reference.witness)
      : inspectTopologyWitness('face', reference.witness);
  if (referenceInspection.status !== 'supported') {
    return {
      status: 'failed',
      reason:
        referenceInspection.status === 'unsupported'
          ? 'unsupported-witness'
          : 'invalid-reference',
      message: referenceInspection.reason
    };
  }
  const referenceHash =
    reference.kind === 'edge'
      ? topologyHashOfWitness('edge', reference.witness)
      : topologyHashOfWitness('face', reference.witness);
  if (referenceHash !== reference.currentHash) {
    return {
      status: 'failed',
      reason: 'invalid-reference',
      message: 'Topology reference hash does not match its exact witness.'
    };
  }

  if (lineageAvailability.status === 'unsupported') {
    return resolveByHash(reference, candidates, 'hash-fallback');
  }

  const identity: TopologyLineageIdentity = reference;
  const namedCandidates = candidates.filter(
    (candidate) =>
      candidate.kind === reference.kind &&
      candidate.lineage &&
      sameLineageIdentity(candidate.lineage.identity, identity)
  );
  const compatible = namedCandidates.filter((candidate) => {
    if (candidateInspection(candidate).status !== 'supported') {
      return false;
    }
    const lineage = candidate.lineage;
    if (!lineage) {
      return false;
    }
    return (
      lineage.source !== 'kernel-evolution' ||
      kernelEvolutionIsBound(candidate, lineage)
    );
  });

  if (compatible.length === 1) {
    return {
      status: 'resolved',
      via: 'lineage',
      candidate: compatible[0]!
    };
  }
  if (compatible.length > 1) {
    return {
      status: 'failed',
      reason: 'ambiguous-lineage',
      message: `The selected ${reference.kind} lineage resolves to multiple compatible candidates.`
    };
  }
  if (namedCandidates.length > 0) {
    return {
      status: 'failed',
      reason: 'lineage-unverified',
      message: `The selected ${reference.kind} lineage has no witness-verified candidate.`
    };
  }
  return {
    status: 'failed',
    reason: 'lineage-not-found',
    message: `The selected ${reference.kind} lineage no longer exists.`
  };
}
