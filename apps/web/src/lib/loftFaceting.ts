import {
  listFeaturesInOrder,
  resolvedSketchDocument
} from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type FeatureWarning,
  type GeometryBodyRepresentation,
  type ProjectDocument,
  type SketchSectionReference
} from '@openzcad/shared';

/** Analytic curved surfaces: what an exact coaxial circle loft keeps. */
const EXACT_CURVED_SURFACES = new Set(['cylinder', 'cone', 'sphere', 'torus']);
/** Kernel edge curve types that are a section's curved edge kept exact. */
const EXACT_SECTION_CURVES = new Set(['CIRCLE', 'ELLIPSE']);
/** Sketch entities with an exact curved boundary edge. */
const CURVED_ENTITIES = new Set(['circle', 'arc', 'ellipse']);

/**
 * Lofts whose curved section edges came back as straight chords, as
 * advisories for Diagnostics.
 *
 * Measured on the pinned kernel (Remus 2026.1.135): two parallel circles loft
 * exactly in Ruled and Smooth alike, as one cone when coaxial and as one
 * rational ruled B-spline band when laterally offset (#1253), and a Ruled
 * stack of circles keeps every circle. But Smooth through three or more
 * sections — coaxial circles included — and every loft that mixes a circle
 * with a straight-edged section, or lofts an ellipse, rebuilds each curved
 * section as a 32-sided polygon: its rims become straight chords and its wall
 * flat facets or B-spline strips. `validateSolid` passes, no warning was
 * raised, and volume, mass and STEP export measured the chords as if they
 * were the design.
 *
 * Computed from the body's measured topology, like the sweep disclosure, so
 * the kernel worker chunk does not grow. It is a measurement, not a list of
 * shapes: a loft with curved sections whose body keeps no exact circle or
 * ellipse edge, no closed curved edge and no analytic curved face was
 * chorded, so a kernel that keeps those sections exact retires the advisory
 * unchanged. A body whose edge curves the kernel did not report is left
 * alone rather than guessed at. Disclosure only — no geometry, default or
 * saved value changes.
 */
export function loftFacetingAdvisories(
  document: ProjectDocument,
  bodies: Readonly<Record<string, GeometryBodyRepresentation>> = document
    .derived.bodyRepresentations
): FeatureWarning[] {
  const advisories: FeatureWarning[] = [];
  let nodes: ProjectDocument['nodes'] | null = null;
  for (const feature of listFeaturesInOrder(document)) {
    const data = feature.data;
    if (
      data.featureKind !== 'loft' ||
      isFeatureSuppressed(feature) ||
      !feature.bodyId
    )
      continue;
    const topology = bodies[feature.bodyId]?.topology;
    if (!topology?.faces.length || !topology.edges.length) continue;
    nodes ??= resolvedSketchDocument(document).nodes;
    const kinds = data.sections.map((section) => sectionKinds(nodes!, section));
    if (
      !kinds.some((section) =>
        section.some((kind) => CURVED_ENTITIES.has(kind))
      )
    )
      continue;
    const edges = topology.edges.filter((edge) => edge.displayRole !== 'seam');
    if (edges.some((edge) => edge.curve === undefined)) continue;
    const keptCurved =
      topology.faces.some((face) =>
        EXACT_CURVED_SURFACES.has(face.geometry?.surfaceType ?? '')
      ) ||
      edges.some(
        (edge) =>
          EXACT_SECTION_CURVES.has(edge.curve!.type) ||
          (edge.curve!.type !== 'LINE' &&
            edge.vertexIds !== undefined &&
            edge.vertexIds[0] === edge.vertexIds[1])
      );
    if (keptCurved) continue;
    // Measured with the same stacks: Ruled keeps a stack of single circles
    // exact, so Smooth is the only reason such a stack was chorded.
    const ruledKeepsIt =
      data.mode === 'smooth' &&
      kinds.every((section) => section.length === 1 && section[0] === 'circle');
    advisories.push({
      featureId: feature.featureId,
      featureName: feature.name,
      kind: 'advisory',
      message: `Feature "${feature.name}": This loft is a faceted approximation, not exact curved surfaces: its sections' curved edges become straight chords. Its ${topology.faces.length} faces are what its volume, mass and STEP export measure.${
        ruledKeepsIt
          ? ` Smooth through ${data.sections.length} sections rebuilds circular sections from chords; Ruled keeps these circles exact.`
          : ''
      }`
    });
  }
  return advisories;
}

/** The sketch entity kinds that bound one section's profile. */
function sectionKinds(
  nodes: ProjectDocument['nodes'],
  section: SketchSectionReference
): string[] {
  return (section.profile.sourceEntityIds ?? []).flatMap((id) => {
    const node = nodes[id];
    return node?.kind === 'sketch-object' ? [node.data.objectKind] : [];
  });
}
