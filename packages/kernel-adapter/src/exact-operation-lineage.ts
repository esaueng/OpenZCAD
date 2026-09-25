import type {
  FaceTopologyReferenceV5,
  FaceWitnessV1,
  FeatureId
} from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import type { HoleToolSpec } from './exact-cylinder-ops';
import {
  cylinderCarrier,
  planeCarrier,
  sameAnalyticCarrier,
  topologyCandidatesForSolid
} from './exact-lineage-builders';
import {
  createRemusSemanticLineage,
  mergeRemusLineageStates,
  type RemusLineageState,
  type RemusSemanticAssignment
} from './remus-lineage';
import {
  topologyHashOfWitness,
  topologyWitnessesEqual
} from './topology-lineage';
import { add, scale } from './exact-math';

/** Unique exact analytic carriers preserve face identity when only trims change. */
export function carryAnalyticFaces(
  kernel: RemusKernel,
  sourceSolid: number,
  resultSolid: number,
  source: RemusLineageState | undefined
): RemusLineageState {
  const state: RemusLineageState = {
    faceReferences: new Map(),
    edgeReferences: new Map(),
    diagnostics: []
  };
  if (!source) return state;
  const before = topologyCandidatesForSolid(kernel, sourceSolid).filter(
    (c) => c.kind === 'face'
  );
  const after = topologyCandidatesForSolid(kernel, resultSolid).filter(
    (c) => c.kind === 'face'
  );
  const identity = (r: FaceTopologyReferenceV5) =>
    JSON.stringify([r.producingFeatureId, r.lineageName]);
  for (const [handle, reference] of source.faceReferences) {
    const origin = before.find((c) => c.handle === handle);
    if (
      !origin ||
      reference.currentHash !==
        topologyHashOfWitness('face', reference.witness) ||
      !topologyWitnessesEqual('face', reference.witness, origin.witness) ||
      [...source.faceReferences.values()].filter(
        (r) => identity(r) === identity(reference)
      ).length !== 1
    )
      continue;
    const matchesWitness = (c: (typeof before)[number]) =>
      topologyWitnessesEqual('face', reference.witness, c.witness);
    let matches = after.filter(matchesWitness);
    if (before.filter(matchesWitness).length !== 1 || matches.length !== 1) {
      if (
        reference.witness.analytic.kind !== 'plane' &&
        reference.witness.analytic.kind !== 'cylinder'
      )
        continue;
      const matchesCarrier = (c: (typeof before)[number]) =>
        sameAnalyticCarrier(
          (c.witness as FaceWitnessV1).analytic,
          reference.witness.analytic
        );
      matches = after.filter(matchesCarrier);
      if (before.filter(matchesCarrier).length !== 1 || matches.length !== 1)
        continue;
    }
    const candidate = matches[0]!;
    const witness = candidate.witness as FaceWitnessV1;
    state.faceReferences.set(candidate.handle, {
      ...reference,
      witness,
      currentHash: topologyHashOfWitness('face', witness)
    });
  }
  return state;
}

/** Name a constructed face only when its exact carrier is unique in the result. */
export function assignCarrierFace(
  kernel: RemusKernel,
  solid: number,
  state: RemusLineageState,
  producer: FeatureId,
  name: string,
  carrier: FaceWitnessV1['analytic'] | null
): void {
  if (!carrier || carrier.kind === 'none') return;
  const matches = topologyCandidatesForSolid(kernel, solid).filter(
    (c) =>
      c.kind === 'face' &&
      sameAnalyticCarrier((c.witness as FaceWitnessV1).analytic, carrier)
  );
  if (matches.length !== 1 || state.faceReferences.has(matches[0]!.handle))
    return;
  const proven = createRemusSemanticLineage(producer, 'boolean', [
    { ...matches[0]!, lineageName: name }
  ]);
  for (const [handle, reference] of proven.faceReferences)
    state.faceReferences.set(handle, reference);
}

/**
 * A unique boundary between two named faces has a stable construction role.
 * Seams and repeated boundaries between the same pair remain unnamed.
 */
export function withBoundaryEdgeLineage(
  kernel: RemusKernel,
  solid: number,
  producer: FeatureId,
  source: RemusLineageState
): RemusLineageState {
  const candidates = topologyCandidatesForSolid(kernel, solid);
  const facesByEdge = new Map<number, number[]>();
  for (const face of kernel.getSolidFaces(solid)) {
    for (const edge of new Set(kernel.getFaceEdges(face))) {
      const faces = facesByEdge.get(edge) ?? [];
      faces.push(face);
      facesByEdge.set(edge, faces);
    }
  }
  const assignments: RemusSemanticAssignment[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== 'edge') continue;
    const faces = facesByEdge.get(candidate.handle) ?? [];
    if (faces.length !== 2) continue;
    const references = faces.map((face) => source.faceReferences.get(face));
    if (references.some((reference) => !reference)) continue;
    const verified = references as FaceTopologyReferenceV5[];
    if (
      verified.some(
        (reference) =>
          [...source.faceReferences.values()].filter(
            (other) =>
              other.producingFeatureId === reference.producingFeatureId &&
              other.lineageName === reference.lineageName
          ).length !== 1
      )
    )
      continue;
    const identities = verified
      .map((r) => JSON.stringify([r.producingFeatureId, r.lineageName]))
      .sort();
    if (identities[0] === identities[1]) continue;
    for (let i = 0; i < faces.length; i++) {
      const face = candidates.find(
        (c) => c.kind === 'face' && c.handle === faces[i]
      );
      if (
        !face ||
        !topologyWitnessesEqual('face', verified[i]!.witness, face.witness) ||
        verified[i]!.currentHash !==
          topologyHashOfWitness('face', verified[i]!.witness)
      ) {
        references.length = 0;
        break;
      }
    }
    if (references.length !== 2) continue;
    assignments.push({
      ...candidate,
      lineageName: `boundary.edge.${JSON.stringify(identities)}`
    });
  }
  // The semantic publisher rejects every repeated role, rather than choosing
  // an edge by traversal order or proximity.
  return mergeRemusLineageStates([
    createRemusSemanticLineage(producer, 'boolean', assignments),
    source
  ]);
}

export function holeLineage(
  kernel: RemusKernel,
  sourceSolid: number,
  resultSolid: number,
  source: RemusLineageState | undefined,
  producer: FeatureId,
  spec: HoleToolSpec
): RemusLineageState {
  const state = carryAnalyticFaces(kernel, sourceSolid, resultSolid, source);
  assignCarrierFace(
    kernel,
    resultSolid,
    state,
    producer,
    'hole.face.bore',
    cylinderCarrier(spec.surfacePoint, spec.axis, spec.radius)
  );
  if (
    spec.style === 'counterbore' &&
    spec.counterboreRadius !== undefined &&
    spec.counterboreDepth !== undefined
  ) {
    assignCarrierFace(
      kernel,
      resultSolid,
      state,
      producer,
      'hole.face.counterbore',
      cylinderCarrier(spec.surfacePoint, spec.axis, spec.counterboreRadius)
    );
    assignCarrierFace(
      kernel,
      resultSolid,
      state,
      producer,
      'hole.face.shoulder',
      planeCarrier(
        spec.axis,
        add(spec.surfacePoint, scale(spec.axis, spec.counterboreDepth))
      )
    );
  }
  if (spec.exitExtension === 0) {
    assignCarrierFace(
      kernel,
      resultSolid,
      state,
      producer,
      'hole.face.floor',
      planeCarrier(
        spec.axis,
        add(spec.surfacePoint, scale(spec.axis, spec.depth))
      )
    );
  }
  return withBoundaryEdgeLineage(kernel, resultSolid, producer, state);
}
