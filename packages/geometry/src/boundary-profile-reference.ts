import {
  boundaryProvenanceEqual,
  isBoundaryProvenance,
  type BoundaryProvenance
} from '@openzcad/shared';

export interface BoundaryProfileCandidate {
  sourceBoundaryLoops?: BoundaryProvenance;
  area: number;
}

export interface BoundaryProfileReference {
  sourceBoundaryLoops: BoundaryProvenance;
  sourceArea: number;
  samplePoint: { x: number; y: number };
}

/**
 * Resolve only the explicit provenance tier. A caller must never send a
 * refused reference to legacy geometry or entity-set fallback afterwards.
 * Geometry chooses among exact topology matches, never between topologies.
 */
export function resolveBoundaryProfileReference<
  T extends BoundaryProfileCandidate
>(
  reference: BoundaryProfileReference,
  profiles: readonly T[],
  tolerance: number,
  containsPoint: (profile: T, point: { x: number; y: number }) => boolean
): T {
  if (!isBoundaryProvenance(reference.sourceBoundaryLoops))
    throw new Error(
      'Broken profile reference — saved boundary provenance is malformed.'
    );
  const matches = profiles.filter(
    (profile) =>
      profile.sourceBoundaryLoops !== undefined &&
      isBoundaryProvenance(profile.sourceBoundaryLoops) &&
      boundaryProvenanceEqual(
        reference.sourceBoundaryLoops,
        profile.sourceBoundaryLoops
      )
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0)
    throw new Error(
      'Broken profile reference — authored boundary topology no longer matches. Repair the profile explicitly.'
    );
  const { sourceArea, samplePoint } = reference;
  if (
    !Number.isFinite(sourceArea) ||
    sourceArea <= 0 ||
    !Number.isFinite(samplePoint.x) ||
    !Number.isFinite(samplePoint.y) ||
    !Number.isFinite(tolerance) ||
    tolerance < 0
  )
    throw new Error(
      'Broken profile reference — ambiguous boundary provenance has no finite area and sample witness.'
    );
  const areaTolerance = Math.max(sourceArea * 0.01, tolerance * tolerance * 16);
  const witnessed = matches.filter(
    (profile) =>
      Number.isFinite(profile.area) &&
      Math.abs(profile.area - sourceArea) <= areaTolerance &&
      containsPoint(profile, samplePoint)
  );
  if (witnessed.length !== 1)
    throw new Error(
      'Broken profile reference — authored boundary provenance does not resolve uniquely.'
    );
  return witnessed[0]!;
}
