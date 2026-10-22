import {
  getParameterScope,
  listFeaturesInOrder,
  resolvedSketchDocument,
  resolveParamValue
} from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type GeometryBodyRepresentation,
  type FeatureNode,
  type FeatureWarning,
  type ProjectDocument
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
  document: ProjectDocument,
  bodies: Readonly<Record<string, GeometryBodyRepresentation>> = document
    .derived.bodyRepresentations
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
    const faces = bodies[feature.bodyId]?.topology?.faces;
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
    const ids = data.profile.profile.sourceEntityIds ?? [];
    // Topology does not identify the caps. Disclose the chord approximation
    // without guessing which planar face supplies an end-cap area.
    const detail = ids.some((id) => {
      const kind = objectOf(document, id)?.data.objectKind;
      return kind === 'circle' || kind === 'arc';
    })
      ? ", and the profile's curved edges become straight chords"
      : '';
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
  const node = resolvedSketchDocument(document).nodes[id];
  return node?.kind === 'sketch-object' ? node : undefined;
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
