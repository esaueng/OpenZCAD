import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type GeometryReadyState
} from '@openzcad/shared';

// `shareRetainedMeasurements` publishes an unchanged body's retained
// measurement by identity. It must change identity only, never content.
describe('shared retained measurements', { timeout: 120_000 }, () => {
  let shared: ExactKernelAdapter;
  let owned: ExactKernelAdapter;
  let document = createProjectDocument('Shared', toUserId('user_fixture'));
  document = addPrimitiveFeature(document, {
    name: 'Cylinder',
    primitiveKind: 'cylinder',
    dimensions: { radius: 4, height: 10 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  const [cylinderId, boxId] = document.bodyOrder as [BodyId, BodyId];
  const box = listFeaturesInOrder(document).at(-1)!;
  const widen = (width: number) =>
    updateFeature(document, {
      featureId: box.featureId,
      data: { dimensions: { width, height: 10, depth: 10 } }
    });
  const comparable = (state: DerivedState | GeometryReadyState) => {
    const { updatedAt: _updatedAt, ...rest } = state;
    return rest;
  };

  beforeAll(async () => {
    shared = await createExactKernelAdapter({
      shareRetainedMeasurements: true
    });
    owned = await createExactKernelAdapter();
  });
  afterAll(() => {
    shared.dispose();
    owned.dispose();
  });

  it('keeps an unchanged body by identity and publishes identical content', async () => {
    const first = await shared.syncDocument(document);
    await owned.syncDocument(document);
    const ready: GeometryReadyState[] = [];
    const second = await shared.syncDocument(
      widen(12),
      undefined,
      undefined,
      undefined,
      {
        onGeometryReady: (geometry) => ready.push(geometry)
      }
    );
    const ownedReady: GeometryReadyState[] = [];
    const ownedSecond = await owned.syncDocument(
      widen(12),
      undefined,
      undefined,
      undefined,
      {
        onGeometryReady: (geometry) => ownedReady.push(geometry)
      }
    );
    expect(comparable(second)).toEqual(comparable(ownedSecond));
    expect(ready.map(comparable)).toEqual(ownedReady.map(comparable));

    const cylinder = (state: DerivedState | GeometryReadyState) =>
      state.bodyRepresentations[cylinderId]!;
    const box = (state: DerivedState | GeometryReadyState) =>
      state.bodyRepresentations[boxId]!;
    // The first sync measured the cylinder; the second served it retained,
    // the same buffers in its early publication and its final state.
    expect(cylinder(second).mesh.vertices).toBe(
      cylinder(ready[0]!).mesh.vertices
    );
    expect(cylinder(second).topology).toBe(cylinder(ready[0]!).topology);
    const third = await shared.syncDocument(widen(13));
    expect(cylinder(third).mesh.vertices).toBe(cylinder(second).mesh.vertices);
    // The edited body is measured afresh and owned by the caller.
    expect(box(third).mesh.vertices).not.toBe(box(second).mesh.vertices);
    expect(box(ready[0]!).mesh.vertices).not.toBe(box(second).mesh.vertices);
    expect(cylinder(first).mesh.vertices).not.toBe(
      cylinder(second).mesh.vertices
    );
  });

  it('copies retained measurements by default', async () => {
    const left = await owned.syncDocument(widen(14));
    const right = await owned.syncDocument(widen(15));
    const id = cylinderId;
    expect(right.bodyRepresentations[id]!.mesh.vertices).not.toBe(
      left.bodyRepresentations[id]!.mesh.vertices
    );
    expect(right.bodyRepresentations[id]!.mesh.vertices).toEqual(
      left.bodyRepresentations[id]!.mesh.vertices
    );
  });
});
