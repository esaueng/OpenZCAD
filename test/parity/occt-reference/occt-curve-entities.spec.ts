import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch
} from '@openzcad/document-core';
import { computeSketchRegions, type SketchRegion } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type SketchObjectData } from '@openzcad/shared';
import { OcctStepKernelAdapter } from './occt-step';

/**
 * I01 (schema v27) across both kernels: ellipse, elliptical-arc and spline
 * profiles extrude to their closed-form or exact-region volumes on Remus and
 * on the OCCT reference, each against the oracle rather than against each
 * other, and with the same face structure (one wall per planned edge).
 */
const user = toUserId('user_curve_entities_parity');
const HEIGHT = 10;

function regionDocument(
  objects: SketchObjectData[],
  pick: (regions: SketchRegion[]) => SketchRegion
) {
  const { document, sketchId } = addSketchFeature(
    createProjectDocument('Curve parity', user),
    {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    }
  );
  const sketch = findSketch(document, sketchId)!;
  const regions = computeSketchRegions(
    sketch.objectIds.map((id) => ({
      id,
      data: (document.nodes[id] as { data: SketchObjectData }).data
    })),
    (value) => (typeof value === 'number' ? value : Number(value))
  );
  const region = pick(regions);
  const extruded = extrudeSketch(document, {
    name: 'Extrude',
    sketchId,
    distance: HEIGHT,
    profiles: [
      {
        profileId: region.profileId,
        regionFingerprint: region.regionFingerprint,
        samplePoint: region.samplePoint,
        sourceArea: region.area,
        sourceEntityIds: region.sourceEntityIds
      }
    ]
  });
  return { ...extruded, region };
}

const largest = (regions: SketchRegion[]) =>
  regions.reduce((best, candidate) =>
    candidate.area > best.area ? candidate : best
  );

describe('I01 curve profiles: Remus and OCCT against the oracle', () => {
  let remus: ExactKernelAdapter;
  let occt: OcctStepKernelAdapter;
  beforeAll(async () => {
    remus = await createExactKernelAdapter();
    occt = await OcctStepKernelAdapter.create();
  });
  afterAll(() => {
    occt.dispose();
  });

  // Remus measures B-spline walls on a 0.08 mm mesh (about 1e-5 relative).
  const BOUND = 1e-4;

  const cases: {
    name: string;
    objects: SketchObjectData[];
    pick?: (regions: SketchRegion[]) => SketchRegion;
    area?: number;
    faces: number;
  }[] = [
    {
      name: 'rotated ellipse',
      objects: [
        {
          objectKind: 'ellipse',
          centerX: 4,
          centerY: -3,
          radiusX: 30,
          radiusY: 12,
          rotationDeg: 25
        }
      ],
      area: Math.PI * 30 * 12,
      faces: 3
    },
    {
      name: 'ellipse hole in a plate',
      objects: [
        {
          objectKind: 'rectangle',
          width: 100,
          height: 60,
          centerX: 0,
          centerY: 0
        },
        {
          objectKind: 'ellipse',
          centerX: -10,
          centerY: 5,
          radiusX: 12,
          radiusY: 22,
          rotationDeg: 10
        }
      ],
      area: 6000 - Math.PI * 12 * 22,
      faces: 10
    },
    {
      name: 'half ellipse closed by its axis',
      objects: [
        {
          objectKind: 'ellipse',
          centerX: 0,
          centerY: 0,
          radiusX: 20,
          radiusY: 9,
          rotationDeg: 0,
          startParamDeg: 0,
          endParamDeg: 180
        },
        { objectKind: 'line', x1: -20, y1: 0, x2: 20, y2: 0 }
      ],
      area: (Math.PI * 20 * 9) / 2,
      faces: 5
    },
    {
      name: 'closed fit spline',
      objects: [
        {
          objectKind: 'spline',
          method: 'fit',
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 30, y: -6 },
            { x: 38, y: 18 },
            { x: 12, y: 26 },
            { x: -4, y: 14 }
          ]
        }
      ],
      faces: 4
    },
    {
      name: 'control spline closed by a line',
      objects: [
        {
          objectKind: 'spline',
          method: 'control',
          degree: 3,
          points: [
            { x: 0, y: 0 },
            { x: 5, y: 25 },
            { x: 25, y: 30 },
            { x: 40, y: 10 },
            { x: 45, y: 0 }
          ]
        },
        { objectKind: 'line', x1: 45, y1: 0, x2: 0, y2: 0 }
      ],
      faces: 4
    }
  ];

  it.each(cases)('builds the $name on both kernels', async (testCase) => {
    const { document, bodyId, region } = regionDocument(
      testCase.objects,
      testCase.pick ?? largest
    );
    const area = testCase.area ?? region.area;
    expect(region.area).toBeCloseTo(area, 8);
    for (const kernel of [remus, occt]) {
      const derived = await kernel.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId]!;
      expect(
        Math.abs(body.volume - area * HEIGHT) / (area * HEIGHT)
      ).toBeLessThan(BOUND);
      expect(body.topology!.faces).toHaveLength(testCase.faces);
    }
  });
});
