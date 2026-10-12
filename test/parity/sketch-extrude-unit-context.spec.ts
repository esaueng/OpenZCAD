import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  getLatestBodyId,
  resolveParamValue
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type SketchObjectData,
  type UnitSystem
} from '@openzcad/shared';
import { OcctStepKernelAdapter } from './occt-reference/occt-step';

describe('sketch/extrude unit context across exact kernels', () => {
  let remus: ExactKernelAdapter;
  let occt: OcctStepKernelAdapter;
  beforeAll(async () => {
    remus = await createExactKernelAdapter();
    occt = await OcctStepKernelAdapter.create();
  });
  afterAll(() => {
    remus.dispose();
    occt.dispose();
  });

  it.each([
    ['mm', 1],
    ['cm', 0.1],
    ['inch', 1 / 25.4]
  ] as const)(
    'builds the same physical prism from mixed-unit %s sketch and extrude expressions',
    async (units: UnitSystem, scale) => {
      for (const selectedRegion of [false, true]) {
        const data: SketchObjectData = {
          objectKind: 'rectangle',
          width: '5 mm + 2 cm',
          height: '1 cm',
          centerX: 0,
          centerY: 0
        };
        const sketched = addSketchFeature(
          createProjectDocument(
            'Unit context parity',
            toUserId('user_unit_parity'),
            units
          ),
          { name: 'Profile', plane: 'XY', offset: '2 mm', object: data }
        );
        const objectId = findSketch(sketched.document, sketched.sketchId)!
          .objectIds[0]!;
        const profiles = selectedRegion
          ? computeSketchRegions([{ id: objectId, data }], (value) =>
              resolveParamValue(value, {}, 'sketch dimension', units)
            ).map((profile) => ({
              profileId: profile.profileId,
              regionFingerprint: profile.regionFingerprint,
              sourceArea: profile.area,
              samplePoint: profile.samplePoint,
              sourceEntityIds: profile.sourceEntityIds
            }))
          : undefined;
        const document = extrudeSketch(sketched.document, {
          name: 'Extrude',
          sketchId: sketched.sketchId,
          distance: '12 mm',
          ...(profiles ? { profiles } : {})
        }).document;
        const bodyId = getLatestBodyId(document)!;
        for (const adapter of [remus, occt]) {
          const derived = await adapter.syncDocument(document);
          const body = derived.bodyRepresentations[bodyId]!;
          expect(derived.warnings).toEqual([]);
          expect(body.volume).toBeCloseTo(3_000 * scale ** 3, 8);
          expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(25 * scale, 8);
          expect(body.bbox.max.y - body.bbox.min.y).toBeCloseTo(10 * scale, 8);
          expect(body.bbox.min.z).toBeCloseTo(2 * scale, 8);
          expect(body.bbox.max.z).toBeCloseTo(14 * scale, 8);
        }
      }
    }
  );
});
