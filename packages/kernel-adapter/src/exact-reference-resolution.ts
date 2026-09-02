/**
 * Fail-closed resolution of persisted schema-v5 face and edge references
 * against a live build: unique-witness matching with repair candidates, and
 * the edge-modifier target resolution that refuses ambiguity by design.
 */
import type { RemusKernel } from './remus-runtime';
import type {
  EdgeTopologyReferenceV5,
  FaceTopologyReferenceV5
} from '@openzcad/shared';
import type { ExactShape } from './exact-types';
import {
  ambiguousReferenceError,
  unresolvedReferenceError
} from './topology-fingerprint';
import {
  resolveTopologyReference,
  topologyHashOfWitness,
  topologyWitnessesEqual,
  type TopologyResolutionCandidate
} from './topology-lineage';
import {
  edgeHandlesByFingerprint,
  edgeWitnessOf,
  faceHandlesByFingerprint,
  faceWitnessOf
} from './exact-witnesses';

export function resolveFeatureFaces(
  kernel: RemusKernel,
  shape: ExactShape,
  hashes: readonly number[],
  references: readonly FaceTopologyReferenceV5[] | undefined,
  label: string
): number[] {
  if (shape.solids.length !== 1) {
    throw new Error(`${label} requires a body containing exactly one solid.`);
  }
  const solid = shape.solids[0]!;
  const handles = Array.from(kernel.getSolidFaces(solid));
  const candidates: TopologyResolutionCandidate[] = handles.map((handle) => {
    const witness = faceWitnessOf(kernel, handle);
    const lineageReference = shape.lineage?.faceReferences.get(handle);
    return {
      kind: 'face',
      currentHash: topologyHashOfWitness('face', witness),
      witnessVersion: 1,
      witness,
      ...(lineageReference
        ? {
            lineage: {
              source: 'semantic' as const,
              identity: {
                producingFeatureId: lineageReference.producingFeatureId,
                lineageName: lineageReference.lineageName
              }
            }
          }
        : {}),
      value: handle
    };
  });
  const referenceByHash = new Map(
    references?.map((reference) => [reference.currentHash, reference]) ?? []
  );
  const legacyHandles = faceHandlesByFingerprint(kernel, solid);
  const resolved = hashes.map((hash) => {
    const reference = referenceByHash.get(hash);
    if (reference) {
      const resolution = resolveTopologyReference(reference, candidates);
      if (resolution.status === 'failed') {
        throw new Error(`${label} face is stale: ${resolution.message}`);
      }
      if (typeof resolution.candidate.value !== 'number') {
        throw new Error(
          `${label} face could not be found on the rebuilt body.`
        );
      }
      return resolution.candidate.value;
    }
    const matches = legacyHandles.get(hash) ?? [];
    if (matches.length === 0) {
      throw unresolvedReferenceError('face', hash, handles.length);
    }
    if (matches.length > 1) {
      throw ambiguousReferenceError('face');
    }
    return matches[0]!;
  });
  if (new Set(resolved).size !== resolved.length) {
    throw new Error(`${label} faces do not resolve to a unique set.`);
  }
  return resolved;
}

/**
 * A verified v5 reference for one legacy-resolved edge, or null when the
 * body's lineage cannot vouch for it. `currentHash` must equal the stored
 * hash: the repair leaves `edgeHashes` untouched, and the resolver requires
 * every persisted reference to match a stored hash exactly.
 */
export function edgeReferenceRepairCandidate(
  kernel: RemusKernel,
  shape: ExactShape,
  handle: number,
  storedHash: number
): EdgeTopologyReferenceV5 | null {
  const reference = shape.lineage?.edgeReferences.get(handle);
  if (!reference || reference.currentHash !== storedHash) {
    return null;
  }
  const witness = edgeWitnessOf(kernel, handle);
  return topologyHashOfWitness('edge', witness) === storedHash &&
    topologyWitnessesEqual('edge', reference.witness, witness)
    ? reference
    : null;
}

export function resolveEdgeModifierEdges(
  kernel: RemusKernel,
  shape: ExactShape,
  solid: number,
  hashes: readonly number[],
  references: readonly EdgeTopologyReferenceV5[] | undefined
): {
  handles: number[];
  /**
   * Set only when a hash-only (legacy) selection resolved AND the body's
   * lineage proves a v5 reference for every selected edge — the one moment a
   * legacy edge modifier can be upgraded in place. Null otherwise.
   */
  repairedReferences: EdgeTopologyReferenceV5[] | null;
} {
  const handles = Array.from(kernel.getSolidEdges(solid));
  const legacyHandles = edgeHandlesByFingerprint(kernel, solid);
  const requested = [...new Set(hashes)];

  // Collapsing a multi-solid body can fuse and post-process its topology. The
  // source handles and semantic references no longer describe that result, so
  // preserve the existing unique-hash resolver for this deliberately
  // unsupported lineage boundary.
  if (shape.solids.length !== 1) {
    return {
      handles: requested.map((hash) => {
        const matches = legacyHandles.get(hash) ?? [];
        if (matches.length === 0) {
          throw unresolvedReferenceError('edge', hash, handles.length);
        }
        if (matches.length > 1) {
          throw ambiguousReferenceError('edge');
        }
        return matches[0]!;
      }),
      repairedReferences: null
    };
  }

  const candidates: TopologyResolutionCandidate[] = handles.map((handle) => {
    const witness = edgeWitnessOf(kernel, handle);
    const lineageReference = shape.lineage?.edgeReferences.get(handle);
    return {
      kind: 'edge',
      currentHash: topologyHashOfWitness('edge', witness),
      witnessVersion: 1,
      witness,
      ...(lineageReference
        ? {
            lineage: {
              source: 'semantic' as const,
              identity: {
                producingFeatureId: lineageReference.producingFeatureId,
                lineageName: lineageReference.lineageName
              }
            }
          }
        : {}),
      value: handle
    };
  });
  const requestedSet = new Set(requested);
  const referencesByHash = new Map<number, EdgeTopologyReferenceV5[]>();
  for (const reference of references ?? []) {
    if (!requestedSet.has(reference.currentHash)) {
      throw new Error(
        'Edge modifier references do not match the selected edge hashes.'
      );
    }
    const matches = referencesByHash.get(reference.currentHash) ?? [];
    matches.push(reference);
    referencesByHash.set(reference.currentHash, matches);
  }

  const repairCandidates: (EdgeTopologyReferenceV5 | null)[] = [];
  const resolved = requested.map((hash) => {
    const storedReferences = referencesByHash.get(hash) ?? [];
    if (storedReferences.length > 1) {
      throw new Error(
        'Edge modifier lineage contains duplicate references for one selected edge.'
      );
    }
    const reference = storedReferences[0];
    if (reference) {
      const resolution = resolveTopologyReference(reference, candidates);
      if (resolution.status === 'failed') {
        throw new Error(`Edge modifier edge is stale: ${resolution.message}`);
      }
      if (typeof resolution.candidate.value !== 'number') {
        throw new Error(
          'Edge modifier edge could not be found on the rebuilt body.'
        );
      }
      return resolution.candidate.value;
    }

    if (references !== undefined) {
      throw new Error(
        'Edge modifier lineage is missing a reference for one selected edge.'
      );
    }

    // A selected hash without a v5 reference is a legacy document edge. Keep
    // its old resolver and diagnostics; a v5 failure above is terminal and
    // never reaches this fallback.
    const matches = legacyHandles.get(hash) ?? [];
    if (matches.length === 0) {
      throw unresolvedReferenceError('edge', hash, handles.length);
    }
    if (matches.length > 1) {
      throw ambiguousReferenceError('edge');
    }
    const handle = matches[0]!;
    repairCandidates.push(
      edgeReferenceRepairCandidate(kernel, shape, handle, hash)
    );
    return handle;
  });
  if (new Set(resolved).size !== resolved.length) {
    throw new Error('Edge modifier edges do not resolve to a unique set.');
  }
  // All-or-nothing, and only for a fully hash-only selection: a partial
  // reference list would violate the persisted contract that every stored
  // reference matches a stored hash. Distinct lineage identities guard
  // against a publisher ever vouching for two edges with one role.
  const verified = repairCandidates.filter(
    (candidate): candidate is EdgeTopologyReferenceV5 => candidate !== null
  );
  const repairedReferences =
    references === undefined &&
    verified.length === requested.length &&
    new Set(
      verified.map(
        (candidate) =>
          `${candidate.producingFeatureId}:${candidate.lineageName}`
      )
    ).size === verified.length
      ? verified
      : null;
  return { handles: resolved, repairedReferences };
}
