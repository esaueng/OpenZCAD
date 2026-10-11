import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder,
  loftSections,
  resolveParamValue,
  shellBody
} from '@openzcad/document-core';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchSectionReference
} from '@openzcad/shared';

/**
 * The hollow duct from production QA CAD-002 (2026-10-11), rebuilt from its
 * recipe so no QA payload is committed: a ruled loft from a 60 × 40 section
 * at Z=0 to a 40 × 20 section at Z=40 centred at X=10, shelled 2 mm with both
 * caps open. Measured hollow: 12 630.86 mm³, 10 faces; the solid loft it
 * falls back to is 56 000 mm³ once the upper section is narrowed to 30.
 */
export const HOLLOW_DUCT_VOLUME = 12_630.86;
export const NARROWED_LOFT_VOLUME = 56_000;

export function ductRectangle(
  width: number,
  height: number,
  centerX: number
): SketchObjectData {
  return { objectKind: 'rectangle', width, height, centerX, centerY: 0 };
}

function addSection(
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

export interface LoftedHollowDuct {
  /** Rebuilt: `derived` is the adapter's result for this document. */
  document: ProjectDocument;
  loftBodyId: BodyId;
  shellBodyId: BodyId;
  /** Present when asked for: an unrelated box with its own history. */
  blockBodyId?: BodyId;
}

export async function loftedHollowDuct(
  adapter: ExactKernelAdapter,
  options: { name?: string; separateBlock?: boolean } = {}
): Promise<LoftedHollowDuct> {
  const lower = addSection(
    createProjectDocument(
      options.name ?? 'Lofted duct',
      toUserId('user_lofted_duct')
    ),
    'Lower duct section',
    0,
    ductRectangle(60, 40, 0)
  );
  const upper = addSection(
    lower.document,
    'Upper duct section',
    40,
    ductRectangle(40, 20, 10)
  );
  const lofted = loftSections(upper.document, {
    name: 'Offset rectangular transition',
    sections: [lower.section, upper.section],
    mode: 'ruled'
  });
  const solid = await adapter.syncDocument(lofted.document);
  // Pick the openings the way the Shell form does: the two cap faces, with a
  // topology reference only where the body's lineage offers one.
  const caps = solid.bodyRepresentations[lofted.bodyId]!.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      Math.abs(Math.abs(face.geometry.normal?.z ?? 0) - 1) < 1e-9
  );
  if (caps.length !== 2) throw new Error('Expected two loft caps.');
  const references = caps.every((face) => face.reference)
    ? caps.map((face) => face.reference!)
    : undefined;
  const shelled = shellBody(lofted.document, {
    name: 'Open-ended duct wall',
    targetBodyId: lofted.bodyId,
    openingFaceHashes: caps.map((face) => face.hash),
    ...(references ? { openingFaceReferences: references } : {}),
    thickness: 2
  });
  let document = shelled.document;
  let blockBodyId: BodyId | undefined;
  if (options.separateBlock) {
    document = addPrimitiveFeature(document, {
      name: 'Separate block',
      primitiveKind: 'box',
      dimensions: { width: 10, depth: 10, height: 10 }
    });
    blockBodyId = document.bodyOrder.at(-1)!;
  }
  return {
    document: { ...document, derived: await adapter.syncDocument(document) },
    loftBodyId: lofted.bodyId,
    shellBodyId: shelled.bodyId,
    ...(blockBodyId ? { blockBodyId } : {})
  };
}

export function upperDuctSection(document: ProjectDocument) {
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.name === 'Upper duct section'
  )!;
  if (feature.data.featureKind !== 'sketch') throw new Error('Not a sketch.');
  const sketch = findSketch(document, feature.data.sketchId)!;
  return { feature, sketch, sketchId: feature.data.sketchId };
}

/** The commands History's sketch Apply issues for a new upper section. */
export function upperDuctSectionEdit(
  document: ProjectDocument,
  width: number
): AnyCommand[] {
  const { sketch, sketchId } = upperDuctSection(document);
  return [
    commandFactories.updateSketch(
      {
        sketchId,
        planeRef: sketch.planeRef,
        object: ductRectangle(width, 20, 10)
      },
      'Edit Upper duct section'
    )
  ];
}
