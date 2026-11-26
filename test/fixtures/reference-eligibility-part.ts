import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type ProjectDocument,
  type SketchId,
  type SketchPlaneRef
} from '@openzcad/shared';

/**
 * S06 / I01 earlier-sketch reference eligibility: an invented part whose
 * earlier sketch sits under a later feature, seen from the sketch's normal.
 *
 *   1. Base profile + Base: a 40 × 20 slab centred on the origin, z 0..10.
 *   2. Boss profile (the earlier sketch, on the slab's top, z = 10): one
 *      circle r 4 at (-10, 0). Boss extrudes it 6, z 10..16.
 *   3. Cap profile + Cap (the later feature): a 20 × 15 block, x 10..30,
 *      y 0..15, z 16..20.
 *
 * From above, Cap's top face covers the slab's x = 20 top edge for y 0..10
 * and leaves y -10..0 of it exposed. The slab's edge comes before Boss
 * profile and is a legal linked reference there; Cap's face and edges come
 * after it and are not.
 */
export const BOSS_PLANE: SketchPlaneRef = {
  type: 'canonical',
  plane: 'XY',
  offset: 10
};

/** Sketch-plane points (Boss profile's u = X, v = Y) the specs aim at. */
export const AIM = {
  /** On Cap's top face, straight above the slab's covered x = 20 edge. */
  downstreamFace: { x: 20, y: 5 },
  /** The exposed half of the slab's x = 20 top edge. */
  upstreamEdge: { x: 20, y: -5 }
} as const;

export const VOLUMES = {
  base: 40 * 20 * 10,
  boss: Math.PI * 4 * 4 * 6,
  cap: 20 * 15 * 4
} as const;

export interface ReferenceEligibilityPart {
  document: ProjectDocument;
  bossSketchId: SketchId;
  baseBodyId: BodyId;
  bossBodyId: BodyId;
  capBodyId: BodyId;
}

export function referenceEligibilityPart(
  name = 'Reference eligibility'
): ReferenceEligibilityPart {
  const rect = (
    document: ProjectDocument,
    sketch: string,
    offset: number,
    width: number,
    height: number,
    centerX: number,
    centerY: number
  ) =>
    addSketchFeature(document, {
      name: sketch,
      planeRef: { type: 'canonical', plane: 'XY', offset },
      objects: [{ objectKind: 'rectangle', width, height, centerX, centerY }]
    });
  const blank = createProjectDocument(name, toUserId('user_s06_eligibility'));
  const baseProfile = rect(blank, 'Base profile', 0, 40, 20, 0, 0);
  const base = extrudeSketch(baseProfile.document, {
    name: 'Base',
    sketchId: baseProfile.sketchId,
    distance: 10
  });
  const bossProfile = addSketchFeature(base.document, {
    name: 'Boss profile',
    planeRef: BOSS_PLANE,
    objects: [{ objectKind: 'circle', centerX: -10, centerY: 0, radius: 4 }]
  });
  const boss = extrudeSketch(bossProfile.document, {
    name: 'Boss',
    sketchId: bossProfile.sketchId,
    distance: 6
  });
  const capProfile = rect(boss.document, 'Cap profile', 16, 20, 15, 20, 7.5);
  const cap = extrudeSketch(capProfile.document, {
    name: 'Cap',
    sketchId: capProfile.sketchId,
    distance: 4
  });
  return {
    document: cap.document,
    bossSketchId: bossProfile.sketchId,
    baseBodyId: base.bodyId,
    bossBodyId: boss.bodyId,
    capBodyId: cap.bodyId
  };
}
