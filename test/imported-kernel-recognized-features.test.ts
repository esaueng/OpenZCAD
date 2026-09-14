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
 * A milled rectangular pocket reaches an imported body's published topology,
 * read-only, through the real document pipeline: mill it, export it, import it
 * back, and read what the assistant would be shown.
 *
 * The exact recognizer publishes nothing for this body — its pocket proof needs
 * an exact straight-edge loop it cannot supply from a live solid — so every
 * assertion here is about the kernel recognizer's family, and about the fact
 * that publishing it changed nothing an edit binds to.
 */
describe('imported kernel-recognized features', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  let imported: ProjectDocument;

  const PLATE = { width: 30, height: 20, depth: 8 };
  const POCKET_DEPTH = 3;

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

    const stepText = await adapter.exportStep(source, [
      getLatestBodyId(source)!
    ]);
    imported = importStepBody(
      createProjectDocument('Imported pocket', toUserId('user_pocket_import')),
      {
        name: 'Imported pocket plate',
        artifactId: 'artifact_imported_pocket',
        sourceName: 'pocket-plate.step',
        stepText
      }
    ).document;
    imported = { ...imported, derived: await adapter.syncDocument(imported) };
    expect(imported.derived.warnings).toEqual([]);
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('publishes the milled pocket as a read-only recognized feature', () => {
    const topology =
      imported.derived.bodyRepresentations[imported.bodyOrder[0]!]?.topology;
    const recognized = topology?.recognizedImportedFeatures ?? [];
    expect(recognized).toHaveLength(1);
    expect(recognized[0]).toMatchObject({
      kind: 'prismatic-pocket',
      depth: POCKET_DEPTH,
      provenance: 'kernel-recognized'
    });
    // Every published face hash names a face in the same inventory, so a
    // consumer can resolve the pocket without a second recognition pass.
    const faceHashes = new Set(topology?.faces.map((face) => face.hash));
    expect(
      recognized[0]?.participatingFaceHashes.every((hash) =>
        faceHashes.has(hash)
      )
    ).toBe(true);
  });

  it('keeps the pocket faces available to the planar-distance proofs', () => {
    const topology =
      imported.derived.bodyRepresentations[imported.bodyOrder[0]!]?.topology;
    const claimed = new Set(
      (topology?.recognizedImportedFeatures ?? []).flatMap(
        (feature) => feature.participatingFaceHashes
      )
    );
    const pairs = topology?.opposingPlanarFacePairs ?? [];
    // A read-only feature must not cost its faces the dimension proofs that
    // are the only editable handle on this body.
    expect(pairs.length).toBeGreaterThan(0);
    expect(
      pairs.some(
        (pair) => claimed.has(pair.faceAHash) || claimed.has(pair.faceBHash)
      )
    ).toBe(true);
  });

  it('shows the feature in the digest without offering an edit for it', () => {
    const digest = createCadDocumentDigest(imported);
    const recognized =
      digest.bodies?.[0]?.topology?.recognizedImportedFeatures ?? [];
    expect(recognized).toHaveLength(1);
    expect(recognized[0]?.provenance).toBe('kernel-recognized');
    // No direct-edit operation names a pocket, so the read-only family cannot
    // be the target of one; this pins that the digest still says which
    // recognizer answered.
    expect(recognized[0]?.kind).toBe('prismatic-pocket');
  });
});
