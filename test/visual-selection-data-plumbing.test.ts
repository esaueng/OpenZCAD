import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyRepresentation } from '@openzcad/shared';
import { editableFilletFeature } from '../apps/web/src/lib/interaction/filletFaceEdit';
import {
  preferredCapability,
  selectionCapabilities
} from '../apps/web/src/lib/interaction/capabilities';

describe('visual-selection face geometry payload', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  async function deriveOnlyBody(
    document: Parameters<ExactKernelAdapter['syncDocument']>[0]
  ): Promise<BodyRepresentation> {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const bodyId = document.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[bodyId];
    expect(body).toBeDefined();
    return body!;
  }

  it('classifies a straight box fillet as a cylindrical blend', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Box blend payload', toUserId('user_vsel')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const baseBody = await deriveOnlyBody(base);
    const edge = baseBody.topology!.edges.find(
      (candidate) => candidate.displayRole !== 'seam'
    )!;
    const result = filletEdges(base, {
      name: 'Straight fillet',
      targetBodyId: base.bodyOrder.at(-1)!,
      edgeHashes: [edge.hash],
      ...(edge.reference ? { edgeReferences: [edge.reference] } : {}),
      size: 2
    });
    const body = await deriveOnlyBody(result.document);
    const blend = body.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'cylinder' &&
        face.geometry.featureType === 'blend'
    );

    expect(blend?.geometry?.radius).toBeCloseTo(2, 12);
    expect(blend?.geometry?.blendRadius).toBeCloseTo(2, 12);
    const filletFeature = listFeaturesInOrder(result.document).at(-1)!;
    expect(blend?.reference?.producingFeatureId).toBe(filletFeature.featureId);
    const editable = blend
      ? editableFilletFeature(result.document, blend)
      : null;
    expect(editable?.featureId).toBe(filletFeature.featureId);
    expect(
      preferredCapability(
        selectionCapabilities({
          kind: 'face',
          target: {
            surfaceType: 'cylindrical',
            hash: blend?.hash,
            radius: blend?.geometry?.radius,
            blendRadius: blend?.geometry?.blendRadius,
            filletFeatureId: editable?.featureId
          }
        })
      )?.action
    ).toBe('edit-fillet');
  });

  it('publishes a rim fillet as a torus blend with its minor radius', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Torus blend payload', toUserId('user_vsel')),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 10 }
      }
    );
    const baseBody = await deriveOnlyBody(base);
    const rim = baseBody.topology!.edges.find(
      (edge) => edge.displayRole !== 'seam' && edge.curve?.type === 'CIRCLE'
    )!;
    const result = filletEdges(base, {
      name: 'Rim fillet',
      targetBodyId: base.bodyOrder.at(-1)!,
      edgeHashes: [rim.hash],
      ...(rim.reference ? { edgeReferences: [rim.reference] } : {}),
      size: 1
    });
    const body = await deriveOnlyBody(result.document);
    const blend = body.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'torus'
    );

    expect(blend?.geometry).toMatchObject({
      featureType: 'blend',
      torusCenter: { x: 0, y: 0, z: 1 },
      majorRadius: 4,
      minorRadius: 1,
      blendRadius: 1
    });
    const filletFeature = listFeaturesInOrder(result.document).at(-1)!;
    expect(filletFeature.data.featureKind).toBe('fillet');
    expect(blend?.reference?.producingFeatureId).toBe(filletFeature.featureId);
  });

  it('does not classify the wall of a plain cylinder boss as a blend', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Plain boss payload', toUserId('user_vsel')),
      {
        name: 'Boss',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 10 }
      }
    );
    const body = await deriveOnlyBody(document);
    const wall = body.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );

    expect(wall?.geometry?.featureType).toBeUndefined();
    expect(wall?.geometry?.blendRadius).toBeUndefined();
  });

  it('publishes exact conical analytic parameters without changing center', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Cone payload', toUserId('user_vsel')),
      {
        name: 'Frustum',
        primitiveKind: 'cone',
        dimensions: { bottomRadius: 5, topRadius: 2, height: 10 }
      }
    );
    const body = await deriveOnlyBody(document);
    const cone = body.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cone'
    )!.geometry!;

    expect(cone.apex).toEqual({ x: 0, y: 0, z: 50 / 3 });
    expect(cone.axis).toEqual({ x: 0, y: 0, z: -1 });
    expect(cone.halfAngle).toBeCloseTo(Math.atan2(10, 3), 12);
    expect(cone.center).not.toEqual(cone.apex);
  });
});
