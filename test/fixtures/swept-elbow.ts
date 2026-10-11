import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  resolveParamValue,
  sweepProfile
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  toUserId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchSectionReference
} from '@openzcad/shared';

/**
 * The swept elbow from production QA CAD-003 (2026-10-11), rebuilt from its
 * recipe so no QA payload is committed: a circle r = 3 on the top plane swept
 * along an r = 30 arc on the front plane from 180° to 450° — 270°, although
 * the QA feature was named "Quarter bend". The pinned kernel builds it from
 * 902 planes, 3 910.7055 mm³, against 3 997.19 mm³ for the exact torus segment.
 */
export const ELBOW_FACES = 902;
export const ELBOW_VOLUME = 3910.7055;

export const roundProfile = (radius: number): SketchObjectData => ({
  objectKind: 'circle',
  radius,
  centerX: 0,
  centerY: 0
});

export const elbowPath: SketchObjectData = {
  objectKind: 'arc',
  centerX: 30,
  centerY: 0,
  radius: 30,
  startAngleDeg: 180,
  endAngleDeg: 450
};

/** A top-plane sketch holding one closed object, and its section reference. */
export function profileSketch(
  document: ProjectDocument,
  object: SketchObjectData
): { document: ProjectDocument; section: SketchSectionReference } {
  const result = addSketchFeature(document, {
    name: 'Profile',
    plane: 'XY',
    offset: 0,
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

/** `profile` swept along `path` (a front-plane sketch) as feature "Bend". */
export function sweptAlong(
  profile: SketchObjectData,
  path: SketchObjectData,
  mode: 'standard' | 'smooth',
  name = 'Swept elbow'
) {
  const start = profileSketch(
    createProjectDocument(name, toUserId('user_swept_elbow')),
    profile
  );
  const pathSketch = addSketchFeature(start.document, {
    name: 'Path',
    plane: 'XZ',
    offset: 0,
    object: path
  });
  return sweepProfile(pathSketch.document, {
    name: 'Bend',
    profile: start.section,
    path: {
      sketchId: pathSketch.sketchId,
      entityIds: findSketch(pathSketch.document, pathSketch.sketchId)!.objectIds
    },
    mode
  });
}
