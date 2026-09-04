import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  filletEdges,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Direct-edit pins versus lineage.
 *
 * A direct edit records the geometry of the face it was made on — radius,
 * axis, area — so that a hash-resolved face can be proven to be the one the
 * user picked. When the face resolves by lineage instead, identity is already
 * proven by role, and the same pins would refuse exactly the upstream edits
 * the feature exists to survive: a taller cylinder moves the wall's axis end,
 * a re-sized source changes its radius, a moved body carries its blend
 * carriers with it. These tests pin that a lineage-carried
 * `resize-cylindrical-face` and `resize-blend` follow such edits, and that
 * the hash-only edits still fail closed as they always have.
 */

const user = toUserId('user_lineage_pins');

function cylinderWall(body: BodyRepresentation | undefined) {
  return body?.topology?.faces.find(
    (face) => face.geometry?.surfaceType === 'cylinder'
  );
}

describe('resize-cylindrical-face under lineage', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  async function resizedCylinder(options: {
    withReference: boolean;
  }): Promise<{ document: ProjectDocument; bodyId: BodyId }> {
    const base = addPrimitiveFeature(createProjectDocument('Wall', user), {
      name: 'Cyl',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4, height: 12 }
    });
    const bodyId = base.bodyOrder[0]!;
    const derived = await adapter.syncDocument(base);
    const wall = cylinderWall(derived.bodyRepresentations[bodyId]);
    expect(wall?.reference?.lineageName).toBe('primitive.cylinder.face.wall');
    const geometry = wall!.geometry!;
    const edited = directEditBody(base, {
      name: 'Set wall radius',
      targetBodyId: bodyId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: wall!.hash,
        ...(options.withReference ? { faceReference: wall!.reference } : {}),
        sourceRadius: geometry.radius!,
        sourceAxisStart: geometry.axisStart!,
        sourceAxisEnd: geometry.axisEnd!,
        concavity: 'boss',
        radius: 6
      }
    });
    const check = await adapter.syncDocument(edited.document);
    expect(check.warnings).toEqual([]);
    expect(check.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      Math.PI * 36 * 12,
      2
    );
    return { document: edited.document, bodyId };
  }

  function withDimensions(
    document: ProjectDocument,
    dimensions: Record<string, number>
  ) {
    const cylinder = listFeaturesInOrder(document).find(
      (feature) => feature.name === 'Cyl'
    )!;
    return updateFeature(document, {
      featureId: cylinder.featureId,
      data: { dimensions }
    });
  }

  it('follows a height change that moves the wall axis end', async () => {
    const { document, bodyId } = await resizedCylinder({ withReference: true });
    const after = await adapter.syncDocument(
      withDimensions(document, { height: 20 })
    );
    expect(after.warnings).toEqual([]);
    expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      Math.PI * 36 * 20,
      2
    );
  });

  it('follows a source radius change and still lands on the stored radius', async () => {
    const { document, bodyId } = await resizedCylinder({ withReference: true });
    const after = await adapter.syncDocument(
      withDimensions(document, { radius: 5 })
    );
    expect(after.warnings).toEqual([]);
    expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      Math.PI * 36 * 12,
      2
    );
  });

  it('is a quiet no-op when the source already reaches the stored radius', async () => {
    const { document, bodyId } = await resizedCylinder({ withReference: true });
    const after = await adapter.syncDocument(
      withDimensions(document, { radius: 6 })
    );
    expect(after.warnings).toEqual([]);
    expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      Math.PI * 36 * 12,
      2
    );
  });

  it('keeps a reference-free resize fail-closed after the same edits', async () => {
    const { document, bodyId } = await resizedCylinder({
      withReference: false
    });
    const after = await adapter.syncDocument(
      withDimensions(document, { height: 20 })
    );
    // The wall's fingerprint embeds its extent, so the hash stops resolving
    // before any recorded-geometry pin is reached; the edit contributes
    // nothing and the resized primitive stands alone.
    expect(after.warnings).toHaveLength(1);
    expect(after.warnings[0]).toMatch(/Set wall radius.*no longer/);
    expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      Math.PI * 16 * 20,
      2
    );
  });
});

describe('resize-blend under lineage', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  /**
   * An imported plate with one filleted corner, moved by a transform feature,
   * then its blend resized. The import publishes lineage for the blend faces
   * and a rigid transform carries it, so the seed resolves by role on the
   * moved body — which is exactly when the recorded carrier centre would
   * otherwise refuse the next move.
   */
  async function movedImportedBlend(options: {
    withReference: boolean;
    newRadius?: number;
  }) {
    const source = addPrimitiveFeature(
      createProjectDocument('Blend source', user),
      {
        name: 'Blend block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const sourceBodyId = source.bodyOrder[0]!;
    const sourceDerived = await adapter.syncDocument(source);
    const corner = { x: 20, y: 20, z: 20 };
    const edgeHashes = sourceDerived.bodyRepresentations[
      sourceBodyId
    ]!.topology!.edges.filter((edge) => {
      for (let offset = 0; offset + 2 < edge.points.length; offset += 3) {
        if (
          Math.hypot(
            edge.points[offset]! - corner.x,
            edge.points[offset + 1]! - corner.y,
            edge.points[offset + 2]! - corner.z
          ) <= 1e-8
        ) {
          return true;
        }
      }
      return false;
    }).map((edge) => edge.hash);
    expect(edgeHashes).toHaveLength(3);
    const filleted = filletEdges(source, {
      name: 'Corner fillet',
      targetBodyId: sourceBodyId,
      edgeHashes,
      size: 3
    }).document;
    const stepText = await adapter.exportStep(filleted, [
      filleted.bodyOrder.at(-1)!
    ]);

    const manager = new CommandManager(
      createProjectDocument('Imported blend', user)
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Filleted plate',
        artifactId: 'artifact_lineage_pins',
        sourceName: 'filleted-plate.step',
        stepText
      })
    );
    const bodyId = manager.document.bodyOrder[0]!;
    const moved = transformBody(manager.document, {
      name: 'Move',
      targetBodyId: bodyId,
      translation: { x: 5, y: 0, z: 0 }
    }).document;
    const derived = await adapter.syncDocument(moved);
    const seed = derived.bodyRepresentations[bodyId]!.topology!.faces.find(
      (face) => Math.abs((face.geometry?.blendRadius ?? 0) - 3) < 1e-6
    );
    expect(seed?.reference?.lineageName).toMatch(/^import\.step\.face\./);
    const geometry = seed!.geometry!;
    const center =
      geometry.surfaceType === 'torus'
        ? geometry.torusCenter!
        : {
            x: (geometry.axisStart!.x + geometry.axisEnd!.x) / 2,
            y: (geometry.axisStart!.y + geometry.axisEnd!.y) / 2,
            z: (geometry.axisStart!.z + geometry.axisEnd!.z) / 2
          };
    const axis =
      geometry.surfaceType === 'torus'
        ? geometry.axis!
        : {
            x: geometry.axisEnd!.x - geometry.axisStart!.x,
            y: geometry.axisEnd!.y - geometry.axisStart!.y,
            z: geometry.axisEnd!.z - geometry.axisStart!.z
          };
    const edited = directEditBody(moved, {
      name: 'Resize blend',
      targetBodyId: bodyId,
      operation: {
        kind: 'resize-blend',
        faceHash: seed!.hash,
        ...(options.withReference ? { faceReference: seed!.reference } : {}),
        surfaceClass: geometry.surfaceType as 'torus' | 'cylinder',
        recordedRadius: geometry.blendRadius!,
        recordedCenter: center,
        recordedAxis: axis,
        newRadius: options.newRadius ?? 2
      }
    }).document;
    const resized = await adapter.syncDocument(edited);
    expect(resized.warnings).toEqual([]);
    return {
      document: edited,
      bodyId,
      resizedVolume: resized.bodyRepresentations[bodyId]!.volume
    };
  }

  function movedTo(document: ProjectDocument, x: number) {
    const transform = listFeaturesInOrder(document).find(
      (feature) => feature.name === 'Move'
    )!;
    return updateFeature(document, {
      featureId: transform.featureId,
      data: {
        transform: {
          translation: { x, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 }
        }
      }
    });
  }

  it('follows the body when the transform before it moves', async () => {
    const { document, bodyId, resizedVolume } = await movedImportedBlend({
      withReference: true
    });
    const after = await adapter.syncDocument(movedTo(document, 9));
    expect(after.warnings).toEqual([]);
    // A translation changes no volume: the blend is still resized to 2.
    expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      resizedVolume,
      6
    );
  });

  it('stays a quiet no-op after the body moves when the blend is already at the stored radius', async () => {
    const { document, bodyId, resizedVolume } = await movedImportedBlend({
      withReference: true,
      newRadius: 3
    });
    const after = await adapter.syncDocument(movedTo(document, 9));
    expect(after.warnings).toEqual([]);
    expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      resizedVolume,
      6
    );
  });

  it('keeps a reference-free blend resize fail-closed when the body moves', async () => {
    const { document, bodyId, resizedVolume } = await movedImportedBlend({
      withReference: false
    });
    const after = await adapter.syncDocument(movedTo(document, 9));
    expect(after.warnings).toHaveLength(1);
    expect(after.warnings[0]).toMatch(/Resize blend.*no longer/);
    // The failed edit contributes nothing: the plate keeps its r 3 fillet.
    expect(after.bodyRepresentations[bodyId]!.volume).not.toBeCloseTo(
      resizedVolume,
      3
    );
  });
});
