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
  type DirectEditOperation,
  type OpposingPlanarFacePair,
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

function distanceOperation(
  pair: OpposingPlanarFacePair,
  distance: number
): Extract<DirectEditOperation, { kind: 'set-face-distance' }> {
  return {
    kind: 'set-face-distance',
    faceHash: pair.faceAHash,
    faceReference: pair.faceAReference,
    oppositeFaceHash: pair.faceBHash,
    oppositeFaceReference: pair.faceBReference,
    sourceDistance: pair.distance,
    moveMode: pair.moveMode,
    distance
  };
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
    singleEdge?: boolean;
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
    const selectedEdges = options.singleEdge
      ? edgeHashes.slice(0, 1)
      : edgeHashes;
    const filleted = filletEdges(source, {
      name: 'Corner fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: selectedEdges,
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
      resizedVolume: resized.bodyRepresentations[bodyId]!.volume,
      resizedTopology: resized.bodyRepresentations[bodyId]!.topology,
      sourceBlendLineageName: seed!.reference?.lineageName,
      sourceBlendReference: seed!.reference,
      sourceBlendHash: seed!.hash
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
    const { document, bodyId, resizedVolume, resizedTopology } =
      await movedImportedBlend({
      withReference: true
      });
    const resizedBlendReferences = resizedTopology?.faces
      .filter((face) => face.geometry?.featureType === 'blend')
      .map((face) => face.reference?.lineageName)
      .filter((lineageName): lineageName is string => lineageName !== undefined);
    expect(resizedBlendReferences.length).toBeGreaterThan(0);
    expect(new Set(resizedBlendReferences).size).toBe(
      resizedBlendReferences.length
    );
    expect(resizedBlendReferences.every((lineageName) =>
      lineageName.startsWith('direct-edit.resize-blend.band.')
    )).toBe(true);
    const resizedBlend = resizedTopology?.faces.find(
      (face) => face.geometry?.featureType === 'blend'
    );
    expect(resizedBlend?.reference?.lineageName).toMatch(
      /^direct-edit\.resize-blend\.band\./
    );
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

  it('uses construction evolution to remove a cylindrical planar-pair blend at R0', async () => {
    const {
      document,
      bodyId,
      resizedVolume,
      resizedTopology,
      sourceBlendLineageName,
      sourceBlendReference,
      sourceBlendHash
    } =
      await movedImportedBlend({
        withReference: true,
        newRadius: 0,
        singleEdge: true
      });
    expect(
      resizedTopology?.faces.some(
        (face) => face.geometry?.featureType === 'blend'
      )
    ).toBe(false);
    expect(
      resizedTopology?.faces.some((face) =>
        face.reference?.lineageName?.startsWith('import.step.face.')
      )
    ).toBe(true);
    expect(
      resizedTopology?.faces.some(
        (face) => face.reference?.lineageName === sourceBlendLineageName
      )
    ).toBe(false);

    const pair = resizedTopology?.opposingPlanarFacePairs?.find(
      (candidate) => Math.abs(candidate.normal.x) > 1 - 1e-6
    );
    expect(pair).toBeDefined();
    expect(
      resizedTopology?.faces.some(
        (face) =>
          face.reference?.lineageName === pair!.faceAReference.lineageName
      )
    ).toBe(true);
    expect(
      resizedTopology?.faces.some(
        (face) =>
          face.reference?.lineageName === pair!.faceBReference.lineageName
      )
    ).toBe(true);
    const downstream = directEditBody(document, {
      name: 'Downstream support distance',
      targetBodyId: bodyId,
      operation: distanceOperation(pair!, pair!.distance + 1)
    }).document;
    const rebuilt = await adapter.syncDocument(downstream);
    expect(rebuilt.warnings).toEqual([]);
    expect(rebuilt.bodyRepresentations[bodyId]!.volume).not.toBeCloseTo(
      resizedVolume,
      6
    );
    const rebuiltPair = rebuilt.bodyRepresentations[
      bodyId
    ]!.topology!.opposingPlanarFacePairs?.find(
      (candidate) =>
        candidate.faceAReference.lineageName ===
          pair!.faceAReference.lineageName &&
        candidate.faceBReference.lineageName === pair!.faceBReference.lineageName
    );
    expect(rebuiltPair).toBeDefined();
    expect(rebuiltPair!.distance).toBeCloseTo(pair!.distance + 1, 6);

    const freshAdapter = await createExactKernelAdapter();
    try {
      const reloaded = await freshAdapter.syncDocument(
        JSON.parse(JSON.stringify(downstream)) as ProjectDocument
      );
      expect(reloaded.warnings).toEqual([]);
      expect(reloaded.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        rebuilt.bodyRepresentations[bodyId]!.volume,
        6
      );
    } finally {
      freshAdapter.dispose();
    }

    const stale = directEditBody(document, {
      name: 'Rejected deleted blend reference',
      targetBodyId: bodyId,
      operation: {
        ...distanceOperation(pair!, pair!.distance + 1),
        faceHash: sourceBlendHash,
        faceReference: sourceBlendReference
      }
    }).document;
    const staleResult = await adapter.syncDocument(stale);
    expect(staleResult.warnings).toHaveLength(1);
    expect(staleResult.warnings[0]).toMatch(/face|reference/i);
    expect(staleResult.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      resizedVolume,
      6
    );
  });
});
