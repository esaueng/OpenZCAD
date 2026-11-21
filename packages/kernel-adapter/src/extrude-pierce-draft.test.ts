import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { buildDocumentHistory } from './exact-build-loop';
import {
  PIERCE_TRAVEL_METADATA_KEY,
  buildSweep
} from './exact-profile-builders';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
import { RemusKernel } from './remus-runtime';

/**
 * F01 (v126) review: a coplanar-retry twin of a ONE-sided drafted extrude
 * carries pierce travel as a back distance. It must keep the one-sided
 * taper carried on across the start plane, exactly as before per-side
 * draft, and never be built as a two-sided extrusion with a straight back.
 * A circle r 3 drafted 5° over 10, with 1 of travel behind it: one cone
 * frustum from radius 3 + tan 5° at z = −1 to 3 − 10 tan 5° at z = 10.
 */
describe('pierced twin of a drafted extrude', () => {
  it('keeps the one-sided taper across the start plane', () => {
    const kernel = new RemusKernel();
    const sketched = addSketchFeature(
      createProjectDocument('Pierce draft', toUserId('user_pierce_draft')),
      {
        name: 'Disc',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'circle', centerX: 0, centerY: 0, radius: 3 }]
      }
    );
    const extruded = extrudeSketch(sketched.document, {
      name: 'Boss',
      sketchId: sketched.sketchId,
      distance: 10,
      draftAngleDeg: 5
    });
    const result = buildDocumentHistory(kernel, extruded.document);
    expect(result.warnings).toEqual([]);
    const feature = listFeaturesInOrder(extruded.document).at(-1)!;
    const data = feature.data;
    if (data.featureKind !== 'extrude') throw new Error('extrude');
    const t = Math.tan((5 * Math.PI) / 180);
    const frustum = (h: number, r1: number, r2: number) =>
      ((Math.PI * h) / 3) * (r1 * r1 + r1 * r2 + r2 * r2);
    const build = (marked: boolean) =>
      buildSweep(
        kernel,
        extruded.document,
        {
          ...feature,
          data: { ...data, backDistance: 1 },
          ...(marked
            ? {
                metadata: {
                  ...feature.metadata,
                  [PIERCE_TRAVEL_METADATA_KEY]: true
                }
              }
            : {})
        },
        {},
        result.sketchBases,
        () => {}
      ).solids;
    const volume = (solids: number[]) =>
      solids.reduce(
        (sum, solid) => sum + kernel.volume(solid, MEASUREMENT_DEFLECTION),
        0
      );
    // The twin: one frustum across the start plane.
    expect(volume(build(true))).toBeCloseTo(frustum(11, 3 + t, 3 - 10 * t), 4);
    // A stored two-sided extrude with only a front draft: a straight back.
    expect(volume(build(false))).toBeCloseTo(
      frustum(10, 3, 3 - 10 * t) + Math.PI * 9,
      4
    );
  });
});
