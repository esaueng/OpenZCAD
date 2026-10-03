import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import {
  attachDerivedState,
  createBodyFeatureIds,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type EdgeTopology,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  buildModelingOperationSubmission,
  modelingFaceOptions
} from '../apps/web/src/lib/modelingOperations';
import { buildDemoDocument, DEMO_DEFINITIONS } from '../apps/web/src/lib/demos';
import { topologyReferenceRepairCommand } from '../apps/web/src/lib/topologyReferenceRepairs';

/**
 * F1 follow-up from the 1 October 2026 design review: suppressing the fillet
 * of a bracket turned both holes drilled on it into "Hole target is
 * unavailable", because a suppressed feature produced no body at all. A
 * manually suppressed feature that replaces its one input body now hands that
 * input through under its own result id, so dependents keep building on the
 * body as it stood before the feature. Their face and edge references still
 * resolve only through verified lineage — pass-through supplies a body, never
 * a substitute face.
 */
describe('a suppressed feature passes its input body through', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter.dispose());

  /** The last sync's attribution, which `attachDerivedState` strips. */
  let attributed: ProjectDocument['derived']['featureWarnings'] = [];

  async function synced(document: ProjectDocument) {
    const derived = await adapter.syncDocument(document);
    attributed = derived.featureWarnings;
    return attachDerivedState(document, derived);
  }

  const along = (edge: EdgeTopology, offset: number) =>
    edge.points.filter((_, index) => index % 3 === offset);

  /** Straight edges at y = 5, z = 5 running along X: the inside corner. */
  function insideCorner(document: ProjectDocument, bodyId: BodyId) {
    const edges = document.derived.bodyRepresentations[
      bodyId
    ]!.topology!.edges.filter((edge) => {
      const xs = along(edge, 0);
      return (
        along(edge, 1).every((y) => Math.abs(y - 5) < 1e-6) &&
        along(edge, 2).every((z) => Math.abs(z - 5) < 1e-6) &&
        Math.max(...xs) - Math.min(...xs) > 60
      );
    });
    expect(edges).toHaveLength(1);
    return edges[0]!;
  }

  /** Geometry identity that does not depend on display-mesh vertex order. */
  const signature = (body: BodyRepresentation) => ({
    faces: body.topology!.faces.map((face) => face.hash).sort((a, b) => a - b),
    edges: body.topology!.edges.map((edge) => edge.hash).sort((a, b) => a - b),
    volume: Number(body.volume.toFixed(6))
  });

  const featureWarnings = () =>
    (attributed ?? []).map((entry) => ({
      featureName: entry.featureName,
      kind: entry.kind
    }));

  function suppress(
    manager: CommandManager,
    featureId: FeatureId,
    suppressed: boolean
  ) {
    const feature = listFeaturesInOrder(manager.document).find(
      (candidate) => candidate.featureId === featureId
    )!;
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: feature.id,
        metadata: {
          [FEATURE_SUPPRESSED_METADATA_KEY]: suppressed ? true : null
        }
      })
    );
  }

  /** The review's bracket: two boxes, a union, and a modifier on the corner. */
  async function bracket(modifier: 'fillet' | 'chamfer' | null) {
    const manager = new CommandManager(
      createProjectDocument('Bracket', toUserId('user_suppress_pass'), 'mm')
    );
    const run = (label: string, commands: AnyCommand[]) =>
      manager.runTransaction(label, commands);
    const plate = createBodyFeatureIds();
    const flange = createBodyFeatureIds();
    const union = createBodyFeatureIds();
    run('Bracket', [
      commandFactories.addPrimitive({
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 80, height: 40, depth: 5 },
        ids: plate
      }),
      commandFactories.addPrimitive({
        name: 'Flange',
        primitiveKind: 'box',
        dimensions: { width: 80, height: 5, depth: 40 },
        ids: flange
      }),
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: [plate.bodyId, flange.bodyId],
        ids: union
      })
    ]);
    let document = await synced(manager.document);
    let target: BodyId = union.bodyId;
    let modifierIds: ReturnType<typeof createBodyFeatureIds> | null = null;
    if (modifier) {
      const corner = insideCorner(document, union.bodyId);
      modifierIds = createBodyFeatureIds();
      const input = {
        name: modifier === 'fillet' ? 'Fillet' : 'Chamfer',
        targetBodyId: union.bodyId,
        edgeHashes: [corner.hash],
        edgeReferences: [corner.reference!],
        size: modifier === 'fillet' ? 3 : 4,
        ids: modifierIds
      };
      run(input.name, [
        modifier === 'fillet'
          ? commandFactories.filletEdges(input)
          : commandFactories.chamferEdges(input)
      ]);
      document = await synced(manager.document);
      expect(document.derived.warnings).toEqual([]);
      target = modifierIds.bodyId;
    }
    return { manager, run, document, union, modifierIds, target };
  }

  /** Drills a simple through hole on the face `pick` chooses. */
  async function drill(
    manager: CommandManager,
    target: BodyId,
    name: string,
    pick: (
      face: NonNullable<BodyRepresentation['topology']>['faces'][number]
    ) => boolean,
    position: { u: string; v: string },
    diameter = '6',
    depthMode: 'blind' | 'through' = 'through',
    depth = '5'
  ) {
    const document = await synced(manager.document);
    const body = document.derived.bodyRepresentations[target]!;
    const faces = body.topology!.faces.filter(pick);
    expect(faces).toHaveLength(1);
    const submission = buildModelingOperationSubmission(
      {
        operation: 'hole',
        value: {
          name,
          targetBodyId: target,
          faceHash: faces[0]!.hash,
          style: 'simple',
          diameter,
          depthMode,
          depth,
          counterboreDiameter: '10',
          counterboreDepth: '2',
          countersinkDiameter: '10',
          countersinkAngleDeg: '90',
          position
        }
      },
      modelingFaceOptions(body.topology, body)
    );
    if (submission.operation !== 'hole') throw new Error('Not a hole.');
    manager.runTransaction(name, [commandFactories.holeBody(submission.input)]);
    return listFeaturesInOrder(manager.document).at(-1)!.bodyId as BodyId;
  }

  const plateTop = (
    face: NonNullable<BodyRepresentation['topology']>['faces'][number]
  ) =>
    face.geometry?.normal?.z === 1 &&
    Math.abs((face.geometry.centroid ?? face.geometry.center).z - 5) < 1e-6;

  async function drillBothHoles(manager: CommandManager, target: BodyId) {
    let body = target;
    for (const [index, v] of ['25', '-25'].entries()) {
      body = await drill(manager, body, `Hole ${index + 1}`, plateTop, {
        u: '-10',
        v
      });
    }
    return body;
  }

  it('builds the holes on the unfilleted union while the fillet is suppressed, and restores the fillet exactly', async () => {
    const { manager, modifierIds, target } = await bracket('fillet');
    const last = await drillBothHoles(manager, target);
    let document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    const filleted = signature(document.derived.bodyRepresentations[last]!);

    suppress(manager, modifierIds!.featureId, true);
    document = await synced(manager.document);
    // The only warning is the suppression itself: neither hole is refused.
    expect(featureWarnings()).toEqual([
      { featureName: 'Fillet', kind: 'suppressed' }
    ]);
    const plain = document.derived.bodyRepresentations[last]!;
    expect(
      plain.topology!.faces.filter(
        (face) => face.geometry?.featureType === 'blend'
      )
    ).toHaveLength(0);
    expect(
      plain.topology!.faces.filter(
        (face) => face.geometry?.featureType === 'through-hole'
      )
    ).toHaveLength(2);
    // 80×40×5 + 80×5×40 − the 80×5×5 overlap, less two Ø6 × 5 bores.
    expect(plain.volume).toBeCloseTo(30_000 - 2 * Math.PI * 9 * 5, 3);
    // Exactly one body is on screen: the chain's result, not the union too.
    expect(
      Object.values(document.derived.bodyRepresentations)
        .filter((body) => !body.consumed)
        .map((body) => body.bodyId)
    ).toEqual([last]);

    // The same two holes drilled straight on an unfilleted union: the
    // suppressed chain is exactly that model, not an approximation of it.
    const reference = await bracket(null);
    const referenceLast = await drillBothHoles(
      reference.manager,
      reference.target
    );
    const referenceDocument = await synced(reference.manager.document);
    expect(referenceDocument.derived.warnings).toEqual([]);
    expect(signature(plain)).toEqual(
      signature(referenceDocument.derived.bodyRepresentations[referenceLast]!)
    );

    suppress(manager, modifierIds!.featureId, false);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    expect(signature(document.derived.bodyRepresentations[last]!)).toEqual(
      filleted
    );

    // Undo of the resume is the suppression again, and redo the fillet.
    manager.undo();
    document = await synced(manager.document);
    expect(signature(document.derived.bodyRepresentations[last]!)).toEqual(
      signature(plain)
    );
    manager.redo();
    document = await synced(manager.document);
    expect(signature(document.derived.bodyRepresentations[last]!)).toEqual(
      filleted
    );
  }, 300_000);

  it('still refuses a feature built on the face the suppressed fillet made', async () => {
    const { manager, modifierIds, target } = await bracket('fillet');
    let document = await synced(manager.document);
    const [band, ...others] = document.derived.bodyRepresentations[
      target
    ]!.topology!.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(others).toHaveLength(0);
    // A verified name the fillet itself gave its blend: the reference a
    // pass-through must not satisfy with some face of the union.
    expect(band!.reference?.lineageName).toMatch(
      /^modifier\.fillet\.face\.band-between\./
    );
    const slab = createBodyFeatureIds();
    manager.runTransaction('Thicken', [
      commandFactories.thickenFace({
        name: 'Thicken band',
        targetBodyId: target,
        faceHash: band!.hash,
        faceReference: band!.reference!,
        thickness: 1,
        ids: slab
      })
    ]);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    const thick = signature(document.derived.bodyRepresentations[slab.bodyId]!);

    suppress(manager, modifierIds!.featureId, true);
    document = await synced(manager.document);
    // The thicken has its body again — the union — but the blend it was
    // built on does not exist there, and nothing stands in for it.
    const refusal = attributed?.find(
      (entry) => entry.featureName === 'Thicken band'
    );
    expect(refusal?.kind).toBe('build-failed');
    expect(refusal?.message).toMatch(
      /^Feature "Thicken band": Thicken face is stale: /
    );
    expect(document.derived.bodyRepresentations[slab.bodyId]).toBeUndefined();

    suppress(manager, modifierIds!.featureId, false);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    expect(
      signature(document.derived.bodyRepresentations[slab.bodyId]!)
    ).toEqual(thick);
  }, 300_000);

  it('still refuses a hole drilled on a face the suppressed chamfer made', async () => {
    const { manager, modifierIds, target } = await bracket('chamfer');
    const bevel = (
      face: NonNullable<BodyRepresentation['topology']>['faces'][number]
    ) => {
      const normal = face.geometry?.normal;
      return (
        face.geometry?.surfaceType === 'plane' &&
        normal !== undefined &&
        Math.abs(Math.abs(normal.y) - Math.SQRT1_2) < 1e-6 &&
        Math.abs(Math.abs(normal.z) - Math.SQRT1_2) < 1e-6
      );
    };
    const onBevel = await drill(
      manager,
      target,
      'Bevel hole',
      bevel,
      { u: '0', v: '0' },
      '2',
      'blind',
      '1'
    );
    let document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    const beveled = signature(document.derived.bodyRepresentations[onBevel]!);

    suppress(manager, modifierIds!.featureId, true);
    document = await synced(manager.document);
    // The bevel carries no lineage name, so the hole holds it by its exact
    // geometric fingerprint, and no face of the union has that fingerprint.
    const refusal = attributed?.find(
      (entry) => entry.featureName === 'Bevel hole'
    );
    expect(refusal?.kind).toBe('build-failed');
    expect(refusal?.message).toBe(
      'Feature "Bevel hole": A selected face no longer exists. Re-select the face(s) and re-create this feature.'
    );
    expect(document.derived.bodyRepresentations[onBevel]).toBeUndefined();

    suppress(manager, modifierIds!.featureId, false);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    expect(signature(document.derived.bodyRepresentations[onBevel]!)).toEqual(
      beveled
    );
  }, 300_000);

  it('passes a suppressed subtract through to its target and leaves the tool on screen', async () => {
    const manager = new CommandManager(
      createProjectDocument('Subtract', toUserId('user_suppress_bool'), 'mm')
    );
    const block = createBodyFeatureIds();
    const tool = createBodyFeatureIds();
    const cut = createBodyFeatureIds();
    manager.runTransaction('Parts', [
      commandFactories.addPrimitive({
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 },
        ids: block
      }),
      commandFactories.addPrimitive({
        name: 'Tool',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 5, depth: 30 },
        ids: tool
      }),
      commandFactories.booleanBodies({
        name: 'Cut',
        operation: 'subtract',
        targetBodyIds: [block.bodyId, tool.bodyId],
        ids: cut
      }),
      commandFactories.transformBody({
        name: 'Lift',
        targetBodyId: cut.bodyId,
        translation: { x: 0, y: 0, z: 50 }
      })
    ]);
    let document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    const lifted = signature(document.derived.bodyRepresentations[cut.bodyId]!);

    suppress(manager, cut.featureId, true);
    document = await synced(manager.document);
    expect(featureWarnings()).toEqual([
      { featureName: 'Cut', kind: 'suppressed' }
    ]);
    const passed = document.derived.bodyRepresentations[cut.bodyId]!;
    // The lift moved the uncut block: 20 × 20 × 10, raised by 50.
    expect(passed.volume).toBeCloseTo(4000, 6);
    expect(passed.bbox.min.z).toBeCloseTo(50, 6);
    expect(passed.bbox.max.z).toBeCloseTo(60, 6);
    // The block itself is spent on the pass-through; the tool is not, so it
    // is back on screen exactly where it was, as it was before the cut.
    const live = Object.values(document.derived.bodyRepresentations)
      .filter((body) => !body.consumed)
      .map((body) => body.bodyId)
      .sort();
    expect(live).toEqual([cut.bodyId, tool.bodyId].sort());
    expect(
      document.derived.bodyRepresentations[tool.bodyId]!.volume
    ).toBeCloseTo(750, 6);

    suppress(manager, cut.featureId, false);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    expect(
      signature(document.derived.bodyRepresentations[cut.bodyId]!)
    ).toEqual(lifted);
  }, 300_000);

  it('passes a two-block pattern through a suppressed union as it is', async () => {
    // The first operand is two separate blocks — a pattern — which the union
    // bridges. Suppressed, the union passes the pattern through unbridged,
    // and that is a skipped step, not a refused union result: the union
    // checks are not run on a body the union never made.
    const manager = new CommandManager(
      createProjectDocument('Union', toUserId('user_suppress_union'), 'mm')
    );
    const block = createBodyFeatureIds();
    const row = createBodyFeatureIds();
    const bar = createBodyFeatureIds();
    const union = createBodyFeatureIds();
    manager.runTransaction('Parts', [
      commandFactories.addPrimitive({
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 },
        ids: block
      }),
      commandFactories.patternBody({
        name: 'Row',
        targetBodyId: block.bodyId,
        patternKind: 'linear',
        count: 2,
        axis: 'x',
        spacing: 20,
        ids: row
      }),
      commandFactories.addPrimitive({
        name: 'Bar',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 10, depth: 2 },
        ids: bar
      }),
      commandFactories.booleanBodies({
        name: 'Bridge',
        operation: 'union',
        targetBodyIds: [row.bodyId, bar.bodyId],
        ids: union
      })
    ]);
    let document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);

    suppress(manager, union.featureId, true);
    document = await synced(manager.document);
    expect(featureWarnings()).toEqual([
      { featureName: 'Bridge', kind: 'suppressed' }
    ]);
    const passed = document.derived.bodyRepresentations[union.bodyId]!;
    expect(passed.volume).toBeCloseTo(2000, 6);
    expect(document.derived.bodyRepresentations[bar.bodyId]!.consumed).toBe(
      false
    );
  }, 300_000);

  it('keeps a suppressed mirror copy unavailable: it replaces nothing it could pass on', async () => {
    const manager = new CommandManager(
      createProjectDocument('Mirror', toUserId('user_suppress_mirror'), 'mm')
    );
    const block = createBodyFeatureIds();
    const mirror = createBodyFeatureIds();
    manager.runTransaction('Parts', [
      commandFactories.addPrimitive({
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 },
        ids: block
      }),
      commandFactories.mirrorBody({
        name: 'Mirror',
        targetBodyId: block.bodyId,
        plane: { origin: { x: -5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
        ids: mirror
      }),
      commandFactories.transformBody({
        name: 'Lift copy',
        targetBodyId: mirror.bodyId,
        translation: { x: 0, y: 0, z: 50 }
      })
    ]);
    let document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);

    suppress(manager, mirror.featureId, true);
    document = await synced(manager.document);
    expect(featureWarnings()).toEqual([
      { featureName: 'Mirror', kind: 'suppressed' },
      { featureName: 'Lift copy', kind: 'build-failed' }
    ]);
    // Standing the original in for its own copy would put the block on
    // screen twice; the copy's dependents refuse instead, as before.
    expect(document.derived.bodyRepresentations[mirror.bodyId]).toBeUndefined();
    expect(document.derived.bodyRepresentations[block.bodyId]!.consumed).toBe(
      false
    );
  }, 300_000);

  it('writes no reference repair learned while a step is suppressed', async () => {
    // The flange's rim chamfer is a legacy hash-only selection. With the bolt
    // circle drill suppressed it resolves on the undrilled blank, whose
    // lineage names the rim edges — and persisting those names (the app
    // writes every repair the build offers) left the chamfer stale the moment
    // the drill was resumed.
    const definition = DEMO_DEFINITIONS.find(
      (candidate) => candidate.key === 'flange'
    )!;
    const manager = new CommandManager(
      await buildDemoDocument(
        definition,
        toUserId('user_suppress_repair'),
        (candidate) => adapter.syncDocument(candidate)
      )
    );
    const featureNamed = (name: string) =>
      listFeaturesInOrder(manager.document).find(
        (feature) => feature.name === name
      )!;
    const chamfer = featureNamed('Rim chamfer');
    expect(
      chamfer.data.featureKind === 'chamfer' && chamfer.data.edgeReferences
    ).toBeFalsy();
    let document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    const chamfered = signature(
      document.derived.bodyRepresentations[chamfer.bodyId!]!
    );

    suppress(manager, featureNamed('Drill bolt circle').featureId, true);
    const derived = await adapter.syncDocument(manager.document);
    expect(
      (derived.featureWarnings ?? []).filter(
        (entry) => entry.kind !== 'suppressed'
      )
    ).toEqual([]);
    expect(derived.bodyRepresentations[chamfer.bodyId!]).toBeDefined();
    expect(
      (derived.referenceRepairs ?? []).map((repair) => repair.featureId)
    ).not.toContain(chamfer.featureId);
    const repair = topologyReferenceRepairCommand(manager.document, derived);
    if (repair) manager.execute(repair);

    suppress(manager, featureNamed('Drill bolt circle').featureId, false);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    expect(
      signature(document.derived.bodyRepresentations[chamfer.bodyId!]!)
    ).toEqual(chamfered);
  }, 300_000);

  it('does not pass bodies through a rollback: the model reads as of the marker', async () => {
    const { manager, union, modifierIds, target } = await bracket('fillet');
    const last = await drillBothHoles(manager, target);
    const features = listFeaturesInOrder(manager.document);
    const marker = features.findIndex(
      (feature) => feature.featureId === union.featureId
    );
    manager.runTransaction(
      'Roll back after Union',
      features.slice(marker + 1).map((feature) =>
        commandFactories.setNodeMetadata({
          nodeId: feature.id,
          metadata: { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: true }
        })
      )
    );
    const document = await synced(manager.document);
    // Every dependent is paused too, so passing bodies through would change
    // nothing but which id the on-screen union carries.
    const live = Object.values(document.derived.bodyRepresentations)
      .filter((body) => !body.consumed)
      .map((body) => body.bodyId);
    expect(live).toEqual([union.bodyId]);
    expect(
      document.derived.bodyRepresentations[modifierIds!.bodyId]
    ).toBeUndefined();
    expect(document.derived.bodyRepresentations[last]).toBeUndefined();
  }, 300_000);
});
