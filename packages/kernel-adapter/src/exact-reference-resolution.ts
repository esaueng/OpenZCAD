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
  lineageAvailabilityFor,
  resolveTopologyReference,
  topologyHashOfWitness,
  topologyWitnessesEqual,
  type TopologyResolutionCandidate
} from './topology-lineage';
import {
  carryEdgeSelection,
  edgeTopologyLayout,
  rememberEdgeSelection,
  type EdgeSelectionMemory,
  type EdgeTopologyLayout,
  type LayoutEdge
} from './exact-edge-selection-transport';
import { AdapterRefusal } from './adapter-refusal';
import type { UpstreamSnapshot } from './exact-carry-edit-gate';
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
      const resolution = resolveTopologyReference(
        reference,
        candidates,
        shape.lineage
          ? lineageAvailabilityFor('face', candidates)
          : { status: 'available' }
      );
      if (resolution.status === 'failed') {
        const message = `${label} face is stale: ${resolution.message}`;
        throw resolution.reason === 'lineage-not-found'
          ? new AdapterRefusal('reference_missing', message)
          : new Error(message);
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
  references: readonly EdgeTopologyReferenceV5[] | undefined,
  /**
   * The adapter's selection memory and this feature's key in it
   * (`exact-edge-selection-transport.ts`). Every hash-only resolution is
   * recorded, which changes no output. Only with `propose` (an edit's
   * preview or validation build) may a stored hash that no longer resolves
   * be carried, and the carry is reported for the app to store; otherwise it
   * refuses exactly as it always did, so a plain build of a document is the
   * same on every adapter. `upstream` is the features before this one, for
   * the dimension-edit gate.
   */
  carry?: {
    memory: EdgeSelectionMemory;
    key: string;
    propose: boolean;
    upstream: () => UpstreamSnapshot | null;
  },
  /**
   * Told whenever a stored hash-only pick no longer resolves as stored, the
   * one place a carry-proposing build can diverge from a plain build of the
   * same document (it carries where the plain build refuses). The history
   * cache reads it to decide whether the two builds' checkpoints are
   * interchangeable. Called before the refusal or carry; changes nothing.
   */
  onUnresolvedHash?: () => void
): {
  handles: number[];
  /**
   * Set only when a hash-only selection resolved through its recorded
   * position because an upstream edit moved its edges: the stored hashes,
   * deduplicated in stored order, and the current hash of each, so the app
   * can persist the selection where it now is. Null otherwise.
   */
  carriedHashes: { from: number[]; to: number[] } | null;
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
  // preserve unique-hash resolution for legacy picks. A v5 pick below still
  // needs a unique complete witness on the collapsed result.
  if (shape.solids.length !== 1 && references === undefined) {
    return {
      handles: requested.map((hash) => {
        const matches = legacyHandles.get(hash) ?? [];
        if (matches.length === 0) {
          onUnresolvedHash?.();
          throw unresolvedReferenceError('edge', hash, handles.length);
        }
        if (matches.length > 1) {
          throw ambiguousReferenceError('edge');
        }
        return matches[0]!;
      }),
      repairedReferences: null,
      carriedHashes: null
    };
  }

  const lineage = shape.solids.length === 1 ? shape.lineage : undefined;

  // Measured once: the candidates, the carried hashes and the layout all
  // read these.
  const measured: LayoutEdge[] = handles.map((handle) => {
    const witness = edgeWitnessOf(kernel, handle);
    return {
      handle,
      witness,
      hash: topologyHashOfWitness('edge', witness)
    };
  });
  const hashOfHandle = new Map(
    measured.map((edge) => [edge.handle, edge.hash])
  );
  const candidates: TopologyResolutionCandidate[] = measured.map(
    ({ handle, witness, hash }) => {
    const lineageReference = lineage?.edgeReferences.get(handle);
    return {
      kind: 'edge',
      currentHash: hash,
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
    }
  );
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
  const missing: number[] = [];
  const direct: { storedHash: number; handle: number }[] = [];
  const resolved = requested.map((hash): number | null => {
    const storedReferences = referencesByHash.get(hash) ?? [];
    if (storedReferences.length > 1) {
      throw new Error(
        'Edge modifier lineage contains duplicate references for one selected edge.'
      );
    }
    const reference = storedReferences[0];
    if (reference) {
      const resolution = resolveTopologyReference(
        reference,
        candidates,
        shape.solids.length !== 1
          ? { status: 'unsupported', operation: 'fillet' }
          : lineage
            ? lineageAvailabilityFor('edge', candidates)
            : { status: 'available' }
      );
      if (resolution.status === 'failed') {
        const message = `Edge modifier edge is stale: ${resolution.message}`;
        // A name the body no longer publishes is a lost reference, the same
        // verdict a vanished hash gets; the card branches on the code.
        throw resolution.reason === 'lineage-not-found'
          ? new AdapterRefusal('reference_missing', message)
          : new Error(message);
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
    if (matches.length > 1) {
      throw ambiguousReferenceError('edge');
    }
    if (matches.length === 0) {
      // The fingerprint embeds the edge's dimensions, so an upstream resize
      // orphans it although the edge may still be there. Without a carry it
      // refuses here; with one, the whole selection is judged below.
      onUnresolvedHash?.();
      if (!carry?.propose)
        throw unresolvedReferenceError('edge', hash, handles.length);
      missing.push(hash);
      repairCandidates.push(null);
      return null;
    }
    const handle = matches[0]!;
    direct.push({ storedHash: hash, handle });
    repairCandidates.push(
      edgeReferenceRepairCandidate(kernel, shape, handle, hash)
    );
    return handle;
  });
  // Only a hash-only selection reaches here with `missing` entries: a named
  // one resolves by lineage or throws above.
  let layout: EdgeTopologyLayout | undefined;
  let carried: Map<number, number> | null = null;
  let upstream: UpstreamSnapshot | null | undefined;
  const upstreamOnce = () => (upstream ??= carry?.upstream() ?? null);
  if (carry?.propose && missing.length > 0) {
    layout = edgeTopologyLayout(kernel, solid, measured);
    carried = carryEdgeSelection(
      carry.memory,
      carry.key,
      layout,
      measured,
      direct,
      missing,
      upstreamOnce()
    );
    if (!carried) {
      throw unresolvedReferenceError('edge', missing[0]!, handles.length);
    }
  }
  const handlesResolved = resolved.map(
    (handle, index) => handle ?? carried!.get(requested[index]!)!
  );
  // A carried edge offers the lineage repair a build of the stored result
  // would: the one for its own, new hash.
  for (let index = 0; index < resolved.length; index += 1) {
    if (resolved[index] !== null) continue;
    const handle = handlesResolved[index]!;
    repairCandidates[index] = edgeReferenceRepairCandidate(
      kernel,
      shape,
      handle,
      hashOfHandle.get(handle)!
    );
  }
  if (new Set(handlesResolved).size !== handlesResolved.length) {
    throw new Error('Edge modifier edges do not resolve to a unique set.');
  }
  if (carry && references === undefined) {
    rememberEdgeSelection(
      carry.memory,
      carry.key,
      kernel,
      solid,
      measured,
      requested.map((storedHash, index) => ({
        storedHash,
        handle: handlesResolved[index]!
      })),
      upstreamOnce,
      layout
    );
  }
  const carriedHashes = carried
    ? {
        from: [...requested],
        to: handlesResolved.map((handle) => hashOfHandle.get(handle)!)
      }
    : null;
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
  return { handles: handlesResolved, repairedReferences, carriedHashes };
}

/** A face repair cannot change the saved pick, only add its proven identity. */
export function faceReferenceRepairCandidate(
  kernel: RemusKernel,
  shape: ExactShape,
  storedHash: number
): FaceTopologyReferenceV5 | null {
  return (
    faceSelectionRepairCandidates(kernel, shape, [storedHash])?.[0] ?? null
  );
}

/**
 * The v5 references a hash-only face selection can be upgraded to, all or
 * nothing: for every stored hash, the reference the body's lineage publishes
 * on the one face that hash names, re-verified against that face's measured
 * witness. A hash naming no face, or several, a face without a name, a name
 * published twice, or two hashes landing on one name refuse the whole set.
 * `currentHash` is the stored hash itself, so the selection never moves.
 */
export function faceSelectionRepairCandidates(
  kernel: RemusKernel,
  shape: ExactShape,
  storedHashes: readonly number[]
): FaceTopologyReferenceV5[] | null {
  const lineage = shape.lineage;
  const requested = [...new Set(storedHashes)];
  if (shape.solids.length !== 1 || !lineage || requested.length === 0)
    return null;
  // Before measuring anything: a hash no published name carries cannot be
  // upgraded, which is every rebuild of a pick on an unnamed face.
  const published = [...lineage.faceReferences.values()];
  const namedHashes = new Set(
    published.map((reference) => reference.currentHash)
  );
  if (requested.some((hash) => !namedHashes.has(hash))) return null;
  const byFingerprint = faceHandlesByFingerprint(kernel, shape.solids[0]!);
  const verified: FaceTopologyReferenceV5[] = [];
  for (const storedHash of requested) {
    const matches = byFingerprint.get(storedHash) ?? [];
    if (matches.length !== 1) return null;
    const reference = lineage.faceReferences.get(matches[0]!);
    if (!reference || reference.currentHash !== storedHash) return null;
    if (
      published.filter(
        (other) =>
          other.producingFeatureId === reference.producingFeatureId &&
          other.lineageName === reference.lineageName
      ).length !== 1
    )
      return null;
    const witness = faceWitnessOf(kernel, matches[0]!);
    if (
      topologyHashOfWitness('face', witness) !== storedHash ||
      !topologyWitnessesEqual('face', reference.witness, witness)
    )
      return null;
    verified.push(reference);
  }
  return new Set(
    verified.map(
      (reference) => `${reference.producingFeatureId}:${reference.lineageName}`
    )
  ).size === verified.length
    ? verified
    : null;
}
