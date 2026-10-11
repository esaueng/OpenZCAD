import {
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type FaceTopology,
  type FeatureNode,
  type FeatureWarning,
  type ProjectDocument,
  type SketchSectionReference
} from '@openzcad/shared';

/** Analytic curved surfaces: what an exact sweep along a curved path keeps. */
const EXACT_CURVED_SURFACES = new Set(['cylinder', 'cone', 'sphere', 'torus']);

/**
 * Sweeps that came back as facets, as advisories for Diagnostics.
 *
 * Measured on the pinned kernel: a sweep along a curved path, and every
 * helical sweep, is built from flat facets. The path is followed in straight
 * steps and a curved profile edge becomes straight chords, so a circle's end
 * caps are 18-gons, 2.02% short of its area. A circle r = 3 swept 270° about
 * r = 30 is 902 planes, 2.16% short of the exact torus segment, in Standard
 * and Smooth alike; a six-turn r = 2 spring is 2 838 planes and 656 bilinear
 * patches, 2.63% short. `validateSolid` passes, no warning was raised, and
 * STEP exported the facets as if they were the design. (A circle swept along a
 * straight line stays one exact cylinder with exact caps.)
 *
 * Computed here from the body's measured topology rather than in the kernel
 * build, so the size-budgeted kernel worker chunk does not grow. It is a
 * measurement, not a list of shapes: a curved path whose result holds no
 * analytic curved surface at all was stepped, so a kernel that builds exact
 * surfaces retires the advisory unchanged. Disclosure only — no geometry,
 * default or saved value changes.
 */
export function sweepFacetingAdvisories(
  document: ProjectDocument
): FeatureWarning[] {
  const advisories: FeatureWarning[] = [];
  let scope: Record<string, number> | null = null;
  const resolve = (value: Parameters<typeof resolveParamValue>[0]) => {
    scope ??= getParameterScope(document).scope;
    return resolveParamValue(value, scope, undefined, document.units);
  };
  for (const feature of listFeaturesInOrder(document)) {
    const data = feature.data;
    if (
      (data.featureKind !== 'sweep' && data.featureKind !== 'helical-sweep') ||
      isFeatureSuppressed(feature) ||
      !feature.bodyId
    )
      continue;
    const faces =
      document.derived.bodyRepresentations[feature.bodyId]?.topology?.faces;
    if (!faces?.length) continue;
    const pathCurved =
      data.featureKind === 'helical-sweep' ||
      data.path.entityIds.some(
        (id) => objectOf(document, id)?.data.objectKind === 'arc'
      );
    if (
      !pathCurved ||
      faces.some((face) =>
        EXACT_CURVED_SURFACES.has(face.geometry?.surfaceType ?? '')
      )
    )
      continue;
    let detail = '';
    try {
      const shortfall = capShortfall(document, data.profile, faces, resolve);
      if (shortfall !== null)
        detail = `, and the profile's curved edges become straight chords (its end caps measure ${(Math.abs(shortfall) * 100).toFixed(2)}% ${shortfall > 0 ? 'less' : 'more'} area than the profile)`;
    } catch {
      // An unresolvable profile only loses the detail, never the advisory.
    }
    let smooth = '';
    if (
      data.featureKind === 'sweep' &&
      data.mode === 'smooth' &&
      data.guide === undefined
    ) {
      try {
        const edges = pathEdgeCount(document, data.path.entityIds, resolve);
        if (edges > 1)
          smooth = ` Smooth only samples a path of one line or one arc of up to a quarter turn more finely; this path is built from ${edges} edges, so Smooth built the same body as Standard.`;
      } catch {
        // Unresolvable path values: the build itself reports those.
      }
    }
    advisories.push({
      featureId: feature.featureId,
      featureName: feature.name,
      kind: 'advisory',
      message: `Feature "${feature.name}": ${label(feature)} is a faceted approximation, not exact curved surfaces: its curved path is followed in straight steps${detail}. Its ${faces.length} faces are what its volume, mass and STEP export measure.${smooth}`
    });
  }
  return advisories;
}

function label(feature: FeatureNode): string {
  return feature.data.featureKind === 'helical-sweep'
    ? 'This helical sweep'
    : 'This sweep';
}

function objectOf(document: ProjectDocument, id: string) {
  const node = document.nodes[id];
  return node?.kind === 'sketch-object' ? node : undefined;
}

/**
 * How far the end caps fall short of the profile's exact area, when the
 * profile is one circle (its exact area is then πr² of its current radius, so
 * no stale stored area is ever compared). The cap is the exact planar face
 * nearest that area; a match more than 10% off is a wall facet, not a cap.
 */
function capShortfall(
  document: ProjectDocument,
  section: SketchSectionReference,
  faces: readonly FaceTopology[],
  resolve: (value: Parameters<typeof resolveParamValue>[0]) => number
): number | null {
  const ids = section.profile.sourceEntityIds ?? [];
  const circle = ids.length === 1 ? objectOf(document, ids[0]!) : undefined;
  if (circle?.data.objectKind !== 'circle') return null;
  const area = Math.PI * resolve(circle.data.radius) ** 2;
  let closest = Infinity;
  for (const { geometry } of faces) {
    if (
      geometry?.surfaceType !== 'plane' ||
      geometry.areaProvenance !== 'exact'
    )
      continue;
    const shortfall = (area - geometry.area) / area;
    if (Math.abs(shortfall) < Math.abs(closest)) closest = shortfall;
  }
  return Math.abs(closest) > 1e-6 && Math.abs(closest) < 0.1 ? closest : null;
}

/** The kernel edges a sweep path becomes: one per line, quarter-turn arcs. */
function pathEdgeCount(
  document: ProjectDocument,
  entityIds: readonly string[],
  resolve: (value: Parameters<typeof resolveParamValue>[0]) => number
): number {
  let edges = 0;
  for (const id of entityIds) {
    const data = objectOf(document, id)?.data;
    if (data?.objectKind !== 'arc') {
      edges += 1;
      continue;
    }
    const turn = 360;
    const sweep =
      (((resolve(data.endAngleDeg) - resolve(data.startAngleDeg)) % turn) +
        turn) %
      turn;
    edges += Math.max(1, Math.ceil(sweep / 90));
  }
  return edges;
}
