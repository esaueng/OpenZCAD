import { beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumPlane,
  addPrimitiveFeature,
  attachDerivedState,
  createProjectDocument,
  deleteFeature,
  findFeature,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FacePlaneSource,
  type ProjectDocument
} from '@openzcad/shared';
import { CommandManager } from '@openzcad/command-system';
import { datumFaceRepairEdit } from '../apps/web/src/lib/datumPlanes';
import { faceSketchAttachment } from '../apps/web/src/lib/faceSketchAttachment';

/**
 * R01: an offset plane on a face that no longer resolves is re-attached by
 * picking another face; only its source changes, and the exact build places
 * it on the new face.
 */
describe('datum face re-pick (R01)', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function synced(document: ProjectDocument) {
    return attachDerivedState(document, await adapter.syncDocument(document));
  }

  function topFace(document: ProjectDocument, bodyId: BodyId) {
    const faces = document.derived.bodyRepresentations[bodyId]!.topology!.faces;
    return faces.find((face) => (face.geometry?.normal?.z ?? 0) > 0.99)!;
  }

  it('re-attaches a broken face datum to the face picked now', async () => {
    let document = createProjectDocument('Repair', toUserId('user_repair'));
    document = addPrimitiveFeature(document, {
      name: 'First',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 5 }
    });
    const first = document.bodyOrder[0]!;
    document = addPrimitiveFeature(document, {
      name: 'Second',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 8 }
    });
    const second = document.bodyOrder[1]!;
    document = transformBody(document, {
      name: 'Beside',
      targetBodyId: second,
      translation: { x: 30, y: 0, z: 0 }
    }).document;
    document = await synced(document);
    const face = topFace(document, first);
    const attachment = faceSketchAttachment({
      bodyId: first,
      pickedHash: face.hash,
      face
    });
    if (!attachment.ok) throw new Error(attachment.reason);
    const planed = addDatumPlane(document, {
      name: 'Lid plane',
      definition: {
        kind: 'offset',
        source: attachment.planeRef as FacePlaneSource,
        offset: 2
      }
    });
    const before = await synced(planed.document);
    expect(
      before.derived.datumFrames?.[planed.featureId]?.origin.z
    ).toBeCloseTo(7, 6);

    // Deleting the first block leaves the plane with no face to stand on.
    const firstFeature = listFeaturesInOrder(before).find(
      (feature) => feature.name === 'First'
    )!;
    const broken = await synced(
      deleteFeature(before, { featureId: firstFeature.featureId })
    );
    expect(broken.derived.datumFrames?.[planed.featureId]).toBeUndefined();

    const target = topFace(broken, second);
    const edit = datumFaceRepairEdit(broken, planed.featureId, {
      bodyId: second,
      kind: 'face',
      topologyId: target.topologyId,
      hash: target.hash
    });
    expect(edit.label).toBe('Re-pick face for Lid plane');
    const manager = new CommandManager(broken);
    manager.execute(edit.command);
    const repaired = await adapter.syncDocument(manager.document);
    expect(() => edit.validateDerived(repaired)).not.toThrow();
    // On the second block's top (z = 8), still 2 above it.
    expect(repaired.datumFrames?.[planed.featureId]?.origin.z).toBeCloseTo(
      10,
      6
    );
    // Only the source changed.
    const data = findFeature(manager.document, planed.featureId)!.data;
    expect(data).toMatchObject({
      featureKind: 'datum-plane',
      definition: { kind: 'offset', offset: 2, source: { bodyId: second } }
    });
  });

  it("re-attaches both of a midplane's lost faces in one edit", async () => {
    let document = createProjectDocument('Both', toUserId('user_repair'));
    document = addPrimitiveFeature(document, {
      name: 'First',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 5 }
    });
    const first = document.bodyOrder[0]!;
    document = addPrimitiveFeature(document, {
      name: 'Second',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 8 }
    });
    const second = document.bodyOrder[1]!;
    document = transformBody(document, {
      name: 'Beside',
      targetBodyId: second,
      translation: { x: 30, y: 0, z: 0 }
    }).document;
    document = await synced(document);
    const faces = (bodyId: BodyId) =>
      document.derived.bodyRepresentations[bodyId]!.topology!.faces;
    const source = (bodyId: BodyId, z: number) => {
      const face = faces(bodyId).find(
        (candidate) => (candidate.geometry?.normal?.z ?? 0) * z > 0.99
      )!;
      const attachment = faceSketchAttachment({
        bodyId,
        pickedHash: face.hash,
        face
      });
      if (!attachment.ok) throw new Error(attachment.reason);
      return attachment.planeRef as FacePlaneSource;
    };
    const planed = addDatumPlane(document, {
      name: 'Middle',
      definition: {
        kind: 'midplane',
        sources: [source(first, 1), source(first, -1)]
      }
    });
    const before = await synced(planed.document);
    expect(
      before.derived.datumFrames?.[planed.featureId]?.origin.z
    ).toBeCloseTo(2.5, 6);
    const firstFeature = listFeaturesInOrder(before).find(
      (feature) => feature.name === 'First'
    )!;
    const broken = await synced(
      deleteFeature(before, { featureId: firstFeature.featureId })
    );
    const pick = (z: number) => {
      const face = broken.derived.bodyRepresentations[
        second
      ]!.topology!.faces.find(
        (candidate) => (candidate.geometry?.normal?.z ?? 0) * z > 0.99
      )!;
      return {
        bodyId: second,
        kind: 'face',
        topologyId: face.topologyId,
        hash: face.hash
      } as const;
    };
    // Either face alone keeps the other on the deleted body: refused.
    const alone = datumFaceRepairEdit(broken, planed.featureId, pick(1), 0);
    expect(() => new CommandManager(broken).execute(alone.command)).toThrow(
      'does not exist'
    );
    // Both together resolve: halfway between the second block's faces.
    const pair = datumFaceRepairEdit(
      broken,
      planed.featureId,
      pick(1),
      0,
      pick(-1)
    );
    const manager = new CommandManager(broken);
    manager.execute(pair.command);
    const repaired = await adapter.syncDocument(manager.document);
    expect(() => pair.validateDerived(repaired)).not.toThrow();
    expect(repaired.datumFrames?.[planed.featureId]?.origin.z).toBeCloseTo(
      4,
      6
    );
  });

  it("re-attaches a midplane's lost face and keeps its other source", async () => {
    let document = createProjectDocument('Midplane', toUserId('user_repair'));
    document = addPrimitiveFeature(document, {
      name: 'First',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 5 }
    });
    const first = document.bodyOrder[0]!;
    document = addPrimitiveFeature(document, {
      name: 'Second',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 8 }
    });
    const second = document.bodyOrder[1]!;
    document = transformBody(document, {
      name: 'Beside',
      targetBodyId: second,
      translation: { x: 30, y: 0, z: 0 }
    }).document;
    document = await synced(document);
    const face = topFace(document, first);
    const attachment = faceSketchAttachment({
      bodyId: first,
      pickedHash: face.hash,
      face
    });
    if (!attachment.ok) throw new Error(attachment.reason);
    const floor = { type: 'canonical', plane: 'XY', offset: 0 } as const;
    const planed = addDatumPlane(document, {
      name: 'Middle',
      definition: {
        kind: 'midplane',
        sources: [attachment.planeRef as FacePlaneSource, floor]
      }
    });
    const before = await synced(planed.document);
    expect(
      before.derived.datumFrames?.[planed.featureId]?.origin.z
    ).toBeCloseTo(2.5, 6);
    const firstFeature = listFeaturesInOrder(before).find(
      (feature) => feature.name === 'First'
    )!;
    const broken = await synced(
      deleteFeature(before, { featureId: firstFeature.featureId })
    );
    expect(broken.derived.datumFrames?.[planed.featureId]).toBeUndefined();

    const target = topFace(broken, second);
    const pick = {
      bodyId: second,
      kind: 'face',
      topologyId: target.topologyId,
      hash: target.hash
    } as const;
    const edit = datumFaceRepairEdit(broken, planed.featureId, pick, 0);
    const manager = new CommandManager(broken);
    manager.execute(edit.command);
    const repaired = await adapter.syncDocument(manager.document);
    expect(() => edit.validateDerived(repaired)).not.toThrow();
    // Halfway between the second block's top (z = 8) and XY.
    expect(repaired.datumFrames?.[planed.featureId]?.origin.z).toBeCloseTo(
      4,
      6
    );
    expect(findFeature(manager.document, planed.featureId)!.data).toMatchObject(
      {
        definition: {
          kind: 'midplane',
          sources: [{ type: 'face', bodyId: second }, floor]
        }
      }
    );

    // Re-picking B onto the same face would collapse the midplane: the
    // validated edit refuses rather than committing it.
    const collapse = datumFaceRepairEdit(
      manager.document,
      planed.featureId,
      pick,
      1
    );
    const again = new CommandManager(manager.document);
    expect(() => again.execute(collapse.command)).toThrow();
  });
});
