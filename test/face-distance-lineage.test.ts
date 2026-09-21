import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  decodeRemusMoveFacesJournal,
  deriveRemusMoveFacesDirectEditLineage,
  type RemusLineageState,
  type RemusTopologyCandidate
} from '../packages/kernel-adapter/src/remus-lineage';
import { topologyHashOfWitness } from '../packages/kernel-adapter/src/topology-lineage';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DirectEditOperation,
  type FaceTopologyReferenceV5,
  type FaceWitnessV1,
  type FeatureId,
  type OpposingPlanarFacePair,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Face-distance dimension edits must not orphan downstream face references.
 *
 * A face-distance move re-limits the neighbours of the faces it moves, so the
 * moved faces' exact witnesses change. Carrying identities only when witnesses
 * survive unchanged (the old direct-edit lineage) dropped every one of them:
 * on an imported 46-face body a width edit silently shed 20 face references,
 * and the next depth edit then failed its downstream blends as stale. The
 * journaled move records which result face each source face became, and the
 * derivation re-verifies each claim against the measured solids — so chained
 * dimension edits, symmetric moves, undo/redo and save/reload all keep their
 * references, while ambiguous or missing references still refuse instead of
 * landing on a neighbouring face.
 */

const user = toUserId('user_face_distance_lineage');

async function importedBox(
  adapter: ExactKernelAdapter
): Promise<{ manager: CommandManager; bodyId: BodyId }> {
  // A synthetic imported body, so the kernel publishes proven opposing-pair
  // proofs exactly as it does for a real STEP import — without one.
  const source = new CommandManager(createProjectDocument('Box source', user));
  source.execute(
    commandFactories.addPrimitive({
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 20, depth: 8 }
    })
  );
  const sourceBodyId = source.document.bodyOrder.at(-1)!;
  const stepText = await adapter.exportStep(source.document, [sourceBodyId]);
  const manager = new CommandManager(createProjectDocument('Block', user));
  manager.execute(
    commandFactories.importStep({
      name: 'Block',
      artifactId: 'artifact_face_distance_box',
      sourceName: 'synthetic-box.step',
      stepText
    })
  );
  const bodyId = manager.document.bodyOrder.at(-1)!;
  return { manager, bodyId };
}

function pairsOf(body: BodyRepresentation | undefined): OpposingPlanarFacePair[] {
  return [...(body?.topology?.opposingPlanarFacePairs ?? [])];
}

function pairAlongAxis(
  pairs: OpposingPlanarFacePair[],
  axis: 'x' | 'y' | 'z'
): OpposingPlanarFacePair {
  const match = pairs.find(
    (pair) => Math.abs(pair.normal[axis]) > 1 - 1e-6
  );
  if (!match) {
    throw new Error(`Expected an opposing pair along ${axis}.`);
  }
  return match;
}

function distanceOperation(
  pair: OpposingPlanarFacePair,
  distance: number | string,
  moveMode?: OpposingPlanarFacePair['moveMode']
): Extract<DirectEditOperation, { kind: 'set-face-distance' }> {
  return {
    kind: 'set-face-distance',
    faceHash: pair.faceAHash,
    faceReference: pair.faceAReference,
    oppositeFaceHash: pair.faceBHash,
    oppositeFaceReference: pair.faceBReference,
    sourceDistance: pair.distance,
    moveMode: moveMode ?? pair.moveMode,
    distance,
    // A binding may start at the recorded distance; only a gesture that lands
    // on the current distance is a no-op worth refusing.
    ...(typeof distance === 'string' ? { parameterBinding: true as const } : {})
  };
}

function referenceNames(body: BodyRepresentation | undefined): string[] {
  return (body?.topology?.faces ?? [])
    .map((face) => face.reference?.lineageName)
    .filter((name): name is string => typeof name === 'string')
    .sort();
}

describe('face-distance dimension-edit lineage', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  async function synced(document: ProjectDocument) {
    return adapter.syncDocument(document);
  }

  it('carries every face reference through a one-sided move', async () => {
    const { manager, bodyId } = await importedBox(adapter);
    const baseline = await synced(manager.document);
    expect(baseline.warnings).toEqual([]);
    const before = referenceNames(baseline.bodyRepresentations[bodyId]);
    expect(before).toHaveLength(6);

    const pair = pairAlongAxis(pairsOf(baseline.bodyRepresentations[bodyId]), 'x');
    manager.execute(
      commandFactories.directEditBody({
        name: 'Set width',
        targetBodyId: bodyId,
        operation: distanceOperation(pair, 44)
      })
    );
    const after = await synced(manager.document);
    expect(after.warnings).toEqual([]);
    const body = after.bodyRepresentations[bodyId]!;
    expect(body.topology?.faces).toHaveLength(6);
    // Edges re-trimmed by the move stay hash-only at body level; no face
    // lost its name.
    for (const diagnostic of body.topology?.lineageDiagnostics ?? []) {
      expect(diagnostic.kind).toBe('body');
    }
    // Every pre-move identity is still published under its stable name.
    expect(referenceNames(body)).toEqual(before);
    expect(body.volume).toBeCloseTo(44 * 20 * 8, 6);
  });

  it('chains consecutive moves through full replay when an upstream distance changes', async () => {
    const { manager, bodyId } = await importedBox(adapter);
    manager.execute(commandFactories.setParameter({ name: 'width', expression: '40' }));
    manager.execute(commandFactories.setParameter({ name: 'depth', expression: '20' }));
    let derived = await synced(manager.document);
    const widthPair = pairAlongAxis(pairsOf(derived.bodyRepresentations[bodyId]), 'x');
    manager.execute(
      commandFactories.directEditBody({
        name: 'Set width',
        targetBodyId: bodyId,
        operation: distanceOperation(widthPair, 'width')
      })
    );
    derived = await synced(manager.document);
    expect(derived.warnings).toEqual([]);
    const depthPair = pairAlongAxis(pairsOf(derived.bodyRepresentations[bodyId]), 'y');
    manager.execute(
      commandFactories.directEditBody({
        name: 'Set depth',
        targetBodyId: bodyId,
        operation: distanceOperation(depthPair, 'depth')
      })
    );
    derived = await synced(manager.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(40 * 20 * 8, 6);

    // Move the downstream parameter first: the depth edit resolves by lineage.
    manager.execute(commandFactories.setParameter({ name: 'depth', expression: '22' }));
    derived = await synced(manager.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(40 * 22 * 8, 6);

    // Then move the upstream one: full replay keeps the downstream edit live.
    manager.execute(commandFactories.setParameter({ name: 'width', expression: '46' }));
    derived = await synced(manager.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId]!;
    expect(body.volume).toBeCloseTo(46 * 22 * 8, 6);
    expect(body.topology?.faces).toHaveLength(6);
    expect(referenceNames(body)).toHaveLength(6);
  });

  it('carries references through a symmetric move and keeps its centre', async () => {
    const { manager, bodyId } = await importedBox(adapter);
    const baseline = await synced(manager.document);
    const before = referenceNames(baseline.bodyRepresentations[bodyId]);
    const bboxBefore = baseline.bodyRepresentations[bodyId]!.bbox;
    const centreBefore = (bboxBefore.min.x + bboxBefore.max.x) / 2;

    const pair = pairAlongAxis(pairsOf(baseline.bodyRepresentations[bodyId]), 'x');
    manager.execute(
      commandFactories.directEditBody({
        name: 'Set width symmetric',
        targetBodyId: bodyId,
        operation: distanceOperation(pair, 48, 'symmetric')
      })
    );
    const after = await synced(manager.document);
    expect(after.warnings).toEqual([]);
    const body = after.bodyRepresentations[bodyId]!;
    expect(body.volume).toBeCloseTo(48 * 20 * 8, 6);
    const bbox = body.bbox;
    expect((bbox.min.x + bbox.max.x) / 2).toBeCloseTo(centreBefore, 6);
    expect(referenceNames(body)).toEqual(before);

    // A downstream edit still resolves after the two-leg symmetric move.
    const depthPair = pairAlongAxis(pairsOf(body), 'y');
    manager.execute(
      commandFactories.directEditBody({
        name: 'Set depth',
        targetBodyId: bodyId,
        operation: distanceOperation(depthPair, 24)
      })
    );
    const chained = await synced(manager.document);
    expect(chained.warnings).toEqual([]);
    expect(chained.bodyRepresentations[bodyId]!.volume).toBeCloseTo(48 * 24 * 8, 6);
  });

  it('preserves references through undo, redo and save/reload', async () => {
    const { manager, bodyId } = await importedBox(adapter);
    manager.execute(commandFactories.setParameter({ name: 'width', expression: '40' }));
    let derived = await synced(manager.document);
    const widthPair = pairAlongAxis(pairsOf(derived.bodyRepresentations[bodyId]), 'x');
    manager.execute(
      commandFactories.directEditBody({
        name: 'Set width',
        targetBodyId: bodyId,
        operation: distanceOperation(widthPair, 'width')
      })
    );
    manager.execute(commandFactories.setParameter({ name: 'width', expression: '44' }));
    derived = await synced(manager.document);
    expect(derived.warnings).toEqual([]);
    const committed = derived.bodyRepresentations[bodyId]!;
    expect(committed.volume).toBeCloseTo(44 * 20 * 8, 6);
    expect(referenceNames(committed)).toHaveLength(6);

    const undone = await synced(manager.undo());
    expect(undone.bodyRepresentations[bodyId]!.volume).toBeCloseTo(40 * 20 * 8, 6);
    expect(referenceNames(undone.bodyRepresentations[bodyId])).toHaveLength(6);

    const redone = await synced(manager.redo());
    expect(redone.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      committed.volume,
      9
    );
    expect(referenceNames(redone.bodyRepresentations[bodyId])).toEqual(
      referenceNames(committed)
    );
    expect(redone.warnings).toEqual([]);

    const reloaded = JSON.parse(JSON.stringify(manager.document)) as ProjectDocument;
    const replayed = await synced(reloaded);
    expect(replayed.warnings).toEqual([]);
    expect(replayed.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      committed.volume,
      9
    );
    expect(referenceNames(replayed.bodyRepresentations[bodyId])).toEqual(
      referenceNames(committed)
    );
  });

  it('refuses a tampered downstream lineage instead of guessing a neighbour', async () => {
    const { manager, bodyId } = await importedBox(adapter);
    let derived = await synced(manager.document);
    const widthPair = pairAlongAxis(pairsOf(derived.bodyRepresentations[bodyId]), 'x');
    manager.execute(
      commandFactories.directEditBody({
        name: 'Set width',
        targetBodyId: bodyId,
        operation: distanceOperation(widthPair, 44)
      })
    );
    derived = await synced(manager.document);
    expect(derived.warnings).toEqual([]);

    const depthPair = pairAlongAxis(pairsOf(derived.bodyRepresentations[bodyId]), 'y');
    const tampered = distanceOperation(depthPair, 24);
    tampered.faceReference = {
      ...depthPair.faceAReference,
      lineageName: `${depthPair.faceAReference.lineageName}.stale`
    };
    manager.execute(
      commandFactories.directEditBody({
        name: 'Set depth',
        targetBodyId: bodyId,
        operation: tampered
      })
    );
    const refused = await synced(manager.document);
    // The width edit stands; the tampered depth edit fails closed.
    expect(refused.warnings).toHaveLength(1);
    expect(refused.warnings[0]).toMatch(/stale/i);
    expect(refused.bodyRepresentations[bodyId]!.volume).toBeCloseTo(44 * 20 * 8, 6);
  });
});

function planeWitness(offset: number, centroidZ: number): FaceWitnessV1 {
  return {
    surfaceType: 'plane',
    perimeter: 160,
    centroid: [20000000, 10000000, centroidZ],
    analytic: {
      kind: 'plane',
      normal: [0, 0, 1000000000],
      offset
    },
    closure: { u: 'open', v: 'open' }
  };
}

function faceReferenceFor(
  lineageName: string,
  witness: FaceWitnessV1,
  producingFeatureId: FeatureId
): FaceTopologyReferenceV5 {
  return {
    kind: 'face',
    producingFeatureId,
    lineageName,
    currentHash: topologyHashOfWitness('face', witness),
    witnessVersion: 1,
    witness
  };
}

function candidate(handle: number, witness: FaceWitnessV1): RemusTopologyCandidate {
  return { handle, kind: 'face', witness };
}

describe('move-faces lineage derivation', () => {
  const feature = 'feature_move' as FeatureId;
  const movedSource = planeWitness(0, 0);
  const stillSource = planeWitness(20000000, 10000000);
  const movedResult = planeWitness(4000000, 0);
  const stillResult = planeWitness(20000000, 10000000);

  function sourceState(): RemusLineageState {
    return {
      faceReferences: new Map([
        [3, faceReferenceFor('body.face.moved', movedSource, feature)],
        [5, faceReferenceFor('body.face.still', stillSource, feature)]
      ]),
      edgeReferences: new Map(),
      diagnostics: []
    };
  }

  const sourceCandidates = [candidate(3, movedSource), candidate(5, stillSource)];
  const resultCandidates = [candidate(7, movedResult), candidate(9, stillResult)];

  it('carries a journal-mapped face with a refreshed witness', () => {
    const lineage = deriveRemusMoveFacesDirectEditLineage({
      source: sourceState(),
      sourceCandidates,
      resultCandidates,
      relation: { faceMap: new Map([[3, 7]]), conflictedSources: new Set() }
    })!;
    // The moved face rides the journal; the untouched face rides the witness.
    expect(lineage.faceReferences.get(7)?.lineageName).toBe('body.face.moved');
    expect(lineage.faceReferences.get(7)?.witness).toEqual(movedResult);
    expect(lineage.faceReferences.get(7)?.currentHash).toBe(
      topologyHashOfWitness('face', movedResult)
    );
    expect(lineage.faceReferences.get(9)?.lineageName).toBe('body.face.still');
    expect(lineage.diagnostics).toEqual([]);
  });

  it('leaves a conflicted source hash-only without touching the fallback', () => {
    const lineage = deriveRemusMoveFacesDirectEditLineage({
      source: sourceState(),
      sourceCandidates,
      resultCandidates,
      relation: {
        faceMap: new Map([
          [3, 7],
          [5, 7]
        ]),
        conflictedSources: new Set([3, 5])
      }
    })!;
    expect(lineage.faceReferences.size).toBe(0);
    expect(
      lineage.diagnostics.some((diagnostic) => diagnostic.code === 'hash-only')
    ).toBe(true);
  });

  it('publishes neither name when the journal and the witnesses disagree', () => {
    // The journal claims source 3 became result 9, but result 9 measures
    // exactly as source 5's witness: a refusal, not an overwrite.
    const lineage = deriveRemusMoveFacesDirectEditLineage({
      source: sourceState(),
      sourceCandidates,
      resultCandidates,
      relation: { faceMap: new Map([[3, 9]]), conflictedSources: new Set() }
    })!;
    expect(lineage.faceReferences.has(9)).toBe(false);
    expect(lineage.faceReferences.has(7)).toBe(false);
  });

  it('does not carry a source whose stored reference is already stale', () => {
    const stale = sourceState();
    const tampered = faceReferenceFor('body.face.moved', movedSource, feature);
    stale.faceReferences.set(3, { ...tampered, currentHash: tampered.currentHash + 1 });
    const lineage = deriveRemusMoveFacesDirectEditLineage({
      source: stale,
      sourceCandidates,
      resultCandidates,
      relation: { faceMap: new Map([[3, 7]]), conflictedSources: new Set() }
    })!;
    expect(lineage.faceReferences.has(7)).toBe(false);
    // The untouched face still rides the witness.
    expect(lineage.faceReferences.get(9)?.lineageName).toBe('body.face.still');
  });
});

describe('move-faces journal decoding', () => {
  it('accepts a well-formed solid/op record', () => {
    expect(decodeRemusMoveFacesJournal('{"solid":12,"op":4}')).toEqual({
      solid: 12,
      op: 4
    });
  });

  it.each(['null', '[]', '{"solid":-1,"op":0}', '{"solid":1}', 'not json', '42'])(
    'rejects %s',
    (payload) => {
      expect(() => decodeRemusMoveFacesJournal(payload)).toThrow(
        /move-faces journal rejected/
      );
    }
  );
});
