import { resolveParamValue } from '@openzcad/document-core';
import {
  computeSketchProfileAnalysis,
  profileContainsPoint,
  profilesShareBoundary,
  type SketchRegion
} from '@openzcad/geometry';
import type {
  FeatureNode,
  ProjectDocument,
  SketchNode,
  SketchObjectNode
} from '@openzcad/shared';

/**
 * Resolve the persisted region profile of an extrude against the sketch's
 * current regions. Shared by both exact kernels so a document means the same
 * region — or fails with the same error — wherever it builds. Resolution is
 * fail-closed (ADR-010): the stored fingerprint must match a current region,
 * with a single tolerant fallback — the stored sample point still falls
 * inside a region whose area is within 1% — so nudging a curve keeps the
 * feature alive while topology changes refuse to guess.
 */
export function resolveRegionProfiles(
  document: ProjectDocument,
  sketch: SketchNode,
  data: Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
  scope: Record<string, number>
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
  const analysis = computeSketchProfileAnalysis(objects, (value) =>
    resolveParamValue(value, scope, 'sketch dimension')
  );
  const resolved = references.map((reference) => {
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

    const fallbackMatches = analysis.profiles.filter(
      (candidate) =>
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
  scope: Record<string, number>
): SketchRegion {
  const profiles = resolveRegionProfiles(document, sketch, data, scope);
  if (profiles.length !== 1) {
    throw new Error('Expected one sketch profile.');
  }
  return profiles[0]!;
}

/** Connected profile components; only cells sharing a boundary need fusing. */
export function connectedRegionGroups(
  profiles: SketchRegion[]
): SketchRegion[][] {
  const remaining = new Set(profiles);
  const groups: SketchRegion[][] = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as SketchRegion;
    remaining.delete(seed);
    const group = [seed];
    for (let index = 0; index < group.length; index += 1) {
      const current = group[index]!;
      for (const candidate of [...remaining]) {
        if (profilesShareBoundary(current, candidate)) {
          remaining.delete(candidate);
          group.push(candidate);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}
