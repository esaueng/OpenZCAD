import { resolveParamValue } from '@openzcad/document-core';
import {
  computeSketchProfileAnalysis,
  profileBoundarySignatures,
  profileContainsPoint,
  type SketchProfileAnalysisOptions,
  type SketchProfileDiagnostic,
  type SketchRegion
} from '@openzcad/geometry';
import type {
  FeatureNode,
  ProjectDocument,
  SketchEntityProfileReference,
  SketchNode,
  SketchObjectNode
} from '@openzcad/shared';

/**
 * Every profile bounded solely by the referenced entities.
 *
 * This is the entity-identity tier, and it deliberately looks at nothing
 * geometric. A text object's regions change count, area, fingerprint and
 * sample point together whenever the string changes, so any geometry-derived
 * match would fail exactly when the user edits the text — the edit this
 * feature exists to support. What does not change is the sketch object's
 * `EntityId`, so that is the only thing matched on.
 *
 * Subset rather than equality: a region bounded by a subset of the referenced
 * entities still belongs to them. It stays fail-closed — an entity set that
 * currently bounds nothing throws rather than silently extruding nothing.
 */
function resolveEntityProfiles(
  reference: SketchEntityProfileReference,
  profiles: SketchRegion[],
  diagnostics: readonly SketchProfileDiagnostic[]
): SketchRegion[] {
  const referenced = new Set(reference.sourceEntityIds);
  if (referenced.size === 0) {
    throw new Error(
      'Broken profile reference — the extrude references every profile of no sketch entity.'
    );
  }
  const matches = profiles.filter(
    (candidate) =>
      candidate.sourceEntityIds.length > 0 &&
      candidate.sourceEntityIds.every((entityId) => referenced.has(entityId))
  );
  if (matches.length === 0) {
    // An object that carries its own outlines — text — reports why it could
    // not produce them as an analysis diagnostic. Without this the failure
    // reads as "the entities bound nothing", which is true but describes the
    // symptom rather than the cause (usually: the font is not loaded yet).
    const cause = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === 'unresolved-outline' &&
        diagnostic.sourceEntityIds.some((entityId) => referenced.has(entityId))
    );
    throw new Error(
      cause
        ? `Broken profile reference — ${cause.message}`
        : 'Broken profile reference — the sketch entities this extrude covers no longer bound any closed region.'
    );
  }
  return matches;
}

/**
 * Resolve the persisted region profiles of an extrude against the sketch's
 * current regions. Shared by both exact kernels so a document means the same
 * region — or fails with the same error — wherever it builds. Resolution is
 * fail-closed (ADR-010): the stored fingerprint must match a current region,
 * with a single tolerant fallback — the stored sample point still falls
 * inside a region whose area is within 1% — so nudging a curve keeps the
 * feature alive while topology changes refuse to guess.
 *
 * One reference kind opts out of geometric identity entirely: an
 * `{ all: true, sourceEntityIds }` reference resolves by entity id alone (see
 * `resolveEntityProfiles`). It is additive — every stored region reference
 * takes exactly the path it took before.
 */
export function resolveRegionProfiles(
  document: ProjectDocument,
  sketch: SketchNode,
  data: Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
  scope: Record<string, number>,
  options?: SketchProfileAnalysisOptions
): SketchRegion[] {
  const references =
    data.profiles && data.profiles.length > 0
      ? data.profiles
      : data.profile
        ? [data.profile]
        : [];
  if (references.length === 0) {
    throw new Error('Extrude has no selected sketch profiles.');
  }
  const objects = sketch.objectIds
    .map((objectId) => document.nodes[objectId])
    .filter((node): node is SketchObjectNode => node?.kind === 'sketch-object')
    .map((node) => ({ id: node.id, data: node.data }));
  const analysis = computeSketchProfileAnalysis(
    objects,
    (value) => resolveParamValue(value, scope, 'sketch dimension'),
    undefined,
    options
  );
  const resolved = references.flatMap((reference) => {
    if (reference.all === true) {
      return resolveEntityProfiles(
        reference,
        analysis.profiles,
        analysis.diagnostics
      );
    }
    const areaTolerance = Math.max(
      Math.abs(reference.sourceArea) * 0.01,
      analysis.tolerance * analysis.tolerance * 16
    );
    const sourceIds = reference.sourceEntityIds
      ? [...reference.sourceEntityIds].sort().join('|')
      : undefined;
    const identityMatches = analysis.profiles.filter((candidate) => {
      if (reference.profileId && candidate.profileId === reference.profileId) {
        return true;
      }
      return (
        candidate.regionFingerprint === reference.regionFingerprint &&
        Math.abs(candidate.area - reference.sourceArea) <= areaTolerance &&
        profileContainsPoint(candidate, reference.samplePoint) &&
        (!sourceIds ||
          [...candidate.sourceEntityIds].sort().join('|') === sourceIds)
      );
    });
    if (identityMatches.length === 1) {
      return identityMatches[0]!;
    }

    const sourceMatches = sourceIds
      ? analysis.profiles.filter(
          (candidate) =>
            [...candidate.sourceEntityIds].sort().join('|') === sourceIds
        )
      : [];
    if (sourceMatches.length === 1) {
      return sourceMatches[0]!;
    }

    // The tolerant tier deliberately ignores entity identity, so a legacy
    // reference survives a redrawn curve. That is only safe over arrangement
    // cells. A profile supplied by an object that carries its own outlines
    // (`candidate.outline`) is matched by entity id and nothing else — letting
    // this tier see one means deleting the circle a reference points at can
    // silently re-point it at whichever glyph happens to sit over the stored
    // sample point with a similar area.
    const fallbackMatches = analysis.profiles.filter(
      (candidate) =>
        !candidate.outline &&
        Math.abs(candidate.area - reference.sourceArea) <= areaTolerance &&
        profileContainsPoint(candidate, reference.samplePoint)
    );
    if (fallbackMatches.length === 1) {
      return fallbackMatches[0]!;
    }
    throw new Error(
      'Broken profile reference — the bounded sketch region used by this extrude no longer resolves uniquely.'
    );
  });
  const unique = new Map(
    resolved.map((profile) => [profile.profileId, profile])
  );
  if (unique.size !== resolved.length) {
    throw new Error(
      'Broken profile reference — the extrude resolves more than one reference to the same sketch profile.'
    );
  }
  return [...unique.values()];
}

export function resolveRegionProfile(
  document: ProjectDocument,
  sketch: SketchNode,
  data: Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
  scope: Record<string, number>,
  options?: SketchProfileAnalysisOptions
): SketchRegion {
  const profiles = resolveRegionProfiles(
    document,
    sketch,
    data,
    scope,
    options
  );
  if (profiles.length !== 1) {
    throw new Error('Expected one sketch profile.');
  }
  return profiles[0]!;
}

/**
 * Connected profile components; only cells sharing a boundary need fusing.
 *
 * Bucketed by boundary signature rather than compared pairwise. The relation
 * is "shares at least one canonical boundary piece", so profiles that land in
 * the same signature bucket are exactly the ones `profilesShareBoundary` would
 * have paired — the components are identical, computed in one pass over the
 * curves instead of one signature-set rebuild per pair. That matters because
 * a text object contributes one profile per glyph region and none of them can
 * ever share a boundary: the pairwise sweep was quadratic work with a
 * guaranteed-empty answer, growing with the length of the string.
 *
 * Groups come back in first-appearance order, and members within a group in
 * input order.
 */
export function connectedRegionGroups(
  profiles: SketchRegion[]
): SketchRegion[][] {
  const parent = profiles.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    for (let walk = index; parent[walk] !== root;) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) {
      parent[Math.max(a, b)] = Math.min(a, b);
    }
  };
  const firstSeen = new Map<string, number>();
  profiles.forEach((profile, index) => {
    for (const signature of profileBoundarySignatures(profile)) {
      const owner = firstSeen.get(signature);
      if (owner === undefined) {
        firstSeen.set(signature, index);
      } else {
        union(owner, index);
      }
    }
  });
  const groups = new Map<number, SketchRegion[]>();
  profiles.forEach((profile, index) => {
    const root = find(index);
    const existing = groups.get(root);
    if (existing) {
      existing.push(profile);
    } else {
      groups.set(root, [profile]);
    }
  });
  return [...groups.values()];
}
