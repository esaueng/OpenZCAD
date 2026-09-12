import { beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId, type ParamValue } from '@openzcad/shared';

/**
 * A negative extrude distance used to sweep the profile behind the plane
 * normal without re-orienting the shell. The solid passed standalone
 * validation, so nothing noticed until the next boolean reported
 * inconsistent face orientations: Union refused the body and Add kept an
 * un-unified 14-face fuse with a visible seam. Both builders now sweep along
 * the flipped normal, so a flange pulled into a plate unions to the same
 * eight faces a positive extrude does.
 */
describe('extrude with a negative distance', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);

  const resolve = (value: ParamValue): number =>
    typeof value === 'number' ? value : Number(value);

  function plateDocument() {
    const document = addPrimitiveFeature(
      createProjectDocument('Flange on a plate', toUserId('user_exact')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 80, height: 50, depth: 8 }
      }
    );
    return { document, plateId: document.bodyOrder.at(-1)! };
  }

  async function expectCleanUnion(
    document: ReturnType<typeof plateDocument>['document'],
    plateId: BodyId,
    flangeId: BodyId
  ) {
    const before = await adapter.syncDocument(document);
    expect(before.warnings).toEqual([]);
    // The flange sits on the plate's top face: y 0..8, z 8..48.
    expect(before.bodyRepresentations[flangeId]?.bbox).toEqual({
      min: { x: 0, y: 0, z: 8 },
      max: { x: 80, y: 8, z: 48 }
    });
    const manager = new CommandManager(document);
    const united = manager.execute(
      commandFactories.booleanBodies({
        name: 'Bracket',
        operation: 'union',
        targetBodyIds: [plateId, flangeId]
      })
    );
    const derived = await adapter.syncDocument(united);
    expect(derived.warnings).toEqual([]);
    const bracket = derived.bodyRepresentations[united.bodyOrder.at(-1)!];
    expect(bracket?.volume).toBeCloseTo(80 * 50 * 8 + 80 * 8 * 40, 6);
    expect(bracket?.faceCount).toBe(8);
  }

  it('whole-object extrude pulled toward the plate unions to one L-bracket', async () => {
    const { document: base, plateId } = plateDocument();
    // Sketch plane XZ lifted to y = 8; the flange spans z 8..48 (sketch v
    // points to -Z) and −8 pulls it back to y = 0, onto the plate's top.
    const { document: withSketch, sketchId } = addSketchFeature(base, {
      name: 'Flange profile',
      plane: 'XZ',
      offset: 8,
      object: {
        objectKind: 'rectangle',
        width: 80,
        height: 40,
        centerX: 40,
        centerY: -28
      }
    });
    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Flange',
      sketchId,
      distance: -8
    });
    await expectCleanUnion(document, plateId, bodyId);
  }, 120_000);

  it('region extrude pulled toward the plate unions to one L-bracket', async () => {
    const { document: base, plateId } = plateDocument();
    const { document: withSketch, sketchId } = addSketchFeature(base, {
      name: 'Flange profile',
      planeRef: { type: 'canonical', plane: 'XZ', offset: 8 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 80,
          height: 40,
          centerX: 40,
          centerY: -28
        }
      ]
    });
    const sketch = findSketch(withSketch, sketchId)!;
    const objects = sketch.objectIds.flatMap((id) => {
      const node = withSketch.nodes[id];
      return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
    });
    const [region] = computeSketchRegions(objects, resolve);
    expect(region).toBeTruthy();
    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Flange',
      sketchId,
      distance: -8,
      profile: {
        regionFingerprint: region!.regionFingerprint,
        samplePoint: region!.samplePoint,
        sourceArea: region!.area
      }
    });
    await expectCleanUnion(document, plateId, bodyId);
  }, 120_000);
});
