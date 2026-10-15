import { getParameterScope } from '@openzcad/document-core';
import type {
  FeatureNode,
  ProjectDocument,
  SketchNode,
  SketchProfileReference
} from '@openzcad/shared';
import { resolveRegionProfiles } from './region-profile';

/** The authored profile objects a solid builder actually consumes. */
export function featureProfileUsesObjects(
  document: ProjectDocument,
  feature: FeatureNode,
  sketch: SketchNode,
  objectIds: ReadonlySet<string>
): boolean {
  const { data } = feature;
  let references: SketchProfileReference[];
  switch (data.featureKind) {
    case 'extrude':
      if (data.sketchId !== sketch.sketchId) return false;
      references = data.profiles?.length
        ? data.profiles
        : data.profile
          ? [data.profile]
          : [];
      if (references.length) break;
      return objectIds.has(sketch.objectIds[0] ?? '');
    case 'revolve':
      return (
        data.sketchId === sketch.sketchId &&
        objectIds.has(sketch.objectIds[0] ?? '')
      );
    case 'loft':
      references = data.sections
        .filter((section) => section.sketchId === sketch.sketchId)
        .map((section) => section.profile);
      break;
    case 'sweep':
    case 'helical-sweep':
      if (data.profile.sketchId !== sketch.sketchId) return false;
      references = [data.profile.profile];
      break;
    default:
      // Sketch features resolve only a plane, and path edges do not read fonts.
      return false;
  }
  if (
    references.some((reference) =>
      reference.sourceEntityIds?.some((id) => objectIds.has(id))
    )
  )
    return true;
  const legacy = references.filter(
    (reference) => reference.all !== true && !reference.sourceEntityIds?.length
  );
  if (!legacy.length) return false;
  try {
    return resolveRegionProfiles(
      document,
      sketch,
      { profiles: legacy },
      getParameterScope(document).scope
    ).some((profile) =>
      profile.sourceEntityIds.some((id) => objectIds.has(id))
    );
  } catch {
    // A legacy reference has no authored identity to rule a missing outline
    // out. Keep it retryable until its selected profile can be resolved.
    return true;
  }
}
