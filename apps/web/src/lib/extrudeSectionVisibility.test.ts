import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type BoundingBox
} from '@openzcad/shared';
import {
  resolveExtrudeOperation,
  type ResolvedExtrude
} from './extrudeInference';
import { isExtrudeChangeClipped } from './extrudeSectionVisibility';
import { ProjectionReceiver, ProjectionSender } from './projectionStream';

const flippedYZ = { plane: 'YZ', offset: 66, flipped: true } as const;

describe('extrude section visibility', { timeout: 30_000 }, () => {
  let kernel: ExactKernelAdapter;
  let cut: ResolvedExtrude;
  let result: BodyRepresentation;
  let tool: BoundingBox;
  let reusedMeasurements: number;

  beforeAll(async () => {
    kernel = await createExactKernelAdapter({
      shareRetainedMeasurements: true,
      onRebuildCacheEvent: (event) => {
        reusedMeasurements = event.reusedMeasurements;
      }
    });
    const plate = addPrimitiveFeature(
      createProjectDocument('Plate with blind cut', toUserId('user_section')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 74, height: 53, depth: 8 }
      }
    );
    const { document: base, sketchId } = addSketchFeature(plate, {
      name: 'Bore layout',
      plane: 'XY',
      offset: 8,
      object: { objectKind: 'circle', radius: 2.5, centerX: 57, centerY: 20 }
    });
    cut = await resolveExtrudeOperation({
      base,
      input: { name: 'Bore', sketchId, distance: -6 },
      derive: (next) => kernel.syncDocument(next)
    });
    result = cut.derived.bodyRepresentations[cut.command.payload.ids!.bodyId]!;
    tool = cut.toolBounds!;
  });

  afterAll(() => kernel?.dispose());

  it('uses the blind Auto Cut tool even when the plate remains visible', () => {
    expect(cut.inference.operation).toBe('cut');
    expect(tool.min.x).toBeCloseTo(54.5);
    expect(tool.max.x).toBeCloseTo(59.5);
    expect(result.bbox.max.x).toBe(74);
    expect(isExtrudeChangeClipped(cut, flippedYZ)).toBe(true);
    expect(isExtrudeChangeClipped(cut, { ...flippedYZ, flipped: false })).toBe(
      false
    );
  });

  it('proves a rotated elliptical sweep is wholly clipped despite loose raw bounds', async () => {
    const plate = addPrimitiveFeature(
      createProjectDocument('Rotated ellipse', toUserId('user_section')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 200, height: 100, depth: 10 }
      }
    );
    const { document: base, sketchId } = addSketchFeature(plate, {
      name: 'Elliptical profile',
      plane: 'XY',
      offset: 10,
      object: {
        objectKind: 'ellipse',
        centerX: 200,
        centerY: 20,
        radiusX: 100,
        radiusY: 60,
        rotationDeg: 45
      }
    });
    const ellipseKernel = await createExactKernelAdapter();
    try {
      const preview = await resolveExtrudeOperation({
        base,
        input: {
          name: 'Elliptical extrusion',
          sketchId,
          distance: 5,
          profiles: [
            {
              all: true,
              sourceEntityIds: findSketch(base, sketchId)!.objectIds
            }
          ]
        },
        choice: { operation: 'new-body' },
        derive: (next) => ellipseKernel.syncDocument(next)
      });
      expect(preview.toolBounds?.min.x).toBeGreaterThan(117);
      expect(preview.toolBounds?.min.x).toBeLessThanOrEqual(
        200 - Math.hypot(100, 60) / Math.SQRT2
      );
      expect(
        isExtrudeChangeClipped(preview, { plane: 'YZ', offset: 100 })
      ).toBe(true);
      expect(
        isExtrudeChangeClipped(preview, { plane: 'YZ', offset: 118 })
      ).toBe(false);
    } finally {
      ellipseKernel.dispose();
    }
  });

  it.each([
    ['XY', 'z'],
    ['XZ', 'y'],
    ['YZ', 'x']
  ] as const)('checks both kept half-spaces of %s', (plane, axis) => {
    expect(
      isExtrudeChangeClipped(cut, { plane, offset: tool.min[axis] - 1 })
    ).toBe(true);
    expect(
      isExtrudeChangeClipped(cut, {
        plane,
        offset: tool.max[axis] + 1,
        flipped: true
      })
    ).toBe(true);
    const middle = (tool.min[axis] + tool.max[axis]) / 2;
    expect(isExtrudeChangeClipped(cut, { plane, offset: middle })).toBe(false);
    expect(
      isExtrudeChangeClipped(cut, { plane, offset: middle, flipped: true })
    ).toBe(false);
    expect(isExtrudeChangeClipped(cut, { plane, offset: tool.min[axis] })).toBe(
      false
    );
    expect(
      isExtrudeChangeClipped(cut, {
        plane,
        offset: tool.max[axis],
        flipped: true
      })
    ).toBe(false);
  });

  it('allows for the rendered plate edge bias near the section plane', () => {
    expect(
      isExtrudeChangeClipped(cut, { ...flippedYZ, offset: tool.max.x + 0.1 })
    ).toBe(false);
  });

  it('leaves clearance for Float32 at large coordinates', () => {
    const max = 2 ** 24;
    const remote = {
      ...cut,
      toolBounds: {
        min: { ...tool.min, x: max - 5 },
        max: { ...tool.max, x: max }
      }
    };
    expect(Math.fround(max + 0.25)).toBe(Math.fround(max));
    expect(
      isExtrudeChangeClipped(remote, { ...flippedYZ, offset: max + 0.25 })
    ).toBe(false);
  });

  it('requires finite nonempty outer bounds and a finite section offset', () => {
    const invalid = [
      undefined,
      { ...tool, min: { ...tool.min, y: NaN } },
      { ...tool, max: { ...tool.max, z: tool.min.z - 1 } },
      { ...tool, max: { ...tool.max, z: tool.min.z } },
      { ...tool, max: { ...tool.max, z: Number.MAX_VALUE } }
    ];
    for (const toolBounds of invalid) {
      expect(isExtrudeChangeClipped({ ...cut, toolBounds }, flippedYZ)).toBe(
        false
      );
    }
    expect(
      isExtrudeChangeClipped(cut, { ...flippedYZ, offset: Infinity })
    ).toBe(false);
  });

  it('requires the accepted native result and rejects a passed-through refusal', () => {
    const { bodyId, featureId } = cut.command.payload.ids!;
    const altered = (body?: BodyRepresentation): ResolvedExtrude => {
      const bodies = { ...cut.derived.bodyRepresentations };
      if (body) bodies[bodyId] = body;
      else delete bodies[bodyId];
      return {
        ...cut,
        derived: { ...cut.derived, bodyRepresentations: bodies }
      };
    };
    for (const body of [
      undefined,
      { ...result, consumed: true },
      { ...result, displayQuality: 'draft' } as const,
      { ...result, volume: 0 },
      { ...result, meshReference: true } as const,
      { ...result, mesh: { ...result.mesh, indices: new Uint32Array() } },
      { ...result, solidBounds: undefined }
    ]) {
      expect(isExtrudeChangeClipped(altered(body), flippedYZ)).toBe(false);
    }
    const refused = {
      featureId,
      featureName: cut.command.payload.name,
      message: 'The result is the passed-through target.',
      kind: 'build-failed' as const
    };
    expect(
      isExtrudeChangeClipped(
        {
          ...cut,
          derived: { ...cut.derived, featureWarnings: [refused] }
        },
        flippedYZ
      )
    ).toBe(false);
    expect(
      isExtrudeChangeClipped(
        {
          ...cut,
          derived: {
            ...cut.derived,
            featureWarnings: [{ ...refused, kind: 'advisory' }]
          }
        },
        flippedYZ
      )
    ).toBe(true);
  });

  it('keeps conservative bounds through cache reuse and worker projection while stripping them from stored documents', async () => {
    const replay = await kernel.syncDocument(cut.document);
    expect(reusedMeasurements).toBe(cut.document.bodyOrder.length);
    const projectId = cut.document.projectId;
    const sender = new ProjectionSender('extrude-section-test');
    const receiver = new ProjectionReceiver();
    receiver.apply(sender.encode(projectId, cut.derived));
    const frame = receiver.apply(sender.encode(projectId, replay));
    expect(frame?.bodyRepresentations[result.bodyId]?.solidBounds).toEqual(
      result.solidBounds
    );
    expect(result.solidBounds).toBeDefined();
    expect(
      withoutDerivedProjection({ ...cut.document, derived: replay }).derived
        .bodyRepresentations
    ).toEqual({});
  });
});
