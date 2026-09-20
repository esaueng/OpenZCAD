import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  getLatestBodyId,
  getLatestSketchId,
  importStepBody
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { createCadDocumentDigest } from '@openzcad/ai-contracts';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * A milled rectangular pocket and a fused cylindrical boss reach an imported
 * body's published topology, read-only in effect, through the real document
 * pipeline: model it, export it, import it back, and read what the assistant
 * would be shown.
 *
 * The exact recognizer proves both from the imported solid — the pocket from
 * its floor's exact straight-edge loop enumerated as a planar-floor seed,
 * the boss from its cylindrical wall — so neither needs the kernel
 * recognizer's claim. Neither family has a coordinated direct-edit replay:
 * no DirectEditOperation variant names a pocket or a boss, the Inspector
 * renders both read-only, and the assistant's edit binding accepts only the
 * hole-family proofs. Publishing the exact proof therefore enables no edit.
 */
describe('imported exact pocket and boss features', { timeout: 180_000 }, () => {
  let adapter: ExactKernelAdapter;
  let importedPocket: ProjectDocument;
  let importedBoss: ProjectDocument;

  const PLATE = { width: 30, height: 20, depth: 8 };
  const POCKET_DEPTH = 3;
  const BOSS_RADIUS = 3;
  const BOSS_HEIGHT = 4;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    let source = addPrimitiveFeature(
      createProjectDocument('Pocket source', toUserId('user_pocket_source')),
      { name: 'Plate', primitiveKind: 'box', dimensions: PLATE }
    );
    const plateBodyId = getLatestBodyId(source)!;
    source = addSketchFeature(source, {
      name: 'Pocket outline',
      plane: 'XY',
      offset: PLATE.depth,
      object: {
        objectKind: 'rectangle',
        width: 10,
        height: 6,
        centerX: 10,
        centerY: 10
      }
    }).document;
    const sketchId = getLatestSketchId(source)!;
    source = extrudeSketch(source, {
      name: 'Pocket',
      sketchId,
      distance: -POCKET_DEPTH,
      operation: 'cut',
      targetBodyId: plateBodyId
    }).document;
    source = { ...source, derived: await adapter.syncDocument(source) };
    expect(source.derived.warnings).toEqual([]);

    const pocketStep = await adapter.exportStep(source, [
      getLatestBodyId(source)!
    ]);
    importedPocket = importStepBody(
      createProjectDocument('Imported pocket', toUserId('user_pocket_import')),
      {
        name: 'Imported pocket plate',
        artifactId: 'artifact_imported_pocket',
        sourceName: 'pocket-plate.step',
        stepText: pocketStep
      }
    ).document;
    importedPocket = {
      ...importedPocket,
      derived: await adapter.syncDocument(importedPocket)
    };
    expect(importedPocket.derived.warnings).toEqual([]);

    let bossSource = addPrimitiveFeature(
      createProjectDocument('Boss source', toUserId('user_boss_source')),
      { name: 'Plate', primitiveKind: 'box', dimensions: PLATE }
    );
    const bossPlateId = getLatestBodyId(bossSource)!;
    bossSource = addSketchFeature(bossSource, {
      name: 'Boss outline',
      plane: 'XY',
      offset: PLATE.depth,
      object: {
        objectKind: 'circle',
        radius: BOSS_RADIUS,
        centerX: 10,
        centerY: 10
      }
    }).document;
    const bossSketchId = getLatestSketchId(bossSource)!;
    bossSource = extrudeSketch(bossSource, {
      name: 'Boss',
      sketchId: bossSketchId,
      distance: BOSS_HEIGHT,
      operation: 'add',
      targetBodyId: bossPlateId
    }).document;
    bossSource = {
      ...bossSource,
      derived: await adapter.syncDocument(bossSource)
    };
    expect(bossSource.derived.warnings).toEqual([]);

    const bossStep = await adapter.exportStep(bossSource, [
      getLatestBodyId(bossSource)!
    ]);
    importedBoss = importStepBody(
      createProjectDocument('Imported boss', toUserId('user_boss_import')),
      {
        name: 'Imported boss plate',
        artifactId: 'artifact_imported_boss',
        sourceName: 'boss-plate.step',
        stepText: bossStep
      }
    ).document;
    importedBoss = {
      ...importedBoss,
      derived: await adapter.syncDocument(importedBoss)
    };
    expect(importedBoss.derived.warnings).toEqual([]);
  });

  afterAll(() => {
    adapter.dispose();
  });

  function topologyOf(document: ProjectDocument) {
    return document.derived.bodyRepresentations[document.bodyOrder[0]!]
      ?.topology;
  }

  it('publishes the milled pocket as an exact proof with no edit replay', () => {
    const topology = topologyOf(importedPocket);
    const recognized = topology?.recognizedImportedFeatures ?? [];
    expect(recognized).toHaveLength(1);
    expect(recognized[0]).toMatchObject({
      kind: 'prismatic-pocket',
      depth: POCKET_DEPTH
    });
    expect(recognized[0]).not.toHaveProperty('provenance');
    // Every published face hash names a face in the same inventory, so a
    // consumer can resolve the pocket without a second recognition pass.
    const faceHashes = new Set(topology?.faces.map((face) => face.hash));
    expect(
      recognized[0]?.participatingFaceHashes.every((hash) =>
        faceHashes.has(hash)
      )
    ).toBe(true);
  });

  it('publishes the fused boss as an exact proof with no edit replay', () => {
    const topology = topologyOf(importedBoss);
    const recognized = topology?.recognizedImportedFeatures ?? [];
    expect(recognized).toHaveLength(1);
    expect(recognized[0]).toMatchObject({
      kind: 'cylindrical-boss',
      diameter: BOSS_RADIUS * 2,
      height: BOSS_HEIGHT
    });
    expect(recognized[0]).not.toHaveProperty('provenance');
    const faceHashes = new Set(topology?.faces.map((face) => face.hash));
    expect(
      recognized[0]?.participatingFaceHashes.every((hash) =>
        faceHashes.has(hash)
      )
    ).toBe(true);
  });

  it('keeps recognized faces available to the planar-distance proofs', () => {
    for (const document of [importedPocket, importedBoss]) {
      const topology = topologyOf(document);
      const claimed = new Set(
        (topology?.recognizedImportedFeatures ?? []).flatMap(
          (feature) => feature.participatingFaceHashes
        )
      );
      const pairs = topology?.opposingPlanarFacePairs ?? [];
      // An exact proof must not cost its faces the dimension proofs that
      // are the only editable handle on this body.
      expect(pairs.length).toBeGreaterThan(0);
      expect(
        pairs.some(
          (pair) => claimed.has(pair.faceAHash) || claimed.has(pair.faceBHash)
        )
      ).toBe(true);
    }
  });

  it('shows both features in the digest without offering an edit for either', () => {
    for (const [document, kind] of [
      [importedPocket, 'prismatic-pocket'],
      [importedBoss, 'cylindrical-boss']
    ] as const) {
      const digest = createCadDocumentDigest(document);
      const recognized =
        digest.bodies?.[0]?.topology?.recognizedImportedFeatures ?? [];
      expect(recognized).toHaveLength(1);
      expect(recognized[0]?.kind).toBe(kind);
      // Exact, not kernel-claimed — and still not editable: no
      // DirectEditOperation variant names a pocket or a boss, so neither
      // the Inspector nor the assistant's add_direct_edit binding can
      // target one.
      expect(recognized[0]).not.toHaveProperty('provenance');
    }
  });
});
