import { beforeAll, describe, expect, it } from 'vitest';

import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  listFeaturesInOrder,
  repairedDirectEditOperation,
  staleDirectEditFaceRepair,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  DerivedState,
  FaceTopology,
  FeatureNode,
  ProjectDocument
} from '@openzcad/shared';

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});

function topFace(derived: DerivedState, bodyId: BodyId): FaceTopology {
  const face = derived.bodyRepresentations[bodyId]!.topology!.faces.find(
    (candidate) =>
      candidate.geometry?.surfaceType === 'plane' &&
      candidate.geometry.normal !== undefined &&
      Math.abs(candidate.geometry.normal.z - 1) < 1e-9
  );
  expect(face, 'the body must expose a +z planar face').toBeDefined();
  return face!;
}

/**
 * A box whose top face carries a HASH-ONLY offset edit — no v5 lineage
 * reference, which is the pin that an upstream parametric edit breaks. The
 * box maps height to Y, so the +z cap is width x height = 40 x 10.
 */
async function brokenOffsetDocument(): Promise<{
  document: ProjectDocument;
  bodyId: BodyId;
  directEdit: FeatureNode;
  warnings: string[];
}> {
  const base = addPrimitiveFeature(
    createProjectDocument('Repair', toUserId('user_repair')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, depth: 24, height: 10 }
    }
  );
  const bodyId = base.bodyOrder[0]!;
  const first = await adapter.syncDocument(base);
  const face = topFace(first, bodyId);
  const edited = directEditBody(base, {
    name: 'Raise top',
    targetBodyId: bodyId,
    operation: {
      kind: 'offset-face',
      faceHash: face.hash,
      sourceSurfaceType: 'plane',
      sourceArea: face.geometry!.area,
      sourceCenter: face.geometry!.center,
      sourceNormal: face.geometry!.normal!,
      offset: 5
    }
  }).document;

  // The edit builds cleanly before anything upstream moves.
  const healthy = await adapter.syncDocument(edited);
  expect(healthy.warnings).toEqual([]);
  expect(healthy.bodyRepresentations[bodyId]!.volume).toBeCloseTo(11600, 4);

  // The upstream parametric edit: widening the plate re-fingerprints every
  // face, so the hash-only pin stops resolving and replay skips the edit.
  const primitive = listFeaturesInOrder(edited)[0]!;
  const widened = updateFeature(edited, {
    featureId: primitive.featureId,
    data: { dimensions: { width: 50 } }
  });
  const broken = await adapter.syncDocument(widened);
  expect(
    broken.warnings.some((warning) => warning.includes('no longer exists'))
  ).toBe(true);
  // Fail-soft replay: the widened plate builds, the raise is silently gone.
  expect(broken.bodyRepresentations[bodyId]!.volume).toBeCloseTo(12000, 4);

  const directEdit = listFeaturesInOrder(widened).find(
    (feature) => feature.name === 'Raise top'
  )!;
  return {
    document: widened,
    bodyId,
    directEdit,
    warnings: broken.warnings
  };
}

describe('staleDirectEditFaceRepair', () => {
  it('detects a direct edit whose face identity failed, and only that', async () => {
    const { bodyId, directEdit, warnings } = await brokenOffsetDocument();
    expect(staleDirectEditFaceRepair(directEdit, warnings)).toEqual({
      featureId: directEdit.featureId,
      featureName: 'Raise top',
      targetBodyId: bodyId,
      operationKind: 'offset-face'
    });

    // No warning for the feature: nothing to repair.
    expect(staleDirectEditFaceRepair(directEdit, [])).toBeNull();
    // A warning about the edit's own geometry is not an identity failure.
    expect(
      staleDirectEditFaceRepair(directEdit, [
        'Feature "Raise top": Offsetting the face by 5 does not produce a valid solid.'
      ])
    ).toBeNull();
    // Another feature's warning never matches.
    expect(
      staleDirectEditFaceRepair(directEdit, [
        'Feature "Other": A selected face no longer exists.'
      ])
    ).toBeNull();
  });
});

describe('repairedDirectEditOperation', () => {
  it('re-picking the face brings the edit back with refreshed pins', async () => {
    const { document, bodyId, directEdit, warnings } =
      await brokenOffsetDocument();
    const repair = staleDirectEditFaceRepair(directEdit, warnings)!;

    // While the edit is broken it contributed nothing, so the rendered body
    // IS the state the feature sees at its replay position — the picked
    // face's current measurements are the correct new pins.
    const broken = await adapter.syncDocument(document);
    const picked = topFace(broken, bodyId);
    expect(directEdit.data.featureKind).toBe('direct-edit');
    if (directEdit.data.featureKind !== 'direct-edit') {
      return;
    }
    const operation = repairedDirectEditOperation(
      directEdit.data.operation,
      picked
    );
    expect(operation.kind).toBe('offset-face');
    if (operation.kind !== 'offset-face') {
      return;
    }
    expect(operation.faceHash).toBe(picked.hash);
    expect(operation.sourceArea).toBeCloseTo(500, 6);
    expect(operation.offset).toBe(5);

    // Through the command layer, so the payload-consistency validation and
    // the replayable history are both exercised.
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.updateFeature(
        { featureId: repair.featureId, data: { operation } },
        'Re-pick face'
      )
    );
    const repaired = await adapter.syncDocument(manager.document);
    expect(repaired.warnings).toEqual([]);
    // The widened plate (50 x 10 x 24) with its 50 x 10 top raised by 5.
    expect(repaired.bodyRepresentations[bodyId]!.volume).toBeCloseTo(14500, 4);
  });

  it('refuses a face that cannot carry the edit', async () => {
    const withCylinder = addPrimitiveFeature(
      createProjectDocument('Refusal', toUserId('user_repair')),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 4, height: 12 }
      }
    );
    const cylinderBodyId = withCylinder.bodyOrder[0]!;
    const derived = await adapter.syncDocument(withCylinder);
    const wall = derived.bodyRepresentations[
      cylinderBodyId
    ]!.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    expect(wall).toBeDefined();

    expect(() =>
      repairedDirectEditOperation(
        {
          kind: 'offset-face',
          faceHash: 1,
          sourceSurfaceType: 'plane',
          sourceArea: 400,
          sourceCenter: { x: 0, y: 0, z: 0 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: 5
        },
        wall
      )
    ).toThrow(/planar/);

    expect(() =>
      repairedDirectEditOperation(
        {
          kind: 'resize-blend',
          faceHash: 1,
          surfaceClass: 'cylinder',
          recordedRadius: 2,
          recordedCenter: { x: 0, y: 0, z: 0 },
          recordedAxis: { x: 0, y: 0, z: 1 },
          newRadius: 3
        },
        wall
      )
    ).toThrow(/cannot be repaired/);
  });
});
