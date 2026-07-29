import { resolveParamValue } from '@openzcad/document-core';
import {
  computeSketchRegions,
  regionAtPoint,
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
export function resolveRegionProfile(
  document: ProjectDocument,
  sketch: SketchNode,
  data: Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
  scope: Record<string, number>
): SketchRegion {
  const profile = data.profile!;
  const objects = sketch.objectIds
    .map((objectId) => document.nodes[objectId])
    .filter((node): node is SketchObjectNode => node?.kind === 'sketch-object')
    .map((node) => ({ id: node.id, data: node.data }));
  const regions = computeSketchRegions(objects, (value) =>
    resolveParamValue(value, scope, 'sketch dimension')
  );
  let region =
    regions.find(
      (candidate) => candidate.regionFingerprint === profile.regionFingerprint
    ) ?? null;
  if (!region) {
    const candidate = regionAtPoint(regions, profile.samplePoint);
    if (
      candidate &&
      Math.abs(candidate.area - profile.sourceArea) <=
        Math.max(profile.sourceArea * 0.01, 1e-9)
    ) {
      region = candidate;
    }
  }
  if (!region) {
    throw new Error(
      'The sketch region this extrude was built from no longer exists.'
    );
  }
  return region;
}
