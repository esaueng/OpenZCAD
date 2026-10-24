import { getParameterScope } from '@openzcad/document-core';
import {
  findFontFamily,
  resolveFontStyle,
  textFontProvider
} from '@openzcad/geometry';
import type {
  FeatureNode,
  ProjectDocument,
  SketchNode,
  SketchProfileReference
} from '@openzcad/shared';
import { resolveRegionProfiles } from './region-profile';

/** Only a missing font consumed by this feature can make its result transient. */
export function featureProfileAwaitsFonts(
  document: ProjectDocument,
  feature: FeatureNode,
  sketch: SketchNode
): boolean {
  const provider = textFontProvider();
  const missing = new Set<string>(
    sketch.objectIds.filter((objectId) => {
      const node = document.nodes[objectId];
      if (
        node?.kind !== 'sketch-object' ||
        node.data.objectKind !== 'text' ||
        node.data.construction === true
      )
        return false;
      const { fontFamily, fontStyle } = node.data;
      // An unknown family is a property of the document, not the moment.
      return (
        findFontFamily(fontFamily) !== undefined &&
        !provider?.(
          fontFamily,
          resolveFontStyle(fontFamily, fontStyle) ?? fontStyle
        )
      );
    })
  );
  return (
    missing.size > 0 &&
    featureProfileUsesObjects(document, feature, sketch, missing)
  );
}

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
      if (data.sketchId !== sketch.sketchId) return false;
      if (data.profile) {
        references = [data.profile];
        break;
      }
      return objectIds.has(sketch.objectIds[0] ?? '');
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
