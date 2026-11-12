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
  listFeaturesInOrder,
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
  type EdgeTopology,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  buildModelingOperationSubmission,
  modelingFaceOptions
} from '../apps/web/src/lib/modelingOperations';
import {
  builtOnFailedFeatures,
  failedFeatureIds
} from '../apps/web/src/lib/featureRepair';
import { failedHistoryExportBodies } from '../apps/web/src/lib/failedHistoryExport';
import { newExactWarnings } from '../apps/web/src/lib/exactWarnings';
import { editAffectedFeatureTargets } from '../apps/web/src/lib/affectedFeatureTargets';
import { validatedFeatureRejection } from '../apps/web/src/lib/featureValidation';

/**
 * ADR-017, November 2026 amendment. A fillet whose radius stopped fitting
 * used to leave no body under its result id, so every later feature on the
 * chain failed with "target is unavailable" — twenty failures for one bad
 * radius in the reported history — and the fillet's input stayed on screen,
 * where new work attached to it and forked the history. A failed feature
 * that replaces one input body now hands that input through exactly as a
 * manually suppressed one does. It still fails, and only it fails.
 */
describe('a failed feature passes its input body through', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter.dispose());

  const along = (edge: EdgeTopology, offset: number) =>
    edge.points.filter((_, index) => index % 3 === offset);

  /** Straight edges at y = `y`, z = `z` running along X. */
  function edgeAlongX(
    document: ProjectDocument,
    bodyId: BodyId,
    y: number,
    z: number
  ) {
    const edges = document.derived.bodyRepresentations[
      bodyId
    ]!.topology!.edges.filter((edge) => {
      const xs = along(edge, 0);
      return (
        along(edge, 1).every((value) => Math.abs(value - y) < 1e-6) &&
        along(edge, 2).every((value) => Math.abs(value - z) < 1e-6) &&
        Math.max(...xs) - Math.min(...xs) > 60
      );
    });
    expect(edges).toHaveLength(1);
    return edges[0]!;
  }

  const signature = (body: BodyRepresentation) => ({
    faces: body.topology!.faces.map((face) => face.hash).sort((a, b) => a - b),
    edges: body.topology!.edges.map((edge) => edge.hash).sort((a, b) => a - b),
    volume: Number(body.volume.toFixed(6))
  });

  async function synced(
    document: ProjectDocument,
    using: ExactKernelAdapter = adapter
  ) {
    const derived = await using.syncDocument(document);
    return {
      document: attachDerivedState(document, derived),
      derived,
      attributed: derived.featureWarnings ?? []
    };
  }

  const plateTop = (
    face: NonNullable<BodyRepresentation['topology']>['faces'][number]
  ) =>
    face.geometry?.normal?.z === 1 &&
    Math.abs((face.geometry.centroid ?? face.geometry.center).z - 5) < 1e-6;

  /**
   * An L bracket (plate ∪ flange) with a 3 mm fillet in the inside corner and
   * two through holes drilled on the filleted plate.
   */
  async function bracket() {
    const manager = new CommandManager(
      createProjectDocument('Bracket', toUserId('user_failed_pass'), 'mm')
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
    let { document } = await synced(manager.document);
    const corner = edgeAlongX(document, union.bodyId, 5, 5);
    const fillet = createBodyFeatureIds();
    run('Fillet', [
      commandFactories.filletEdges({
        name: 'Fillet',
        targetBodyId: union.bodyId,
        edgeHashes: [corner.hash],
        edgeReferences: [corner.reference!],
        size: 3,
        ids: fillet
      })
    ]);
    ({ document } = await synced(manager.document));
    expect(document.derived.warnings).toEqual([]);
    let last: BodyId = fillet.bodyId;
    for (const [index, v] of ['25', '-25'].entries()) {
      const body = document.derived.bodyRepresentations[last]!;
      const faces = body.topology!.faces.filter(plateTop);
      expect(faces).toHaveLength(1);
      const submission = buildModelingOperationSubmission(
        {
          operation: 'hole',
          value: {
            name: `Hole ${index + 1}`,
            targetBodyId: last,
            faceHash: faces[0]!.hash,
            style: 'simple',
            diameter: '6',
            depthMode: 'through',
            depth: '5',
            counterboreDiameter: '10',
            counterboreDepth: '2',
            countersinkDiameter: '10',
            countersinkAngleDeg: '90',
            position: { u: '-10', v }
          }
        },
        modelingFaceOptions(body.topology, body)
      );
      if (submission.operation !== 'hole') throw new Error('Not a hole.');
      manager.runTransaction(`Hole ${index + 1}`, [
        commandFactories.holeBody(submission.input)
      ]);
      last = listFeaturesInOrder(manager.document).at(-1)!.bodyId as BodyId;
      ({ document } = await synced(manager.document));
      expect(document.derived.warnings).toEqual([]);
    }
    return { manager, run, document, union, fillet, last };
  }

  /** The fillet at a radius the 35 mm inside faces cannot carry. */
  const oversized = (document: ProjectDocument, filletId: FeatureId) =>
    updateFeature(document, { featureId: filletId, data: { radius: 60 } });

  const failures = (
    attributed: ProjectDocument['derived']['featureWarnings']
  ) =>
    (attributed ?? [])
      .filter(
        (entry) => entry.kind === 'build-failed' || entry.kind === 'refusal'
      )
      .map((entry) => entry.featureName);

  it('fails only the fillet; the holes build on its unfilleted input', async () => {
    const { manager, union, fillet, last } = await bracket();
    const edited = oversized(manager.document, fillet.featureId);
    const { document, attributed } = await synced(edited);

    // Before the amendment: Fillet, "Hole 1: target is unavailable" and
    // "Hole 2: target is unavailable".
    expect(failures(attributed)).toEqual(['Fillet']);
    expect(document.derived.warnings).toHaveLength(1);
    expect(document.derived.warnings[0]).toMatch(/^Feature "Fillet": /);

    // The chain stands on the union as it was before the fillet: no blend,
    // both bores. 80×40×5 + 80×5×40 − the 80×5×5 overlap, less two Ø6 × 5.
    const tip = document.derived.bodyRepresentations[last]!;
    expect(
      tip.topology!.faces.filter(
        (face) => face.geometry?.featureType === 'blend'
      )
    ).toHaveLength(0);
    expect(
      tip.topology!.faces.filter(
        (face) => face.geometry?.featureType === 'through-hole'
      )
    ).toHaveLength(2);
    expect(tip.volume).toBeCloseTo(30_000 - 2 * Math.PI * 9 * 5, 3);

    // The fillet's input is consumed: one body is on screen, the tip of the
    // chain, so a new feature can only land there — never on the union.
    expect(document.derived.bodyRepresentations[union.bodyId]!.consumed).toBe(
      true
    );
    expect(document.derived.bodyRepresentations[fillet.bodyId]).toBeDefined();
    expect(
      Object.values(document.derived.bodyRepresentations)
        .filter((body) => !body.consumed)
        .map((body) => body.bodyId)
    ).toEqual([last]);

    // The UI flags the holes as built on the failed step, and withholds the
    // body on screen at the end of that branch from export.
    const failed = failedFeatureIds(attributed);
    expect(failed).toEqual(new Set([fillet.featureId]));
    const flagged = builtOnFailedFeatures(document, failed);
    expect(
      [...flagged].map(([id, origin]) => [
        listFeaturesInOrder(document).find((f) => f.featureId === id)!.name,
        origin.name
      ])
    ).toEqual([
      ['Hole 1', 'Fillet'],
      ['Hole 2', 'Fillet']
    ]);
    expect([...failedHistoryExportBodies(document, attributed).keys()]).toEqual(
      [last]
    );

    // The edit that broke the fillet is still refused by the commit gates:
    // its failure is new, and its body being present (passed through) does
    // not make the gate read it as built.
    const before = await synced(manager.document);
    const candidate = { ...document.derived, featureWarnings: attributed };
    const fresh = newExactWarnings(before.document, candidate);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatch(/^Feature "Fillet": /);
    const verdicts = editAffectedFeatureTargets(
      before.document,
      edited,
      fillet.featureId
    ).map((target) => [
      target.featureName,
      validatedFeatureRejection({
        featureName: target.featureName,
        featureId: target.featureId,
        warnings: candidate.warnings,
        featureWarnings: attributed,
        bodyPresent: Boolean(
          candidate.bodyRepresentations[target.resultBodyId]
        ),
        documentMoved: false
      }) !== null
    ]);
    expect(verdicts).toEqual([
      ['Fillet', true],
      ['Hole 1', false],
      ['Hole 2', false]
    ]);

    // Repairing the radius restores the filleted chain exactly.
    const filleted = signature(
      (await synced(manager.document)).document.derived.bodyRepresentations[
        last
      ]!
    );
    const repaired = await synced(
      updateFeature(edited, {
        featureId: fillet.featureId,
        data: { radius: 3 }
      })
    );
    expect(repaired.document.derived.warnings).toEqual([]);
    expect(
      signature(repaired.document.derived.bodyRepresentations[last]!)
    ).toEqual(filleted);
  }, 300_000);

  it('still refuses a feature on the face the failed fillet would have made', async () => {
    const { manager, fillet, last } = await bracket();
    let { document } = await synced(manager.document);
    const [band, ...others] = document.derived.bodyRepresentations[
      last
    ]!.topology!.faces.filter(
      (face) =>
        face.geometry?.surfaceType === 'cylinder' &&
        face.reference?.lineageName.startsWith('modifier.fillet.')
    );
    expect(others).toHaveLength(0);
    const slab = createBodyFeatureIds();
    manager.runTransaction('Thicken', [
      commandFactories.thickenFace({
        name: 'Thicken band',
        targetBodyId: last,
        faceHash: band!.hash,
        faceReference: band!.reference!,
        thickness: 1,
        ids: slab
      })
    ]);
    ({ document } = await synced(manager.document));
    expect(document.derived.warnings).toEqual([]);

    const broken = await synced(oversized(manager.document, fillet.featureId));
    // The holes have their body again; the blend the thicken was built on
    // does not exist on it, and nothing stands in for it: the refusal it
    // always gave for a missing face, not "target is unavailable".
    expect(failures(broken.attributed)).toEqual(['Fillet', 'Thicken band']);
    expect(
      broken.attributed.find((entry) => entry.featureName === 'Thicken band')
        ?.message
    ).toMatch(/^Feature "Thicken band": Thicken face is stale: /);
    expect(
      broken.document.derived.bodyRepresentations[slab.bodyId]
    ).toBeUndefined();
    // A failed step is red in History, not "built on a failed step".
    const names = new Map(
      listFeaturesInOrder(broken.document).map((feature) => [
        feature.featureId,
        feature.name
      ])
    );
    expect(
      [
        ...builtOnFailedFeatures(
          broken.document,
          failedFeatureIds(broken.attributed)
        ).keys()
      ].map((id) => names.get(id))
    ).toEqual(['Hole 1', 'Hole 2']);
  }, 300_000);

  it('writes no reference repair learned downstream of a failed step, cached or not', async () => {
    const { manager, fillet, last } = await bracket();
    const { document } = await synced(manager.document);
    // A legacy hash-only pick of the plate's outer bottom edge, which the
    // inside-corner fillet does not touch, so it resolves with or without it.
    const outer = edgeAlongX(document, last, 40, 5);
    const chamfer = createBodyFeatureIds();
    manager.runTransaction('Chamfer', [
      commandFactories.chamferEdges({
        name: 'Chamfer',
        targetBodyId: last,
        edgeHashes: [outer.hash],
        size: 1,
        ids: chamfer
      })
    ]);
    const repairsFor = (derived: ProjectDocument['derived']) =>
      (derived.referenceRepairs ?? []).map((repair) => repair.featureId);
    // With the fillet built the selection is repaired as usual, so the
    // assertions below are not vacuous.
    const built = await synced(manager.document);
    expect(built.document.derived.warnings).toEqual([]);
    expect(repairsFor(built.derived)).toContain(chamfer.featureId);

    const broken = oversized(manager.document, fillet.featureId);
    const first = await synced(broken);
    expect(failures(first.attributed)).toEqual(['Fillet']);
    expect(
      first.document.derived.bodyRepresentations[chamfer.bodyId]
    ).toBeDefined();
    expect(repairsFor(first.derived)).not.toContain(chamfer.featureId);

    // A later edit restores the prefix through the failed fillet from the
    // history cache; the restored attribution still draws the same line.
    const events: string[] = [];
    const cached = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event.kind)
    });
    try {
      await cached.syncDocument(broken);
      const resized = updateFeature(broken, {
        featureId: chamfer.featureId,
        data: { distance: 1.5 }
      });
      const restored = await synced(resized, cached);
      expect(events.at(-1)).toBe('prefix-restore');
      expect(failures(restored.attributed)).toEqual(['Fillet']);
      expect(repairsFor(restored.derived)).not.toContain(chamfer.featureId);
      const fresh = await synced(resized);
      expect(
        signature(
          restored.document.derived.bodyRepresentations[chamfer.bodyId]!
        )
      ).toEqual(
        signature(fresh.document.derived.bodyRepresentations[chamfer.bodyId]!)
      );
    } finally {
      cached.dispose();
    }
  }, 300_000);
});
