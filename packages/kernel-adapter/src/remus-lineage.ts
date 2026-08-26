import type {
  EdgeTopologyReferenceV5,
  EdgeWitnessV1,
  FaceTopologyReferenceV5,
  FaceWitnessV1,
  FeatureId,
  QuantizedTopologyPoint,
  TopologyReferenceV5
} from '@openzcad/shared';
import type { FaceEvolutionPayloadV1 } from './remus-runtime';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';
import {
  importedStepLineageName,
  inspectTopologyWitness,
  topologyHashOfWitness,
  topologyWitnessesEqual,
  topologyWitnessesNearlyEqual,
  verifyTopologyEvolution,
  type TopologyKind,
  type TopologyLineageOperation,
  type TopologyWitnessV1
} from './topology-lineage';

const DIRECTION_SCALE = 1_000_000_000;
const MATRIX_EPSILON = 1e-9;

export type RemusLineageDiagnosticCode =
  | 'hash-only'
  | 'invalid-semantic-witness'
  | 'ambiguous-semantic-role'
  | 'transform-deleted'
  | 'transform-split'
  | 'transform-merge'
  | 'invalid-transform'
  | 'invalid-evolution-payload';

export interface RemusLineageDiagnostic {
  readonly code: RemusLineageDiagnosticCode;
  readonly operation: TopologyLineageOperation;
  readonly message: string;
  readonly topologyKind?: TopologyKind;
  readonly lineageName?: string;
  readonly sourceHandle?: number;
  readonly resultHandles?: readonly number[];
}

export interface RemusLineageState {
  readonly faceReferences: Map<number, FaceTopologyReferenceV5>;
  readonly edgeReferences: Map<number, EdgeTopologyReferenceV5>;
  readonly diagnostics: RemusLineageDiagnostic[];
}

export interface RemusTopologyCandidate {
  readonly handle: number;
  readonly kind: TopologyKind;
  readonly witness: TopologyWitnessV1;
}

export interface RemusSemanticAssignment extends RemusTopologyCandidate {
  readonly lineageName: string;
}

function emptyLineageState(): RemusLineageState {
  return {
    faceReferences: new Map(),
    edgeReferences: new Map(),
    diagnostics: []
  };
}

function semanticReference(
  producingFeatureId: FeatureId,
  assignment: RemusSemanticAssignment
): TopologyReferenceV5 {
  if (assignment.kind === 'edge') {
    const witness = assignment.witness as EdgeWitnessV1;
    return {
      kind: 'edge',
      producingFeatureId,
      lineageName: assignment.lineageName,
      currentHash: topologyHashOfWitness('edge', witness),
      witnessVersion: 1,
      witness
    };
  }
  const witness = assignment.witness as FaceWitnessV1;
  return {
    kind: 'face',
    producingFeatureId,
    lineageName: assignment.lineageName,
    currentHash: topologyHashOfWitness('face', witness),
    witnessVersion: 1,
    witness
  };
}

/**
 * Publishes semantic construction names only when both the name and handle
 * are unique and the exact witness satisfies ADR-013.
 */
export function createRemusSemanticLineage(
  producingFeatureId: FeatureId,
  operation:
    | 'primitive'
    | 'sweep'
    | 'imported-step'
    | 'fillet'
    | 'chamfer'
    | 'direct-edit',
  assignments: readonly RemusSemanticAssignment[]
): RemusLineageState {
  const state = emptyLineageState();
  const roleCounts = new Map<string, number>();
  const handleCounts = new Map<string, number>();
  for (const assignment of assignments) {
    const roleKey = `${assignment.kind}:${assignment.lineageName}`;
    const handleKey = `${assignment.kind}:${assignment.handle}`;
    roleCounts.set(roleKey, (roleCounts.get(roleKey) ?? 0) + 1);
    handleCounts.set(handleKey, (handleCounts.get(handleKey) ?? 0) + 1);
  }

  for (const assignment of assignments) {
    const roleKey = `${assignment.kind}:${assignment.lineageName}`;
    const handleKey = `${assignment.kind}:${assignment.handle}`;
    if (
      assignment.lineageName.trim().length === 0 ||
      roleCounts.get(roleKey) !== 1 ||
      handleCounts.get(handleKey) !== 1
    ) {
      state.diagnostics.push({
        code: 'ambiguous-semantic-role',
        operation,
        topologyKind: assignment.kind,
        lineageName: assignment.lineageName,
        sourceHandle: assignment.handle,
        message: `Semantic role ${assignment.lineageName || '<empty>'} is not one-to-one.`
      });
      continue;
    }
    const inspection =
      assignment.kind === 'edge'
        ? inspectTopologyWitness('edge', assignment.witness as EdgeWitnessV1)
        : inspectTopologyWitness('face', assignment.witness as FaceWitnessV1);
    if (inspection.status !== 'supported') {
      state.diagnostics.push({
        code: 'invalid-semantic-witness',
        operation,
        topologyKind: assignment.kind,
        lineageName: assignment.lineageName,
        sourceHandle: assignment.handle,
        message: `Semantic role ${assignment.lineageName} has an ${inspection.status} witness: ${inspection.reason}`
      });
      continue;
    }
    const reference = semanticReference(producingFeatureId, assignment);
    if (reference.kind === 'edge') {
      state.edgeReferences.set(assignment.handle, reference);
    } else {
      state.faceReferences.set(assignment.handle, reference);
    }
  }
  return state;
}

/**
 * Publishes schema-v5 references for an imported STEP body (K0.6).
 *
 * Imported topology has no feature contract to name it, so every candidate is
 * named by its own exact witness (see `importedStepLineageName`) and handed to
 * the same one-to-one, witness-inspected publisher modelled geometry uses.
 * Nothing is loosened for imports: an ambiguous name, a duplicate handle, or a
 * closed B-spline face publishes no reference and the topology stays hash-only,
 * exactly as ADR-013 requires.
 */
export function createRemusImportedStepLineage(
  producingFeatureId: FeatureId,
  candidates: readonly RemusTopologyCandidate[]
): RemusLineageState {
  return createRemusSemanticLineage(
    producingFeatureId,
    'imported-step',
    candidates.map((candidate) => ({
      ...candidate,
      lineageName: importedStepLineageName(
        candidate.kind,
        candidate.kind === 'edge'
          ? topologyHashOfWitness('edge', candidate.witness as EdgeWitnessV1)
          : topologyHashOfWitness('face', candidate.witness as FaceWitnessV1)
      )
    }))
  );
}

/**
 * Carries only source identities whose exact witnesses survive unchanged.
 * Moved, split, merged, or otherwise altered topology stays hash-only.
 */
export function propagateRemusUnchangedDirectEditLineage(
  source: RemusLineageState | undefined,
  results: readonly RemusTopologyCandidate[]
): RemusLineageState | undefined {
  if (!source) {
    return undefined;
  }
  const output = emptyLineageState();
  output.diagnostics.push(...source.diagnostics);
  const claimedResults = new Set<string>();
  let omitted = 0;
  const references: TopologyReferenceV5[] = [
    ...source.faceReferences.values(),
    ...source.edgeReferences.values()
  ];
  for (const reference of references) {
    const matches = results.filter(
      (candidate) =>
        candidate.kind === reference.kind &&
        topologyWitnessesEqual(
          reference.kind,
          reference.witness,
          candidate.witness
        )
    );
    if (matches.length !== 1) {
      omitted += 1;
      continue;
    }
    const match = matches[0]!;
    const key = `${match.kind}:${match.handle}`;
    if (claimedResults.has(key)) {
      omitted += 1;
      continue;
    }
    claimedResults.add(key);
    const inherited = transformedReference(reference, match.witness);
    if (inherited.kind === 'edge') {
      output.edgeReferences.set(match.handle, inherited);
    } else {
      output.faceReferences.set(match.handle, inherited);
    }
  }
  if (omitted > 0) {
    output.diagnostics.push({
      code: 'hash-only',
      operation: 'direct-edit',
      message: `direct-edit retained ${references.length - omitted} unchanged semantic references; ${omitted} changed or ambiguous references remain hash-only.`
    });
  }
  return output;
}

export function remusHashOnlyLineage(
  operation: TopologyLineageOperation,
  reason: string
): RemusLineageState {
  const state = emptyLineageState();
  state.diagnostics.push({
    code: 'hash-only',
    operation,
    message: `${operation} topology has no verified Remus lineage; ADR-011 hash fallback only. ${reason}`
  });
  return state;
}

export function mergeRemusLineageStates(
  states: readonly RemusLineageState[]
): RemusLineageState {
  const merged = emptyLineageState();
  for (const state of states) {
    for (const [handle, reference] of state.faceReferences) {
      merged.faceReferences.set(handle, reference);
    }
    for (const [handle, reference] of state.edgeReferences) {
      merged.edgeReferences.set(handle, reference);
    }
    merged.diagnostics.push(...state.diagnostics);
  }
  return merged;
}

function sameHandleSet(
  actual: readonly number[],
  expected: ReadonlySet<number>
): boolean {
  return (
    actual.length === expected.size &&
    new Set(actual).size === actual.length &&
    actual.every((handle) => expected.has(handle))
  );
}

function referenceMatchesCandidate(
  reference: FaceTopologyReferenceV5 | undefined,
  candidate: RemusTopologyCandidate | undefined
): reference is FaceTopologyReferenceV5 {
  if (!reference || !candidate || candidate.kind !== 'face') {
    return false;
  }
  const witness = candidate.witness as FaceWitnessV1;
  return (
    reference.currentHash === topologyHashOfWitness('face', witness) &&
    topologyWitnessesEqual('face', reference.witness, witness)
  );
}

function evolutionPayloadMatches(
  payload: FaceEvolutionPayloadV1,
  sourceSolid: number,
  resultSolid: number,
  sourceFaces: ReadonlySet<number>,
  resultFaces: ReadonlySet<number>
): boolean {
  if (
    payload.schemaVersion !== 1 ||
    payload.source.solid !== sourceSolid ||
    payload.result.solid !== resultSolid ||
    payload.evolution.provenance !== 'construction' ||
    payload.evolution.unresolvedSources.length !== 0 ||
    payload.evolution.unresolvedResults.length !== 0 ||
    !sameHandleSet(payload.source.faces, sourceFaces) ||
    !sameHandleSet(payload.result.faces, resultFaces)
  ) {
    return false;
  }

  const modifiedSources = new Set<number>();
  const modifiedResults = new Set<number>();
  for (const relation of payload.evolution.modified) {
    if (
      modifiedSources.has(relation.source) ||
      !sourceFaces.has(relation.source) ||
      relation.results.length === 0 ||
      new Set(relation.results).size !== relation.results.length ||
      relation.results.some(
        (handle) => !resultFaces.has(handle) || modifiedResults.has(handle)
      )
    ) {
      return false;
    }
    modifiedSources.add(relation.source);
    relation.results.forEach((handle) => modifiedResults.add(handle));
  }

  const deleted = new Set(payload.evolution.deleted);
  if (
    deleted.size !== payload.evolution.deleted.length ||
    [...deleted].some(
      (handle) => !sourceFaces.has(handle) || modifiedSources.has(handle)
    ) ||
    new Set([...modifiedSources, ...deleted]).size !== sourceFaces.size
  ) {
    return false;
  }

  const generatedResults = new Set<number>();
  const generatedPairs = new Set<string>();
  for (const relation of payload.evolution.generated) {
    if (!sourceFaces.has(relation.source) || relation.results.length === 0) {
      return false;
    }
    for (const handle of relation.results) {
      const pair = `${relation.source}:${handle}`;
      if (
        !resultFaces.has(handle) ||
        modifiedResults.has(handle) ||
        generatedPairs.has(pair)
      ) {
        return false;
      }
      generatedPairs.add(pair);
      generatedResults.add(handle);
    }
  }
  return (
    new Set([...modifiedResults, ...generatedResults]).size ===
      resultFaces.size &&
    [...resultFaces].every(
      (handle) => modifiedResults.has(handle) || generatedResults.has(handle)
    )
  );
}

function supportIdentity(reference: FaceTopologyReferenceV5): string {
  return reference.lineageName;
}

/**
 * Convert construction-history claims into exact, handle-bound lineage.
 * Generated blend faces are named by their two verified support identities;
 * malformed, unresolved, or ambiguous evidence publishes no reference.
 */
export function createRemusModifierEvolutionLineage(input: {
  readonly producingFeatureId: FeatureId;
  readonly operation: 'fillet' | 'chamfer';
  readonly payload: FaceEvolutionPayloadV1;
  readonly sourceSolid: number;
  readonly resultSolid: number;
  readonly sourceCandidates: readonly RemusTopologyCandidate[];
  readonly resultCandidates: readonly RemusTopologyCandidate[];
  readonly sourceLineage: RemusLineageState | undefined;
  readonly generatedBlendFaces: ReadonlySet<number>;
}): RemusLineageState {
  const sourceFaces = new Map(
    input.sourceCandidates
      .filter((candidate) => candidate.kind === 'face')
      .map((candidate) => [candidate.handle, candidate] as const)
  );
  const resultFaces = new Map(
    input.resultCandidates
      .filter((candidate) => candidate.kind === 'face')
      .map((candidate) => [candidate.handle, candidate] as const)
  );
  const payloadMatches = (() => {
    try {
      return evolutionPayloadMatches(
        input.payload,
        input.sourceSolid,
        input.resultSolid,
        new Set(sourceFaces.keys()),
        new Set(resultFaces.keys())
      );
    } catch {
      return false;
    }
  })();
  if (
    sourceFaces.size !==
      input.sourceCandidates.filter((candidate) => candidate.kind === 'face')
        .length ||
    resultFaces.size !==
      input.resultCandidates.filter((candidate) => candidate.kind === 'face')
        .length ||
    !payloadMatches
  ) {
    return remusHashOnlyLineage(
      input.operation,
      'The face-evolution payload did not match the exact production source and result domains.'
    );
  }

  const generatedSources = new Map<number, Set<number>>();
  for (const relation of input.payload.evolution.generated) {
    for (const result of relation.results) {
      const sources = generatedSources.get(result) ?? new Set<number>();
      sources.add(relation.source);
      generatedSources.set(result, sources);
    }
  }
  const assignments: RemusSemanticAssignment[] = [];
  for (const resultHandle of input.generatedBlendFaces) {
    const resultCandidate = resultFaces.get(resultHandle);
    const sources = [...(generatedSources.get(resultHandle) ?? [])];
    if (!resultCandidate || sources.length !== 2) {
      continue;
    }
    const references = sources.flatMap((handle) => {
      const reference = input.sourceLineage?.faceReferences.get(handle);
      return referenceMatchesCandidate(reference, sourceFaces.get(handle))
        ? [reference]
        : [];
    });
    const identities = references.map(supportIdentity).sort();
    if (
      identities.length !== 2 ||
      new Set(identities).size !== 2 ||
      new Set(references.map((reference) => reference.producingFeatureId))
        .size !== 1
    ) {
      continue;
    }
    assignments.push({
      ...resultCandidate,
      lineageName: `modifier.${input.operation}.face.band-between.${identities.join('|')}`
    });
  }

  return createRemusSemanticLineage(
    input.producingFeatureId,
    input.operation,
    assignments
  );
}

function matrixIsRigid(matrix: readonly number[]): boolean {
  if (
    matrix.length !== 16 ||
    matrix.some((value) => !Number.isFinite(value)) ||
    Math.abs(matrix[12]!) > MATRIX_EPSILON ||
    Math.abs(matrix[13]!) > MATRIX_EPSILON ||
    Math.abs(matrix[14]!) > MATRIX_EPSILON ||
    Math.abs(matrix[15]! - 1) > MATRIX_EPSILON
  ) {
    return false;
  }
  const columns = [
    [matrix[0]!, matrix[4]!, matrix[8]!],
    [matrix[1]!, matrix[5]!, matrix[9]!],
    [matrix[2]!, matrix[6]!, matrix[10]!]
  ];
  for (let index = 0; index < 3; index += 1) {
    const column = columns[index]!;
    const length = Math.hypot(...column);
    if (Math.abs(length - 1) > MATRIX_EPSILON) {
      return false;
    }
    for (let other = index + 1; other < 3; other += 1) {
      const candidate = columns[other]!;
      const dot =
        column[0]! * candidate[0]! +
        column[1]! * candidate[1]! +
        column[2]! * candidate[2]!;
      if (Math.abs(dot) > MATRIX_EPSILON) {
        return false;
      }
    }
  }
  const determinant =
    matrix[0]! * (matrix[5]! * matrix[10]! - matrix[6]! * matrix[9]!) -
    matrix[1]! * (matrix[4]! * matrix[10]! - matrix[6]! * matrix[8]!) +
    matrix[2]! * (matrix[4]! * matrix[9]! - matrix[5]! * matrix[8]!);
  return Math.abs(determinant - 1) <= MATRIX_EPSILON;
}

function transformCoordinatePoint(
  point: QuantizedTopologyPoint,
  matrix: readonly number[]
): QuantizedTopologyPoint {
  const x = point[0] * GEOMETRY_LINEAR_TOLERANCE;
  const y = point[1] * GEOMETRY_LINEAR_TOLERANCE;
  const z = point[2] * GEOMETRY_LINEAR_TOLERANCE;
  return [
    Math.round(
      (matrix[0]! * x + matrix[1]! * y + matrix[2]! * z + matrix[3]!) /
        GEOMETRY_LINEAR_TOLERANCE
    ),
    Math.round(
      (matrix[4]! * x + matrix[5]! * y + matrix[6]! * z + matrix[7]!) /
        GEOMETRY_LINEAR_TOLERANCE
    ),
    Math.round(
      (matrix[8]! * x + matrix[9]! * y + matrix[10]! * z + matrix[11]!) /
        GEOMETRY_LINEAR_TOLERANCE
    )
  ];
}

function canonicalDirection(direction: QuantizedTopologyPoint): {
  direction: QuantizedTopologyPoint;
  flipped: boolean;
} {
  const flipped =
    direction[0] < 0 ||
    (direction[0] === 0 &&
      (direction[1] < 0 || (direction[1] === 0 && direction[2] < 0)));
  return {
    direction: flipped
      ? [-direction[0], -direction[1], -direction[2]]
      : direction,
    flipped
  };
}

function rotateDirection(
  direction: QuantizedTopologyPoint,
  matrix: readonly number[]
) {
  const x = direction[0] / DIRECTION_SCALE;
  const y = direction[1] / DIRECTION_SCALE;
  const z = direction[2] / DIRECTION_SCALE;
  return canonicalDirection([
    Math.round(
      (matrix[0]! * x + matrix[1]! * y + matrix[2]! * z) * DIRECTION_SCALE
    ),
    Math.round(
      (matrix[4]! * x + matrix[5]! * y + matrix[6]! * z) * DIRECTION_SCALE
    ),
    Math.round(
      (matrix[8]! * x + matrix[9]! * y + matrix[10]! * z) * DIRECTION_SCALE
    )
  ]);
}

function transformFaceWitness(
  witness: FaceWitnessV1,
  matrix: readonly number[]
): FaceWitnessV1 {
  let analytic: FaceWitnessV1['analytic'];
  switch (witness.analytic.kind) {
    case 'none':
      analytic = witness.analytic;
      break;
    case 'plane': {
      const rotated = rotateDirection(witness.analytic.normal, matrix);
      const directionSign = rotated.flipped ? -1 : 1;
      const translationDot =
        directionSign *
        ((rotated.direction[0] / DIRECTION_SCALE) * matrix[3]! +
          (rotated.direction[1] / DIRECTION_SCALE) * matrix[7]! +
          (rotated.direction[2] / DIRECTION_SCALE) * matrix[11]!);
      const rawOffset =
        witness.analytic.offset +
        Math.round(translationDot / GEOMETRY_LINEAR_TOLERANCE);
      analytic = {
        kind: 'plane',
        normal: rotated.direction,
        offset: rotated.flipped ? -rawOffset : rawOffset
      };
      break;
    }
    case 'cylinder': {
      const axis = rotateDirection(witness.analytic.axis, matrix).direction;
      const movedFoot = transformCoordinatePoint(
        witness.analytic.axisFoot,
        matrix
      );
      const alongNumerator =
        movedFoot[0] * axis[0] +
        movedFoot[1] * axis[1] +
        movedFoot[2] * axis[2];
      analytic = {
        kind: 'cylinder',
        axis,
        axisFoot: [
          Math.round(
            movedFoot[0] - (alongNumerator * axis[0]) / DIRECTION_SCALE ** 2
          ),
          Math.round(
            movedFoot[1] - (alongNumerator * axis[1]) / DIRECTION_SCALE ** 2
          ),
          Math.round(
            movedFoot[2] - (alongNumerator * axis[2]) / DIRECTION_SCALE ** 2
          )
        ],
        radius: witness.analytic.radius
      };
      break;
    }
  }
  return {
    ...witness,
    centroid: witness.centroid
      ? transformCoordinatePoint(witness.centroid, matrix)
      : null,
    analytic
  };
}

export function transformRemusWitness(
  kind: TopologyKind,
  witness: TopologyWitnessV1,
  matrix: readonly number[]
): TopologyWitnessV1 | null {
  if (!matrixIsRigid(matrix)) {
    return null;
  }
  if (kind === 'face') {
    return transformFaceWitness(witness as FaceWitnessV1, matrix);
  }
  const edge = witness as EdgeWitnessV1;
  if (edge.closed) {
    return {
      ...edge,
      center: transformCoordinatePoint(edge.center, matrix),
      axis: edge.axis ? rotateDirection(edge.axis, matrix).direction : null
    };
  }
  const endpoints = edge.endpoints
    .map((point) => transformCoordinatePoint(point, matrix))
    .sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        const difference = left[index]! - right[index]!;
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    }) as [QuantizedTopologyPoint, QuantizedTopologyPoint];
  return {
    ...edge,
    endpoints,
    midpoint: transformCoordinatePoint(edge.midpoint, matrix)
  };
}

function transformedReference(
  reference: TopologyReferenceV5,
  witness: TopologyWitnessV1
): TopologyReferenceV5 {
  return reference.kind === 'edge'
    ? {
        ...reference,
        currentHash: topologyHashOfWitness('edge', witness as EdgeWitnessV1),
        witness: witness as EdgeWitnessV1
      }
    : {
        ...reference,
        currentHash: topologyHashOfWitness('face', witness as FaceWitnessV1),
        witness: witness as FaceWitnessV1
      };
}

/**
 * Inherits transform lineage only through unique exact transformed witnesses.
 * Deletion, split, merge, and generated-result conditions are reported and
 * left unreferenced rather than repaired by proximity or traversal order.
 */
export function propagateRemusRigidTransformLineage(
  source: RemusLineageState,
  results: readonly RemusTopologyCandidate[],
  matrix: readonly number[]
): RemusLineageState {
  const output = emptyLineageState();
  output.diagnostics.push(...source.diagnostics);
  if (!matrixIsRigid(matrix)) {
    output.diagnostics.push({
      code: 'invalid-transform',
      operation: 'rigid-transform',
      message: 'Transform lineage requires a finite, right-handed rigid matrix.'
    });
    return output;
  }

  const claimed = new Map<
    string,
    { handle: number; reference: TopologyReferenceV5 }[]
  >();
  const sources: TopologyReferenceV5[] = [
    ...source.faceReferences.values(),
    ...source.edgeReferences.values()
  ];
  for (const reference of sources) {
    const expected = transformRemusWitness(
      reference.kind,
      reference.witness,
      matrix
    );
    if (!expected) {
      continue;
    }
    const matches = results.filter(
      (candidate) =>
        candidate.kind === reference.kind &&
        // Near-equality, not exact: the expected witness carries quantized
        // rotation noise. Uniqueness below keeps the band fail-closed.
        topologyWitnessesNearlyEqual(
          reference.kind,
          expected,
          candidate.witness
        )
    );
    if (matches.length === 0) {
      output.diagnostics.push({
        code: 'transform-deleted',
        operation: 'rigid-transform',
        topologyKind: reference.kind,
        lineageName: reference.lineageName,
        message: `Transform result deleted lineage ${reference.lineageName}.`
      });
      continue;
    }
    if (matches.length > 1) {
      output.diagnostics.push({
        code: 'transform-split',
        operation: 'rigid-transform',
        topologyKind: reference.kind,
        lineageName: reference.lineageName,
        resultHandles: matches.map((candidate) => candidate.handle),
        message: `Transform lineage ${reference.lineageName} split into multiple exact results.`
      });
      continue;
    }
    const match = matches[0]!;
    const verification = verifyTopologyEvolution({
      operation: 'rigid-transform',
      kind: reference.kind,
      sourceWitness: reference.witness,
      resultWitness: match.witness,
      relation: { kind: 'known-transform', expectedResultWitness: expected }
    });
    if (verification.status !== 'verified') {
      output.diagnostics.push({
        code: 'invalid-transform',
        operation: 'rigid-transform',
        topologyKind: reference.kind,
        lineageName: reference.lineageName,
        resultHandles: [match.handle],
        message: `Transform lineage ${reference.lineageName} failed exact witness verification.`
      });
      continue;
    }
    const resultKey = `${reference.kind}:${match.handle}`;
    const claims = claimed.get(resultKey) ?? [];
    claims.push({
      handle: match.handle,
      reference: transformedReference(reference, match.witness)
    });
    claimed.set(resultKey, claims);
  }

  for (const [resultKey, claims] of claimed) {
    if (claims.length !== 1) {
      output.diagnostics.push({
        code: 'transform-merge',
        operation: 'rigid-transform',
        topologyKind: claims[0]!.reference.kind,
        resultHandles: [claims[0]!.handle],
        message: `Multiple source lineages merged into transform result ${resultKey}.`
      });
      continue;
    }
    const claim = claims[0]!;
    if (claim.reference.kind === 'edge') {
      output.edgeReferences.set(claim.handle, claim.reference);
    } else {
      output.faceReferences.set(claim.handle, claim.reference);
    }
  }
  return output;
}

export interface RemusEvolutionPayload {
  readonly solid: number;
  readonly evolution: {
    readonly modified: ReadonlyMap<number, readonly number[]>;
    readonly generated: ReadonlyMap<number, readonly number[]>;
    readonly deleted: readonly number[];
  };
}

function decodeHandleArray(value: unknown, label: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (candidate) =>
        !Number.isSafeInteger(candidate) || (candidate as number) < 0
    )
  ) {
    throw new Error(`${label} must be an array of non-negative safe integers.`);
  }
  return value as number[];
}

function decodeHandleMap(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const result = new Map<number, number[]>();
  for (const [key, handles] of Object.entries(value)) {
    if (!/^\d+$/.test(key)) {
      throw new Error(`${label} contains a non-handle key.`);
    }
    const handle = Number(key);
    if (!Number.isSafeInteger(handle) || result.has(handle)) {
      throw new Error(`${label} contains a duplicate or unsafe handle key.`);
    }
    result.set(handle, decodeHandleArray(handles, `${label}.${key}`));
  }
  return result;
}

function sameIntegerSet(left: ReadonlySet<number>, right: ReadonlySet<number>) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

/**
 * Strict decoder for the pinned runtime's undeclared deletion channel.
 *
 * A payload is accepted only when it names the actual production result and
 * proves complete, disjoint source and result partitions. Callers must not
 * downgrade a rejection to an empty deletion set.
 */
export function decodeVerifiedRemusEvolution(
  value: unknown,
  expected: {
    readonly resultSolid: number;
    readonly sourceFaces: readonly number[];
    readonly resultFaces: readonly number[];
  }
): RemusEvolutionPayload {
  try {
    if (typeof value !== 'string') {
      throw new Error('Evolution payload must be JSON text.');
    }
    const decoded: unknown = JSON.parse(value);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('Evolution payload root must be an object.');
    }
    const root = decoded as Record<string, unknown>;
    if (root.solid !== expected.resultSolid) {
      throw new Error('Evolution payload does not name the production result.');
    }
    if (
      !root.evolution ||
      typeof root.evolution !== 'object' ||
      Array.isArray(root.evolution)
    ) {
      throw new Error('Evolution payload has no evolution record.');
    }
    const evolution = root.evolution as Record<string, unknown>;
    const modified = decodeHandleMap(evolution.modified, 'modified');
    const generated = decodeHandleMap(evolution.generated, 'generated');
    const deleted = decodeHandleArray(evolution.deleted, 'deleted');
    const sourceSet = new Set(expected.sourceFaces);
    const resultSet = new Set(expected.resultFaces);
    if (
      sourceSet.size !== expected.sourceFaces.length ||
      resultSet.size !== expected.resultFaces.length
    ) {
      throw new Error('Expected source/result faces must be unique.');
    }
    const modifiedSources = new Set(modified.keys());
    if (
      [...modified.values(), ...generated.values()].some(
        (handles) => handles.length === 0
      ) ||
      [...generated.keys()].some((handle) => !sourceSet.has(handle))
    ) {
      throw new Error(
        'Modified/generated channels must map source faces to non-empty outputs.'
      );
    }
    const deletedSet = new Set(deleted);
    if (deletedSet.size !== deleted.length) {
      throw new Error('Deleted faces must be unique.');
    }
    if (
      [...modifiedSources].some(
        (handle) => !sourceSet.has(handle) || deletedSet.has(handle)
      ) ||
      [...deletedSet].some((handle) => !sourceSet.has(handle)) ||
      !sameIntegerSet(new Set([...modifiedSources, ...deletedSet]), sourceSet)
    ) {
      throw new Error(
        'Modified and deleted channels do not partition sources.'
      );
    }
    const outputs = [
      ...[...modified.values()].flat(),
      ...[...generated.values()].flat()
    ];
    const outputSet = new Set(outputs);
    if (
      outputSet.size !== outputs.length ||
      outputs.some((handle) => !resultSet.has(handle)) ||
      !sameIntegerSet(outputSet, resultSet)
    ) {
      throw new Error(
        'Modified and generated channels do not partition results.'
      );
    }
    return {
      solid: expected.resultSolid,
      evolution: { modified, generated, deleted }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid payload';
    throw new Error(`Remus evolution rejected: ${message}`, { cause: error });
  }
}
