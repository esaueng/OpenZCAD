import { GEOMETRY_LINEAR_TOLERANCE, type Vec3 } from '@openzcad/geometry';
import {
  type EdgeTopologyReferenceV5,
  type EdgeWitnessV1,
  type FaceAnalyticWitnessV1,
  type FaceTopologyReferenceV5,
  type FaceWitnessV1,
  type FeatureId,
  type PrimitiveKind,
  type QuantizedTopologyPoint,
  type SketchObjectKind,
  type TopologyLineageDiagnostic,
  type TopologyReferenceV5
} from '@openzcad/shared';

import {
  importedStepLineageName,
  inspectTopologyWitness,
  resolveTopologyReference,
  topologyHashOfWitness,
  topologyWitnessesEqual,
  verifyTopologyEvolution,
  type TopologyLineageOperation,
  type TopologyResolutionCandidate,
  type TopologyResolutionResult
} from '../../../packages/kernel-adapter/src/topology-lineage';
import {
  canonicalDirection,
  canonicalizeDirection,
  quantizeCoordinate
} from '../../../packages/kernel-adapter/src/topology-fingerprint';

const DIRECTION_SCALE = 1000;

export type OcctTopologyCandidate =
  | {
      readonly kind: 'edge';
      readonly currentHash: number;
      readonly witness: EdgeWitnessV1;
    }
  | {
      readonly kind: 'face';
      readonly currentHash: number;
      readonly witness: FaceWitnessV1;
    };

export type OcctLineageState =
  | {
      readonly status: 'lineage';
      readonly references: readonly TopologyReferenceV5[];
      readonly diagnostics: readonly TopologyLineageDiagnostic[];
    }
  | {
      readonly status: 'hash-only';
      readonly references: readonly [];
      readonly reason: string;
    };

export interface SweepSemanticDescriptor {
  readonly kind: 'extrude' | 'revolve';
  readonly sourceKey: string;
  readonly sourceKind?: SketchObjectKind;
  /** Directed extrusion vector. Omitted for revolutions. */
  readonly direction?: Vec3;
  /** Exact midpoints of semantic source-profile sides after the sweep. */
  readonly sideAnchors?: readonly {
    readonly lineageName: string;
    readonly midpoint: Vec3;
  }[];
}

export function hashOnlyOcctLineage(reason: string): OcctLineageState {
  return { status: 'hash-only', references: [], reason };
}

export function quantizedTopologyPoint(point: Vec3): QuantizedTopologyPoint {
  return [
    quantizeCoordinate(point.x),
    quantizeCoordinate(point.y),
    quantizeCoordinate(point.z)
  ];
}

export function quantizedTopologyDirection(
  direction: Vec3
): QuantizedTopologyPoint {
  return [
    quantizeCoordinate(direction.x * DIRECTION_SCALE),
    quantizeCoordinate(direction.y * DIRECTION_SCALE),
    quantizeCoordinate(direction.z * DIRECTION_SCALE)
  ];
}

function pointKey(point: QuantizedTopologyPoint): string {
  return point.join(',');
}

function unitDirection(direction: Vec3): Vec3 | null {
  const magnitude = Math.hypot(direction.x, direction.y, direction.z);
  return magnitude > 0
    ? {
        x: direction.x / magnitude,
        y: direction.y / magnitude,
        z: direction.z / magnitude
      }
    : null;
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

export function canonicalOpenEdgeWitness(input: {
  curveType: string;
  length: number;
  endpoints: readonly [Vec3, Vec3];
  midpoint: Vec3;
}): EdgeWitnessV1 {
  const endpoints = input.endpoints
    .map(quantizedTopologyPoint)
    .sort(comparePoints) as [QuantizedTopologyPoint, QuantizedTopologyPoint];
  return {
    curveType: input.curveType,
    length: quantizeCoordinate(input.length),
    closed: false,
    endpoints,
    midpoint: quantizedTopologyPoint(input.midpoint)
  };
}

export function canonicalClosedEdgeWitness(input: {
  curveType: string;
  length: number;
  center: Vec3;
  axis: Vec3 | null;
}): EdgeWitnessV1 {
  return {
    curveType: input.curveType,
    length: quantizeCoordinate(input.length),
    closed: true,
    center: quantizedTopologyPoint(input.center),
    axis: input.axis
      ? quantizedTopologyDirection(canonicalDirection(input.axis))
      : null
  };
}

export function canonicalPlaneWitness(
  unitNormal: Vec3,
  offset: number
): Extract<FaceAnalyticWitnessV1, { kind: 'plane' }> {
  const { direction: normal, flipped } = canonicalizeDirection(unitNormal);
  return {
    kind: 'plane',
    normal: quantizedTopologyDirection(normal),
    offset: quantizeCoordinate(flipped ? -offset : offset)
  };
}

export function canonicalCylinderWitness(
  axisPoint: Vec3,
  unitAxis: Vec3,
  radius: number
): Extract<FaceAnalyticWitnessV1, { kind: 'cylinder' }> {
  const axis = canonicalDirection(unitAxis);
  const along =
    axisPoint.x * axis.x + axisPoint.y * axis.y + axisPoint.z * axis.z;
  const foot = {
    x: axisPoint.x - along * axis.x,
    y: axisPoint.y - along * axis.y,
    z: axisPoint.z - along * axis.z
  };
  return {
    kind: 'cylinder',
    axis: quantizedTopologyDirection(axis),
    axisFoot: quantizedTopologyPoint(foot),
    radius: quantizeCoordinate(radius)
  };
}

export function occtSurfaceClosure(
  surfaceType: string
): FaceWitnessV1['closure'] {
  switch (surfaceType.toLowerCase()) {
    case 'plane':
      return { u: 'open', v: 'open' };
    case 'cylinder':
    case 'cone':
    case 'sphere':
      return { u: 'closed', v: 'open' };
    case 'torus':
      return { u: 'closed', v: 'closed' };
    default:
      // The pinned OCCT bridge does not expose periodic-U/V surface flags.
      // Unknown must never be weakened to open for B-spline/NURBS faces.
      return { u: 'unknown', v: 'unknown' };
  }
}

export function edgeCandidate(
  witness: EdgeWitnessV1
): Extract<OcctTopologyCandidate, { kind: 'edge' }> {
  return {
    kind: 'edge',
    currentHash: topologyHashOfWitness('edge', witness),
    witness
  };
}

export function faceCandidate(
  witness: FaceWitnessV1
): Extract<OcctTopologyCandidate, { kind: 'face' }> {
  return {
    kind: 'face',
    currentHash: topologyHashOfWitness('face', witness),
    witness
  };
}

function referenceOf(
  candidate: OcctTopologyCandidate,
  producingFeatureId: FeatureId,
  lineageName: string
): TopologyReferenceV5 | null {
  const inspection =
    candidate.kind === 'edge'
      ? inspectTopologyWitness('edge', candidate.witness)
      : inspectTopologyWitness('face', candidate.witness);
  if (inspection.status !== 'supported') {
    return null;
  }
  return candidate.kind === 'edge'
    ? {
        kind: 'edge',
        producingFeatureId,
        lineageName,
        currentHash: candidate.currentHash,
        witnessVersion: 1,
        witness: candidate.witness
      }
    : {
        kind: 'face',
        producingFeatureId,
        lineageName,
        currentHash: candidate.currentHash,
        witnessVersion: 1,
        witness: candidate.witness
      };
}

function uniqueNamedReferences(
  proposals: readonly {
    candidate: OcctTopologyCandidate;
    name: string;
  }[],
  producingFeatureId: FeatureId
): TopologyReferenceV5[] {
  const nameCounts = new Map<string, number>();
  const candidateCounts = new Map<string, number>();
  for (const proposal of proposals) {
    nameCounts.set(proposal.name, (nameCounts.get(proposal.name) ?? 0) + 1);
    const key = `${proposal.candidate.kind}:${proposal.candidate.currentHash}`;
    candidateCounts.set(key, (candidateCounts.get(key) ?? 0) + 1);
  }
  return proposals.flatMap((proposal) => {
    const key = `${proposal.candidate.kind}:${proposal.candidate.currentHash}`;
    if (nameCounts.get(proposal.name) !== 1 || candidateCounts.get(key) !== 1) {
      return [];
    }
    const reference = referenceOf(
      proposal.candidate,
      producingFeatureId,
      proposal.name
    );
    return reference ? [reference] : [];
  });
}

function dominantAxis(
  direction: QuantizedTopologyPoint
): 'x' | 'y' | 'z' | null {
  const nonZero = direction
    .map((value, index) => ({ value: Math.abs(value), index }))
    .filter(({ value }) => value > 0);
  if (nonZero.length !== 1) {
    return null;
  }
  return (['x', 'y', 'z'] as const)[nonZero[0]!.index] ?? null;
}

function boxProposals(
  candidates: readonly OcctTopologyCandidate[]
): { candidate: OcctTopologyCandidate; name: string }[] {
  const proposals: { candidate: OcctTopologyCandidate; name: string }[] = [];
  const faces = candidates.filter(
    (
      candidate
    ): candidate is Extract<OcctTopologyCandidate, { kind: 'face' }> =>
      candidate.kind === 'face' && candidate.witness.analytic.kind === 'plane'
  );
  for (const axis of ['x', 'y', 'z'] as const) {
    const group = faces
      .filter(
        ({ witness }) =>
          witness.analytic.kind === 'plane' &&
          dominantAxis(witness.analytic.normal) === axis
      )
      .sort((left, right) => {
        const leftOffset =
          left.witness.analytic.kind === 'plane'
            ? left.witness.analytic.offset
            : 0;
        const rightOffset =
          right.witness.analytic.kind === 'plane'
            ? right.witness.analytic.offset
            : 0;
        return leftOffset - rightOffset;
      });
    if (group.length === 2) {
      proposals.push(
        {
          candidate: group[0]!,
          name: `primitive.box.face.${axis}-min`
        },
        {
          candidate: group[1]!,
          name: `primitive.box.face.${axis}-max`
        }
      );
    }
  }

  const edges = candidates.filter(
    (
      candidate
    ): candidate is Extract<OcctTopologyCandidate, { kind: 'edge' }> & {
      witness: Extract<EdgeWitnessV1, { closed: false }>;
    } => candidate.kind === 'edge' && !candidate.witness.closed
  );
  const allPoints = edges.flatMap(({ witness }) => [...witness.endpoints]);
  if (allPoints.length === 0) {
    return proposals;
  }
  const bounds = ([0, 1, 2] as const).map((index) => ({
    min: Math.min(...allPoints.map((point) => point[index])),
    max: Math.max(...allPoints.map((point) => point[index]))
  }));
  for (const edge of edges) {
    const varying = ([0, 1, 2] as const).filter(
      (index) =>
        edge.witness.endpoints[0][index] !== edge.witness.endpoints[1][index]
    );
    if (varying.length !== 1) {
      continue;
    }
    const varyingIndex = varying[0]!;
    const axis = (['x', 'y', 'z'] as const)[varyingIndex];
    const fixed = ([0, 1, 2] as const)
      .filter((index) => index !== varyingIndex)
      .map((index) => {
        const coordinate = edge.witness.endpoints[0][index];
        const side =
          coordinate === bounds[index]!.min
            ? 'min'
            : coordinate === bounds[index]!.max
              ? 'max'
              : null;
        return side ? `${(['x', 'y', 'z'] as const)[index]}-${side}` : null;
      });
    if (fixed.every((value): value is string => value !== null)) {
      proposals.push({
        candidate: edge,
        name: `primitive.box.edge.${axis}.${fixed.join('.')}`
      });
    }
  }
  return proposals;
}

function rotationalPrimitiveProposals(
  primitiveKind: Exclude<PrimitiveKind, 'box'>,
  candidates: readonly OcctTopologyCandidate[]
): { candidate: OcctTopologyCandidate; name: string }[] {
  // BrepKit intentionally leaves sphere topology hash-only because its
  // hemisphere carriers are not uniquely semantic across kernels.
  if (primitiveKind === 'sphere') {
    return [];
  }
  const proposals: { candidate: OcctTopologyCandidate; name: string }[] = [];
  const faces = candidates.filter(
    (
      candidate
    ): candidate is Extract<OcctTopologyCandidate, { kind: 'face' }> =>
      candidate.kind === 'face'
  );
  const primaryType =
    primitiveKind === 'cylinder'
      ? 'cylinder'
      : primitiveKind === 'cone'
        ? 'cone'
        : primitiveKind;
  const primaryFaces = faces.filter(
    ({ witness }) => witness.surfaceType === primaryType
  );
  if (primaryFaces.length === 1) {
    proposals.push({
      candidate: primaryFaces[0]!,
      name:
        primitiveKind === 'torus'
          ? 'primitive.torus.face.shell'
          : `primitive.${primitiveKind}.face.wall`
    });
  }
  const caps = faces
    .filter(({ witness }) => witness.surfaceType === 'plane')
    .sort((left, right) => {
      const leftZ = left.witness.centroid?.[2] ?? 0;
      const rightZ = right.witness.centroid?.[2] ?? 0;
      return leftZ - rightZ;
    });
  if (caps.length === 1) {
    proposals.push({
      candidate: caps[0]!,
      name: `primitive.${primitiveKind}.face.cap.start`
    });
  } else if (caps.length === 2) {
    proposals.push(
      {
        candidate: caps[0]!,
        name: `primitive.${primitiveKind}.face.cap.start`
      },
      {
        candidate: caps[1]!,
        name: `primitive.${primitiveKind}.face.cap.end`
      }
    );
  }
  const rims = candidates
    .filter(
      (
        candidate
      ): candidate is Extract<OcctTopologyCandidate, { kind: 'edge' }> & {
        witness: Extract<EdgeWitnessV1, { closed: true }>;
      } => candidate.kind === 'edge' && candidate.witness.closed
    )
    .sort((left, right) => left.witness.center[2] - right.witness.center[2]);
  if (rims.length === 1) {
    proposals.push({
      candidate: rims[0]!,
      name: `primitive.${primitiveKind}.edge.rim.start`
    });
  } else if (rims.length === 2) {
    proposals.push(
      {
        candidate: rims[0]!,
        name: `primitive.${primitiveKind}.edge.rim.start`
      },
      {
        candidate: rims[1]!,
        name: `primitive.${primitiveKind}.edge.rim.end`
      }
    );
  }
  return proposals;
}

/**
 * Publishes schema-v5 references for an imported STEP body (K0.6).
 *
 * The OpenCascade half of `createBrepKitImportedStepLineage`, deliberately the
 * same rule rather than a kernel-specific one: both adapters name imported
 * topology by its own exact ADR-011 witness, so the parity corpus can prove
 * that a face pick stored on an imported body resolves to the same identity on
 * either kernel. That is the question the Z3 route flip turns on, and it is
 * only answerable while both kernels are still here.
 */
export function importedStepLineage(
  producingFeatureId: FeatureId,
  candidates: readonly OcctTopologyCandidate[]
): OcctLineageState {
  return {
    status: 'lineage',
    references: uniqueNamedReferences(
      candidates.map((candidate) => ({
        candidate,
        name: importedStepLineageName(candidate.kind, candidate.currentHash)
      })),
      producingFeatureId
    ),
    diagnostics: []
  };
}

export function semanticPrimitiveLineage(
  producingFeatureId: FeatureId,
  primitiveKind: PrimitiveKind,
  candidates: readonly OcctTopologyCandidate[]
): OcctLineageState {
  const proposals =
    primitiveKind === 'box'
      ? boxProposals(candidates)
      : rotationalPrimitiveProposals(primitiveKind, candidates);
  return {
    status: 'lineage',
    references: uniqueNamedReferences(proposals, producingFeatureId),
    diagnostics: []
  };
}

function dotQuantized(
  point: QuantizedTopologyPoint,
  direction: QuantizedTopologyPoint
): number {
  return (
    point[0] * direction[0] + point[1] * direction[1] + point[2] * direction[2]
  );
}

export function semanticSweepLineage(
  producingFeatureId: FeatureId,
  descriptor: SweepSemanticDescriptor,
  candidates: readonly OcctTopologyCandidate[]
): OcctLineageState {
  const proposals: { candidate: OcctTopologyCandidate; name: string }[] = [];
  const diagnostics: TopologyLineageDiagnostic[] = [];
  const faces = candidates.filter(
    (
      candidate
    ): candidate is Extract<OcctTopologyCandidate, { kind: 'face' }> =>
      candidate.kind === 'face'
  );
  if (descriptor.kind === 'extrude' && descriptor.direction) {
    const normalizedDirection = unitDirection(descriptor.direction);
    if (!normalizedDirection) {
      return {
        status: 'lineage',
        references: [],
        diagnostics: [
          {
            kind: 'body',
            status: 'unsupported',
            featureId: producingFeatureId,
            message: 'Zero-length extrusion direction has no semantic lineage.'
          }
        ]
      };
    }
    const directedAxis = quantizedTopologyDirection(
      canonicalDirection(normalizedDirection)
    );
    const caps = faces
      .filter(
        ({ witness }) =>
          witness.analytic.kind === 'plane' &&
          pointKey(witness.analytic.normal) === pointKey(directedAxis)
      )
      .sort(
        (left, right) =>
          dotQuantized(left.witness.centroid ?? [0, 0, 0], directedAxis) -
          dotQuantized(right.witness.centroid ?? [0, 0, 0], directedAxis)
      );
    if (caps.length === 2) {
      const forward =
        descriptor.direction.x * (directedAxis[0] * GEOMETRY_LINEAR_TOLERANCE) +
          descriptor.direction.y *
            (directedAxis[1] * GEOMETRY_LINEAR_TOLERANCE) +
          descriptor.direction.z *
            (directedAxis[2] * GEOMETRY_LINEAR_TOLERANCE) >=
        0;
      proposals.push(
        {
          candidate: forward ? caps[0]! : caps[1]!,
          name: `sweep.face.cap.start.${descriptor.sourceKey}`
        },
        {
          candidate: forward ? caps[1]! : caps[0]!,
          name: `sweep.face.cap.end.${descriptor.sourceKey}`
        }
      );
    } else {
      diagnostics.push({
        kind: 'face',
        status: caps.length > 2 ? 'ambiguous' : 'unsupported',
        featureId: producingFeatureId,
        message: `Extrude cap lineage expected 2 exact plane carriers and found ${caps.length}.`
      });
    }
    for (const anchor of descriptor.sideAnchors ?? []) {
      const expected = pointKey(quantizedTopologyPoint(anchor.midpoint));
      const matches = faces.filter(
        ({ witness }) =>
          witness.centroid !== null && pointKey(witness.centroid) === expected
      );
      if (matches.length === 1) {
        proposals.push({ candidate: matches[0]!, name: anchor.lineageName });
      }
    }
    const sideFaces = faces.filter(
      ({ witness }) => witness.analytic.kind !== 'plane'
    );
    if (descriptor.sourceKind === 'circle' && sideFaces.length === 1) {
      proposals.push({
        candidate: sideFaces[0]!,
        name: `sweep.face.side.${descriptor.sourceKey}.circle`
      });
    }
  } else if (descriptor.sourceKind === 'circle' && faces.length === 1) {
    proposals.push({
      candidate: faces[0]!,
      name: `sweep.face.side.${descriptor.sourceKey}.circle`
    });
  } else {
    diagnostics.push({
      kind: 'body',
      status: 'unsupported',
      featureId: producingFeatureId,
      message:
        'OCCT revolution carriers cannot be mapped to BrepKit segment identities without an exact source-carrier match.'
    });
  }
  return {
    status: 'lineage',
    references: uniqueNamedReferences(proposals, producingFeatureId),
    diagnostics
  };
}

function coordinateFromQuantized(value: number): number {
  return value * GEOMETRY_LINEAR_TOLERANCE;
}

function directionFromQuantized(value: number): number {
  return (value * GEOMETRY_LINEAR_TOLERANCE) / DIRECTION_SCALE;
}

function transformPoint(
  point: QuantizedTopologyPoint,
  matrix: ArrayLike<number>
): QuantizedTopologyPoint {
  const x = coordinateFromQuantized(point[0]);
  const y = coordinateFromQuantized(point[1]);
  const z = coordinateFromQuantized(point[2]);
  return quantizedTopologyPoint({
    x: matrix[0]! * x + matrix[1]! * y + matrix[2]! * z + matrix[3]!,
    y: matrix[4]! * x + matrix[5]! * y + matrix[6]! * z + matrix[7]!,
    z: matrix[8]! * x + matrix[9]! * y + matrix[10]! * z + matrix[11]!
  });
}

function transformDirection(
  direction: QuantizedTopologyPoint,
  matrix: ArrayLike<number>
): Vec3 {
  const x = directionFromQuantized(direction[0]);
  const y = directionFromQuantized(direction[1]);
  const z = directionFromQuantized(direction[2]);
  return canonicalDirection({
    x: matrix[0]! * x + matrix[1]! * y + matrix[2]! * z,
    y: matrix[4]! * x + matrix[5]! * y + matrix[6]! * z,
    z: matrix[8]! * x + matrix[9]! * y + matrix[10]! * z
  });
}

function transformEdgeWitness(
  witness: EdgeWitnessV1,
  matrix: ArrayLike<number>
): EdgeWitnessV1 {
  if (witness.closed) {
    return {
      ...witness,
      center: transformPoint(witness.center, matrix),
      axis: witness.axis
        ? quantizedTopologyDirection(transformDirection(witness.axis, matrix))
        : null
    };
  }
  const endpoints = witness.endpoints
    .map((point) => transformPoint(point, matrix))
    .sort(comparePoints) as [QuantizedTopologyPoint, QuantizedTopologyPoint];
  return {
    ...witness,
    endpoints,
    midpoint: transformPoint(witness.midpoint, matrix)
  };
}

function transformFaceWitness(
  witness: FaceWitnessV1,
  matrix: ArrayLike<number>
): FaceWitnessV1 {
  let analytic: FaceAnalyticWitnessV1 = witness.analytic;
  if (witness.analytic.kind === 'plane') {
    const normal = transformDirection(witness.analytic.normal, matrix);
    const translation = {
      x: matrix[3]!,
      y: matrix[7]!,
      z: matrix[11]!
    };
    analytic = canonicalPlaneWitness(
      normal,
      coordinateFromQuantized(witness.analytic.offset) +
        normal.x * translation.x +
        normal.y * translation.y +
        normal.z * translation.z
    );
  } else if (witness.analytic.kind === 'cylinder') {
    const axis = transformDirection(witness.analytic.axis, matrix);
    const transformedFoot = transformPoint(witness.analytic.axisFoot, matrix);
    analytic = canonicalCylinderWitness(
      {
        x: coordinateFromQuantized(transformedFoot[0]),
        y: coordinateFromQuantized(transformedFoot[1]),
        z: coordinateFromQuantized(transformedFoot[2])
      },
      axis,
      coordinateFromQuantized(witness.analytic.radius)
    );
  }
  return {
    ...witness,
    centroid: witness.centroid
      ? transformPoint(witness.centroid, matrix)
      : null,
    analytic
  };
}

export function transformOcctWitness(
  kind: 'edge',
  witness: EdgeWitnessV1,
  matrix: ArrayLike<number>
): EdgeWitnessV1;
export function transformOcctWitness(
  kind: 'face',
  witness: FaceWitnessV1,
  matrix: ArrayLike<number>
): FaceWitnessV1;
export function transformOcctWitness(
  kind: 'edge' | 'face',
  witness: EdgeWitnessV1 | FaceWitnessV1,
  matrix: ArrayLike<number>
): EdgeWitnessV1 | FaceWitnessV1 {
  if (matrix.length !== 12) {
    throw new Error('Rigid transform matrix must contain 12 finite values.');
  }
  for (let index = 0; index < matrix.length; index += 1) {
    if (!Number.isFinite(matrix[index])) {
      throw new Error('Rigid transform matrix must contain 12 finite values.');
    }
  }
  return kind === 'edge'
    ? transformEdgeWitness(witness as EdgeWitnessV1, matrix)
    : transformFaceWitness(witness as FaceWitnessV1, matrix);
}

function candidateMatchesReference(
  candidate: OcctTopologyCandidate,
  reference: TopologyReferenceV5
): boolean {
  return (
    candidate.kind === reference.kind &&
    candidate.currentHash === reference.currentHash &&
    topologyWitnessesEqual(candidate.kind, candidate.witness, reference.witness)
  );
}

export function propagateRigidTransformLineage(
  source: OcctLineageState,
  resultCandidates: readonly OcctTopologyCandidate[],
  matrix: ArrayLike<number>
): OcctLineageState {
  if (source.status === 'hash-only') {
    return source;
  }
  const references: TopologyReferenceV5[] = [];
  const diagnostics: TopologyLineageDiagnostic[] = [];
  for (const sourceReference of source.references) {
    const expectedReference: TopologyReferenceV5 =
      sourceReference.kind === 'edge'
        ? (() => {
            const witness = transformOcctWitness(
              'edge',
              sourceReference.witness,
              matrix
            );
            return {
              ...sourceReference,
              currentHash: topologyHashOfWitness('edge', witness),
              witness
            };
          })()
        : (() => {
            const witness = transformOcctWitness(
              'face',
              sourceReference.witness,
              matrix
            );
            return {
              ...sourceReference,
              currentHash: topologyHashOfWitness('face', witness),
              witness
            };
          })();
    const matches = resultCandidates.filter((candidate) =>
      candidateMatchesReference(candidate, expectedReference)
    );
    if (matches.length !== 1) {
      diagnostics.push({
        kind: sourceReference.kind,
        status: matches.length > 1 ? 'ambiguous' : 'unsupported',
        featureId: sourceReference.producingFeatureId,
        message: `${sourceReference.kind} lineage ${sourceReference.lineageName} had ${matches.length} exact transform matches.`
      });
      continue;
    }
    const match = matches[0]!;
    const verification =
      sourceReference.kind === 'edge' &&
      expectedReference.kind === 'edge' &&
      match.kind === 'edge'
        ? verifyTopologyEvolution({
            operation: 'rigid-transform',
            kind: 'edge',
            sourceWitness: sourceReference.witness,
            resultWitness: match.witness,
            relation: {
              kind: 'known-transform',
              expectedResultWitness: expectedReference.witness
            }
          })
        : sourceReference.kind === 'face' &&
            expectedReference.kind === 'face' &&
            match.kind === 'face'
          ? verifyTopologyEvolution({
              operation: 'rigid-transform',
              kind: 'face',
              sourceWitness: sourceReference.witness,
              resultWitness: match.witness,
              relation: {
                kind: 'known-transform',
                expectedResultWitness: expectedReference.witness
              }
            })
          : {
              status: 'rejected' as const,
              reason: 'Transform lineage kind mismatch.'
            };
    if (verification.status !== 'verified') {
      diagnostics.push({
        kind: sourceReference.kind,
        status: 'unsupported',
        featureId: sourceReference.producingFeatureId,
        message: `${sourceReference.kind} lineage ${sourceReference.lineageName} failed exact transform verification.`
      });
      continue;
    }
    references.push(expectedReference);
  }
  return { status: 'lineage', references, diagnostics };
}

export function referenceForOcctCandidate(
  state: OcctLineageState | undefined,
  candidate: OcctTopologyCandidate
): EdgeTopologyReferenceV5 | FaceTopologyReferenceV5 | undefined {
  if (!state || state.status === 'hash-only') {
    return undefined;
  }
  const matches = state.references.filter((reference) =>
    candidateMatchesReference(candidate, reference)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveOcctTopologyReference(
  reference: TopologyReferenceV5,
  state: OcctLineageState | undefined,
  candidates: readonly OcctTopologyCandidate[],
  fallbackOperation: TopologyLineageOperation
): TopologyResolutionResult {
  const resolutionCandidates: TopologyResolutionCandidate[] = candidates.map(
    (candidate, index) => {
      const currentReference = referenceForOcctCandidate(state, candidate);
      const lineage = currentReference
        ? {
            source: 'derived' as const,
            identity: {
              producingFeatureId: currentReference.producingFeatureId,
              lineageName: currentReference.lineageName
            }
          }
        : undefined;
      return candidate.kind === 'edge'
        ? {
            kind: 'edge',
            currentHash: candidate.currentHash,
            witnessVersion: 1,
            witness: candidate.witness,
            value: index,
            ...(lineage ? { lineage } : {})
          }
        : {
            kind: 'face',
            currentHash: candidate.currentHash,
            witnessVersion: 1,
            witness: candidate.witness,
            value: index,
            ...(lineage ? { lineage } : {})
          };
    }
  );
  return resolveTopologyReference(
    reference,
    resolutionCandidates,
    state?.status === 'lineage'
      ? { status: 'available' }
      : { status: 'unsupported', operation: fallbackOperation }
  );
}
