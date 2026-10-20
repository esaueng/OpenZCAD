import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  loftSections,
  resolveParamValue,
  sweepProfile
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  toUserId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchSectionReference
} from '@openzcad/shared';

/**
 * Research-audit Stage 4 independent analytic oracles (ZC-069, ZC-074).
 * Each expected value is derived here from first principles, never recorded
 * from a kernel run: a swept circle is a cylinder (pi r^2 L), and a ruled
 * loft between two parallel rectangles is a prismatoid, whose section area is
 * quadratic in height, so Simpson's rule is exact for it.
 */
const user = toUserId('user_stage4_oracles');

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

describe('Stage 4 analytic oracles', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it('sweeps a radius-2 circle 20 along a straight path to 80 pi (ZC-074)', async () => {
    let document = createProjectDocument('Swept circle', user);
    const profile = section(document, 'Profile', 0, {
      objectKind: 'circle',
      radius: 2,
      centerX: 0,
      centerY: 0
    });
    document = profile.document;
    const path = addSketchFeature(document, {
      name: 'Path',
      plane: 'XZ',
      offset: 0,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    });
    const swept = sweepProfile(path.document, {
      name: 'Rod',
      profile: profile.section,
      path: {
        sketchId: path.sketchId,
        entityIds: findSketch(path.document, path.sketchId)!.objectIds
      },
      mode: 'standard'
    });
    const derived = await adapter.syncDocument(swept.document);
    expect(derived.warnings).toEqual([]);
    const rod = derived.bodyRepresentations[swept.bodyId]!;
    expect(rod.volume).toBeCloseTo(Math.PI * 2 * 2 * 20, 6);
    expect(Math.PI * 2 * 2 * 20).toBeCloseTo(80 * Math.PI, 12);
  });

  it('lofts 20 x 12 to 10 x 8 over 20, ruled, to 3066.67 (ZC-069)', async () => {
    let document = createProjectDocument('Ruled loft', user);
    const lower = section(document, 'Lower', 0, {
      objectKind: 'rectangle',
      width: 20,
      height: 12,
      centerX: 0,
      centerY: 0
    });
    document = lower.document;
    const upper = section(document, 'Upper', 20, {
      objectKind: 'rectangle',
      width: 10,
      height: 8,
      centerX: 0,
      centerY: 0
    });
    const lofted = loftSections(upper.document, {
      name: 'Prismatoid',
      sections: [lower.section, upper.section],
      mode: 'ruled'
    });
    const derived = await adapter.syncDocument(lofted.document);
    expect(derived.warnings).toEqual([]);
    // Width and height each run linearly from the lower to the upper section.
    const area = (z: number) =>
      (20 + ((10 - 20) * z) / 20) * (12 + ((8 - 12) * z) / 20);
    const prismatoid = (20 / 6) * (area(0) + 4 * area(10) + area(20));
    expect(prismatoid).toBeCloseTo(3066.6667, 4);
    expect(derived.bodyRepresentations[lofted.bodyId]!.volume).toBeCloseTo(
      prismatoid,
      6
    );
  });
});
