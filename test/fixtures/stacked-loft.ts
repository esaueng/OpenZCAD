import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  loftSections,
  resolveParamValue
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  toUserId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchSectionReference
} from '@openzcad/shared';

/**
 * OpenZCAD #1253's synthetic sections: a circle r = 25 at the origin and a
 * circle r = 10 sixty above it, its centre shifted 12 along X. Sections are
 * stacked HEIGHT apart on parallel XY sketches.
 */
export const LOWER_RADIUS = 25;
export const UPPER_RADIUS = 10;
export const HEIGHT = 60;
export const OFFSET = 12;

export const circle = (radius: number, centerX = 0): SketchObjectData => ({
  objectKind: 'circle',
  radius,
  centerX,
  centerY: 0
});

function section(
  document: ProjectDocument,
  name: string,
  offset: number,
  object: SketchObjectData
): { document: ProjectDocument; section: SketchSectionReference } {
  const result = addSketchFeature(document, {
    name,
    plane: 'XY',
    offset,
    object
  });
  const sketch = findSketch(result.document, result.sketchId)!;
  const objects = sketch.objectIds.map((objectId) => {
    const node = result.document.nodes[objectId];
    if (node?.kind !== 'sketch-object') throw new Error('Expected an object.');
    return { id: node.id, data: node.data };
  });
  const [profile] = computeSketchProfileAnalysis(objects, (value) =>
    resolveParamValue(value, {}, 'profile dimension')
  ).profiles;
  if (!profile) throw new Error('Expected one closed profile.');
  return {
    document: result.document,
    section: {
      sketchId: result.sketchId,
      profile: {
        profileId: profile.profileId,
        regionFingerprint: profile.regionFingerprint,
        samplePoint: profile.samplePoint,
        sourceArea: profile.area,
        sourceEntityIds: profile.sourceEntityIds
      }
    }
  };
}

/** One section per object, HEIGHT apart, lofted in order as "Loft". */
export function stackedLoft(
  mode: 'ruled' | 'smooth',
  objects: readonly SketchObjectData[],
  projectName = 'Offset circle loft'
) {
  let document = createProjectDocument(
    projectName,
    toUserId('user_offset_loft')
  );
  const sections: SketchSectionReference[] = [];
  objects.forEach((object, index) => {
    const next = section(
      document,
      `Section ${index + 1}`,
      index * HEIGHT,
      object
    );
    document = next.document;
    sections.push(next.section);
  });
  return loftSections(document, { name: 'Loft', sections, mode });
}
