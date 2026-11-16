import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  chamferEdges,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type {
  BodyRepresentation,
  EdgeTopology,
  FaceTopology,
  ProjectDocument,
  TopologySelection
} from '@openzcad/shared';
import { selectionFeature } from '../apps/web/src/lib/selectionFeature';
import {
  batchFeatureDeletion,
  detailCascade,
  nativeFeatureDeletion,
  orphanFaceDeletion
} from '../apps/web/src/lib/featureDeletion';
import { nativeDetail } from './fixtures/native-detail';

/**
 * A chamfered hole rim, then a fillet rolled along the chamfer's edge, that
 * fillet resized away and the hole resized: the history a user builds while
 * tuning a part. The chamfer band must stay the Chamfer's through every one
 * of those steps, so picking it and pressing Delete removes the chamfer, and
 * the steps built on its geometry are offered for removal with it.
 */
describe('a chamfer picked under later edits', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  const live = (derived: ProjectDocument['derived']): BodyRepresentation => {
    const bodies = Object.values(derived.bodyRepresentations).filter(
      (body) => !body.consumed
    );
    expect(bodies).toHaveLength(1);
    return bodies[0]!;
  };
  const pick = (
    body: BodyRepresentation,
    entry: FaceTopology | EdgeTopology,
    kind: 'face' | 'edge'
  ): TopologySelection => ({
    bodyId: body.bodyId,
    kind,
    topologyId: entry.topologyId,
    hash: entry.hash,
    ...(entry.reference ? { reference: entry.reference } : {})
  });
  const facesOf = (body: BodyRepresentation, surfaceType: string) =>
    body.topology!.faces.filter(
      (face) => face.geometry?.surfaceType === surfaceType
    );
  const edgeBetween = (
    body: BodyRepresentation,
    first: FaceTopology,
    second: FaceTopology
  ) => {
    const edges = body.topology!.edges.filter(
      (edge) =>
        edge.displayRole !== 'seam' &&
        edge.adjacentFaceHashes?.includes(first.hash) &&
        edge.adjacentFaceHashes.includes(second.hash)
    );
    expect(edges).toHaveLength(1);
    return edges[0]!;
  };
  const bore = (body: BodyRepresentation) => {
    const bores = facesOf(body, 'cylinder').filter(
      (face) => face.geometry?.featureType === 'through-hole'
    );
    expect(bores).toHaveLength(1);
    return bores[0]!;
  };

  async function chain() {
    const fixture = await nativeDetail(adapter, 'hole');
    const steps: { name: string; document: ProjectDocument }[] = [];
    let document = fixture.document;
    let derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    let body = live(derived);

    // The bore's rim on the face the hole was drilled from.
    const wall = bore(body);
    const top = facesOf(body, 'plane').find((face) =>
      body.topology!.edges.some(
        (edge) =>
          edge.adjacentFaceHashes?.includes(face.hash) &&
          edge.adjacentFaceHashes.includes(wall.hash) &&
          (face.geometry?.normal?.z ?? 0) > 0.9
      )
    )!;
    const rim = edgeBetween(body, top, wall);
    document = chamferEdges(document, {
      name: 'Chamfer',
      targetBodyId: body.bodyId,
      size: 1,
      edgeHashes: [rim.hash],
      ...(rim.reference ? { edgeReferences: [rim.reference] } : {})
    }).document;
    derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    steps.push({ name: 'Chamfer', document: { ...document, derived } });
    body = live(derived);

    // A fillet rolled along the edge between the chamfer band and the bore.
    const [band] = facesOf(body, 'cone');
    const seam = edgeBetween(body, band!, bore(body));
    document = filletEdges(document, {
      name: 'Fillet 2',
      targetBodyId: body.bodyId,
      size: 0.5,
      edgeHashes: [seam.hash],
      ...(seam.reference ? { edgeReferences: [seam.reference] } : {})
    }).document;
    derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    steps.push({ name: 'Fillet 2', document: { ...document, derived } });
    body = live(derived);

    // That fillet resized to nothing, as Remove Blend does.
    const [round] = facesOf(body, 'torus');
    const removal = orphanFaceDeletion(
      { ...document, derived },
      pick(body, round!, 'face')
    );
    let manager = new CommandManager(document);
    manager.execute(removal.command);
    document = manager.document;
    derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    steps.push({ name: 'Remove fillet', document: { ...document, derived } });
    body = live(derived);
    expect(facesOf(body, 'torus')).toHaveLength(0);

    // The hole resized: the chamfer cone is kept, its rings move.
    const wider = bore(body);
    manager = new CommandManager(document);
    manager.execute(
      commandFactories.directEditBody({
        name: 'Resize Through Hole',
        targetBodyId: body.bodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: wider.hash,
          ...(wider.reference ? { faceReference: wider.reference } : {}),
          sourceDiameter: wider.geometry!.diameter!,
          sourceAxisStart: wider.geometry!.axisStart!,
          sourceAxisEnd: wider.geometry!.axisEnd!,
          diameter: 6.4
        }
      })
    );
    document = manager.document;
    derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    steps.push({ name: 'Resize', document: { ...document, derived } });
    return { fixture, steps, document: { ...document, derived } };
  }

  it('keeps the chamfer band owned by its Chamfer through each later step', async () => {
    const { steps, document } = await chain();
    const chamfer = listFeaturesInOrder(document).find(
      (feature) => feature.data.featureKind === 'chamfer'
    )!;
    for (const step of steps) {
      const body = live(step.document.derived);
      const cones = facesOf(body, 'cone');
      expect(cones, step.name).toHaveLength(1);
      expect(cones[0]!.reference?.producingFeatureId, step.name).toBe(
        chamfer.featureId
      );
      expect(
        selectionFeature(step.document, body, pick(body, cones[0]!, 'face'))
          ?.featureId,
        step.name
      ).toBe(chamfer.featureId);
    }
  }, 120_000);

  it('offers the fillet and its removal with the chamfer, then rebuilds without them', async () => {
    const { fixture, document } = await chain();
    const ordered = listFeaturesInOrder(document);
    const chamfer = ordered.find(
      (feature) => feature.data.featureKind === 'chamfer'
    )!;

    // Alone, the chamfer is refused: the fillet rolled along its edge.
    const alone = nativeFeatureDeletion(document, chamfer);
    const manager = new CommandManager(document);
    manager.execute(alone.command);
    const refusedDerived = await adapter.syncDocument(manager.document);
    let refusal: unknown = null;
    try {
      alone.validateDerived(refusedDerived);
    } catch (error) {
      refusal = error;
    }
    const cascade = detailCascade(refusal);
    expect(cascade?.map((feature) => feature.name)).toEqual([
      'Fillet 2',
      'Remove fillet'
    ]);

    // With them, every other step rebuilds and the band is gone.
    const batch = batchFeatureDeletion(document, [
      chamfer.featureId,
      ...cascade!.map((feature) => feature.featureId)
    ]);
    const together = new CommandManager(document);
    for (const command of batch.commands) together.execute(command);
    const after = await adapter.syncDocument(together.document);
    expect(after.warnings).toEqual([]);
    batch.validateDerived?.(after);
    const body = live(after);
    expect(facesOf(body, 'cone')).toHaveLength(0);
    expect(facesOf(body, 'torus')).toHaveLength(0);
    expect(
      listFeaturesInOrder(together.document).map((feature) => feature.name)
    ).toEqual(
      listFeaturesInOrder(fixture.document)
        .map((feature) => feature.name)
        .concat('Resize Through Hole')
    );

    // The same block with only the hole resized: the chamfer never happened.
    const plain = await adapter.syncDocument(fixture.document);
    const plainBody = live(plain);
    const plainBore = bore(plainBody);
    const resized = new CommandManager(fixture.document);
    resized.execute(
      commandFactories.directEditBody({
        name: 'Resize Through Hole',
        targetBodyId: plainBody.bodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: plainBore.hash,
          ...(plainBore.reference
            ? { faceReference: plainBore.reference }
            : {}),
          sourceDiameter: plainBore.geometry!.diameter!,
          sourceAxisStart: plainBore.geometry!.axisStart!,
          sourceAxisEnd: plainBore.geometry!.axisEnd!,
          diameter: 6.4
        }
      })
    );
    const expected = live(await adapter.syncDocument(resized.document));
    expect(body.volume).toBeCloseTo(expected.volume, 6);
    expect(body.faceCount).toBe(expected.faceCount);
  }, 120_000);
});
