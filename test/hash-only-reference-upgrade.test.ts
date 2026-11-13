import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  draftBody,
  filletEdges,
  holeBody,
  listFeaturesInOrder,
  shellBody,
  thickenFace,
  updateFeature
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FeatureData,
  type ProjectDocument
} from '@openzcad/shared';
import { topologyReferenceRepairCommand } from '../apps/web/src/lib/topologyReferenceRepairs';
import {
  fragileSelectionSteps,
  hashOnlySelections
} from '../apps/web/src/lib/fragileSelections';

/**
 * Hash-only picks are upgraded to schema-v5 references once their entity
 * carries a lineage name (ADR-013, H01/M07 amendment of 2026-11-12, "hash-only
 * picks are upgraded wherever they resolve").
 *
 * A pick stored with only its ADR-011 hash dies on the first upstream edit
 * that changes the picked entity's dimensions. While the hash still resolves
 * — a clean rebuild — the face it names is known exactly, so the body's name
 * for that face can be written beside the hash. Edge modifiers and a direct
 * edit's own face had this already; these pin it for every other stored face
 * pick, then that the upgraded pick follows the upstream edit the hash-only
 * one does not survive, and that nothing is written on a model built past a
 * failed or suppressed step, or for a face with no name.
 */

const user = toUserId('user_hash_only_upgrade');

function boxDocument(): { document: ProjectDocument; boxId: BodyId } {
  const document = addPrimitiveFeature(
    createProjectDocument('Hash-only upgrade', user),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 20, depth: 12 }
    }
  );
  return { document, boxId: document.bodyOrder.at(-1)! };
}

function faceAlong(
  body: BodyRepresentation | undefined,
  axis: 'x' | 'y' | 'z'
) {
  const face = body?.topology?.faces.find(
    (candidate) => (candidate.geometry?.normal?.[axis] ?? 0) > 0.9
  );
  if (!face) throw new Error(`No +${axis} face.`);
  return face;
}

/** The box resized in every direction, so every face's hash changes. */
function resized(document: ProjectDocument): ProjectDocument {
  const box = listFeaturesInOrder(document).find((f) => f.name === 'Box')!;
  return updateFeature(document, {
    featureId: box.featureId,
    data: { dimensions: { width: 34, height: 23, depth: 14 } }
  });
}

function featureNamed(document: ProjectDocument, name: string) {
  return listFeaturesInOrder(document).find((f) => f.name === name)!;
}

type Kind = 'hole' | 'thicken' | 'shell' | 'draft' | 'fillet';

/** Adds one hash-only pick of `kind` on the box, as stored by an older pick. */
function withHashOnlyPick(
  document: ProjectDocument,
  boxId: BodyId,
  body: BodyRepresentation,
  kind: Kind
): { document: ProjectDocument; bodyId: BodyId } {
  const top = faceAlong(body, 'z');
  const side = faceAlong(body, 'x');
  expect(top.reference?.lineageName).toBeTruthy();
  expect(side.reference?.lineageName).toBeTruthy();
  switch (kind) {
    case 'hole':
      return holeBody(document, {
        name: 'Pick',
        targetBodyId: boxId,
        faceHash: top.hash,
        style: 'simple',
        diameter: 4,
        depthMode: 'through',
        position: { u: 0, v: 0 },
        positionAnchor: 'centroid'
      });
    case 'thicken':
      return thickenFace(document, {
        name: 'Pick',
        targetBodyId: boxId,
        faceHash: top.hash,
        thickness: 2
      });
    case 'shell':
      return shellBody(document, {
        name: 'Pick',
        targetBodyId: boxId,
        openingFaceHashes: [top.hash],
        thickness: 1.5
      });
    case 'draft':
      return draftBody(document, {
        name: 'Pick',
        targetBodyId: boxId,
        faceHashes: [side.hash],
        pullDirection: { x: 0, y: 0, z: 1 },
        neutralPoint: { x: 0, y: 0, z: 0 },
        angleDeg: 3
      });
    case 'fillet': {
      const edge = body.topology!.edges.find(
        (candidate) =>
          candidate.displayRole !== 'seam' && candidate.reference?.lineageName
      )!;
      return filletEdges(document, {
        name: 'Pick',
        targetBodyId: boxId,
        edgeHashes: [edge.hash],
        size: 1
      });
    }
  }
}

describe('hash-only picks are upgraded to lineage references', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter?.dispose());

  async function hashOnly(kind: Kind) {
    const { document: base, boxId } = boxDocument();
    const built = await adapter.syncDocument(base);
    const picked = withHashOnlyPick(
      base,
      boxId,
      built.bodyRepresentations[boxId]!,
      kind
    );
    return { ...picked, boxId };
  }

  it.each(['hole', 'thicken', 'shell', 'draft', 'fillet'] as const)(
    'writes the name of a %s pick and then follows an upstream resize',
    async (kind) => {
      const { document, bodyId } = await hashOnly(kind);
      const pick = featureNamed(document, 'Pick');
      const stored = hashOnlySelections(pick.data);
      expect(stored).toHaveLength(1);
      expect(fragileSelectionSteps(document)).toEqual([
        { featureId: pick.featureId, featureName: 'Pick', count: 1 }
      ]);

      // The hash-only pick does not survive the resize: this is the defect.
      const unrepaired = await adapter.syncDocument(resized(document));
      expect(unrepaired.warnings.join('\n')).toMatch(/Pick/);

      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const command = topologyReferenceRepairCommand(document, derived);
      expect(command).not.toBeNull();
      const manager = new CommandManager(document);
      const undoable = manager.canUndo;
      const repaired = manager.normalize(command!);
      // A normalization: no undo step of its own, and the geometry and the
      // stored hash are unchanged — only the proven name is added.
      expect(manager.canUndo).toBe(undoable);
      const upgraded = featureNamed(repaired, 'Pick');
      expect(hashOnlySelections(upgraded.data)).toEqual([]);
      expect(fragileSelectionSteps(repaired)).toEqual([]);
      const references = storedReferences(upgraded.data);
      expect(references.map((reference) => reference.currentHash)).toEqual(
        stored
      );
      for (const reference of references)
        expect(reference.lineageName).toBeTruthy();

      const settled = await adapter.syncDocument(repaired);
      expect(settled.warnings).toEqual([]);
      expect(settled.faceReferenceRepairs).toBeUndefined();
      expect(settled.referenceRepairs).toBeUndefined();
      expect(settled.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        derived.bodyRepresentations[bodyId]!.volume,
        6
      );
      expect(topologyReferenceRepairCommand(repaired, settled)).toBeNull();

      const after = await adapter.syncDocument(resized(repaired));
      expect(after.warnings).toEqual([]);
      expect(after.bodyRepresentations[bodyId]).toBeTruthy();
    },
    120_000
  );

  it('writes nothing for a face that has no name', async () => {
    // A thicken result publishes hash-only lineage: no face of it is named.
    const { document: base, boxId } = boxDocument();
    const box = (await adapter.syncDocument(base)).bodyRepresentations[boxId]!;
    const thickened = thickenFace(base, {
      name: 'Slab',
      targetBodyId: boxId,
      faceHash: faceAlong(box, 'z').hash,
      faceReference: faceAlong(box, 'z').reference!,
      thickness: 2
    });
    const slab = (await adapter.syncDocument(thickened.document))
      .bodyRepresentations[thickened.bodyId]!;
    const slabTop = faceAlong(slab, 'z');
    expect(slabTop.reference?.lineageName).toBeUndefined();
    const drafted = draftBody(thickened.document, {
      name: 'Pick',
      targetBodyId: thickened.bodyId,
      faceHashes: [faceAlong(slab, 'x').hash],
      pullDirection: { x: 0, y: 0, z: 1 },
      neutralPoint: { x: 0, y: 0, z: 0 },
      angleDeg: 3
    });
    const derived = await adapter.syncDocument(drafted.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.faceReferenceRepairs).toBeUndefined();
    expect(
      topologyReferenceRepairCommand(drafted.document, derived)
    ).toBeNull();
    expect(
      fragileSelectionSteps(drafted.document).map((step) => step.featureName)
    ).toEqual(['Pick']);
  }, 120_000);

  /** A box, a fillet on it, and a hash-only hole on the fillet's result. */
  async function holeAfterFillet(radius: number) {
    const { document: base, boxId } = boxDocument();
    const box = (await adapter.syncDocument(base)).bodyRepresentations[boxId]!;
    const edge = box.topology!.edges.find(
      (candidate) => candidate.displayRole !== 'seam' && candidate.reference
    )!;
    const filleted = filletEdges(base, {
      name: 'Round',
      targetBodyId: boxId,
      edgeHashes: [edge.hash],
      edgeReferences: [edge.reference!],
      size: radius
    });
    const drilled = holeBody(filleted.document, {
      name: 'Pick',
      targetBodyId: filleted.bodyId,
      faceHash: faceAlong(box, 'z').hash,
      style: 'simple',
      diameter: 2,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid'
    });
    return { document: drilled.document, holeBodyId: drilled.bodyId };
  }

  it('writes nothing past a failed step', async () => {
    // A radius no 12 mm box edge can take fails, and passes the box through.
    const { document } = await holeAfterFillet(40);
    const derived = await adapter.syncDocument(document);
    expect(
      derived.featureWarnings?.find((w) => w.featureName === 'Round')?.kind
    ).toBe('build-failed');
    expect(derived.featureWarnings?.some((w) => w.featureName === 'Pick')).toBe(
      false
    );
    expect(derived.faceReferenceRepairs).toBeUndefined();
    expect(topologyReferenceRepairCommand(document, derived)).toBeNull();
  }, 120_000);

  it('writes nothing past a suppressed step', async () => {
    const built = await holeAfterFillet(1);
    // The hole builds on the box the suppressed round passes through, on its
    // named top face, so the build proves a name it must not persist.
    const manager = new CommandManager(built.document);
    const round = featureNamed(manager.document, 'Round');
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: round.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      })
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(
      derived.featureWarnings?.find((w) => w.featureName === 'Round')?.kind
    ).toBe('suppressed');
    expect(derived.featureWarnings?.some((w) => w.featureName === 'Pick')).toBe(
      false
    );
    expect(derived.faceReferenceRepairs).toBeUndefined();
    expect(
      topologyReferenceRepairCommand(manager.document, derived)
    ).toBeNull();
  }, 120_000);
});

describe('a face-distance edit upgrades both of its faces in one write', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter?.dispose());

  it('stores the face and its opposite face together', async () => {
    // An imported box: the kernel publishes proven opposing face pairs, and
    // every imported face carries its `import.step.face.*` name.
    const source = new CommandManager(createProjectDocument('Source', user));
    source.execute(
      commandFactories.addPrimitive({
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 20, depth: 8 }
      })
    );
    const stepText = await adapter.exportStep(source.document, [
      source.document.bodyOrder.at(-1)!
    ]);
    const manager = new CommandManager(createProjectDocument('Block', user));
    manager.execute(
      commandFactories.importStep({
        name: 'Block',
        artifactId: 'artifact_hash_only_upgrade',
        sourceName: 'synthetic-box.step',
        stepText
      })
    );
    const bodyId = manager.document.bodyOrder.at(-1)!;
    const imported = await adapter.syncDocument(manager.document);
    const pair = imported.bodyRepresentations[
      bodyId
    ]!.topology!.opposingPlanarFacePairs!.find(
      (candidate) => Math.abs(candidate.normal.x) > 1 - 1e-6
    )!;
    manager.execute(
      commandFactories.directEditBody({
        name: 'Pick',
        targetBodyId: bodyId,
        operation: {
          kind: 'set-face-distance',
          faceHash: pair.faceAHash,
          oppositeFaceHash: pair.faceBHash,
          sourceDistance: pair.distance,
          moveMode: pair.moveMode,
          distance: pair.distance + 4
        }
      })
    );
    const pick = featureNamed(manager.document, 'Pick');
    expect(hashOnlySelections(pick.data).sort()).toEqual(
      [pair.faceAHash, pair.faceBHash].sort()
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    expect(
      (derived.faceReferenceRepairs ?? []).map(
        (repair) => repair.role ?? 'face'
      )
    ).toEqual(expect.arrayContaining(['face', 'opposite']));
    const command = topologyReferenceRepairCommand(manager.document, derived);
    expect(command).not.toBeNull();
    const repaired = manager.normalize(command!);
    const upgraded = featureNamed(repaired, 'Pick').data;
    if (
      upgraded.featureKind !== 'direct-edit' ||
      upgraded.operation.kind !== 'set-face-distance'
    )
      throw new Error('Expected the face-distance edit.');
    expect(upgraded.operation.faceReference?.currentHash).toBe(pair.faceAHash);
    expect(upgraded.operation.oppositeFaceReference?.currentHash).toBe(
      pair.faceBHash
    );
    const settled = await adapter.syncDocument(repaired);
    expect(settled.warnings).toEqual([]);
    expect(settled.faceReferenceRepairs).toBeUndefined();
  }, 120_000);
});

function storedReferences(data: FeatureData) {
  switch (data.featureKind) {
    case 'hole':
    case 'thicken':
      return data.faceReference ? [data.faceReference] : [];
    case 'shell':
      return data.openingFaceReferences ?? [];
    case 'draft':
      return data.faceReferences ?? [];
    case 'fillet':
      return data.edgeReferences ?? [];
    default:
      return [];
  }
}
