import { describe, expect, it, vi } from 'vitest';
import {
  addDatumPlane,
  addPrimitiveFeature,
  addSketchFeature,
  addSplitFeature,
  extrudeSketch,
  chamferEdges,
  createProjectDocument,
  directEditBody,
  filletEdges,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  sweepProfile,
  transformBody
} from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type SketchId
} from '@openzcad/shared';
import {
  affectedFeatureTargets,
  planReorder,
  reorderFeatureTargets,
  reorderRefusal
} from './affectedFeatureTargets';

describe('affected feature targets', () => {
  it('walks only the downstream body ancestry of the edited primitive', () => {
    const cylinder = addPrimitiveFeature(
      createProjectDocument('Affected branch', toUserId('user_affected')),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 4.6, height: 12 }
      }
    );
    const cylinderBodyId = cylinder.bodyOrder[0]!;
    const box = addPrimitiveFeature(cylinder, {
      name: 'Independent box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const boxBodyId = box.bodyOrder[1]!;
    const fillet = filletEdges(box, {
      name: 'Cylinder rim fillet',
      targetBodyId: cylinderBodyId,
      edgeHashes: [101],
      size: 1
    });
    const chamfer = chamferEdges(fillet.document, {
      name: 'Independent box chamfer',
      targetBodyId: boxBodyId,
      edgeHashes: [202],
      size: 1
    });
    const moved = transformBody(chamfer.document, {
      name: 'Move filleted cylinder',
      targetBodyId: fillet.bodyId,
      translation: { x: 5, y: 0, z: 0 }
    }).document;
    const sourceFeature = listFeaturesInOrder(moved)[0]!;

    const targets = affectedFeatureTargets(moved, sourceFeature.featureId);
    expect(
      targets.map(({ featureName, resultBodyId }) => ({
        featureName,
        resultBodyId
      }))
    ).toEqual([
      { featureName: 'Cylinder', resultBodyId: cylinderBodyId },
      { featureName: 'Cylinder rim fillet', resultBodyId: fillet.bodyId },
      { featureName: 'Move filleted cylinder', resultBodyId: fillet.bodyId }
    ]);
    // Each target identifies its feature, which is what lets a refusal naming
    // one offer to open it.
    expect(targets[0]?.featureId).toBe(sourceFeature.featureId);
    expect(
      targets.every((target) => typeof target.featureId === 'string')
    ).toBe(true);
  });

  it('walks datum consumers and tolerates a later datum (R01)', () => {
    const block = addPrimitiveFeature(
      createProjectDocument('Datum branch', toUserId('user_affected')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const blockId = block.bodyOrder[0]!;
    const first = addDatumPlane(block, {
      name: 'Lid plane',
      definition: {
        kind: 'offset',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        offset: 10
      }
    });
    const chained = addDatumPlane(first.document, {
      name: 'Upper plane',
      definition: {
        kind: 'offset',
        source: { type: 'datum', datumFeatureId: first.featureId },
        offset: 2
      }
    });
    const sketched = addSketchFeature(chained.document, {
      name: 'Lid sketch',
      planeRef: { type: 'datum', datumFeatureId: chained.featureId },
      objects: [{ objectKind: 'circle', radius: 2, centerX: 0, centerY: 0 }]
    });
    const padded = extrudeSketch(sketched.document, {
      name: 'Lid pad',
      sketchId: sketched.sketchId,
      distance: 3
    });
    const split = addSplitFeature(padded.document, {
      name: 'Halve',
      targetBodyId: blockId,
      plane: { type: 'datum', datumFeatureId: first.featureId }
    });
    const doc = split.document;

    // Editing the datum reaches everything resolved through it, transitively.
    expect(
      affectedFeatureTargets(doc, first.featureId).map((t) => t.featureName)
    ).toEqual(['Lid pad', 'Halve', 'Halve']);
    // An edit upstream of a datum walks past it instead of throwing.
    const blockFeature = listFeaturesInOrder(doc)[0]!;
    expect(
      affectedFeatureTargets(doc, blockFeature.featureId).map(
        (t) => t.featureName
      )
    ).toEqual(['Block', 'Halve', 'Halve']);
  });

  it('resolves an in-place direct edit as its own source body', () => {
    const box = addPrimitiveFeature(
      createProjectDocument('Direct-edit source', toUserId('user_affected')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 10, depth: 24 }
      }
    );
    const bodyId = box.bodyOrder[0]!;
    const edited = directEditBody(box, {
      name: 'Raise top',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: 1234,
        sourceSurfaceType: 'plane',
        sourceArea: 400,
        sourceCenter: { x: 0, y: 0, z: 0 },
        sourceNormal: { x: 0, y: 0, z: 1 },
        offset: 5
      }
    }).document;
    const downstream = filletEdges(edited, {
      name: 'Soften',
      targetBodyId: bodyId,
      edgeHashes: [7],
      size: 1
    });
    const directEdit = listFeaturesInOrder(downstream.document).find(
      (feature) => feature.name === 'Raise top'
    )!;

    // Direct edits carry no result body on the node; the body they rewrite is
    // the source, and everything downstream of it is affected.
    expect(
      affectedFeatureTargets(downstream.document, directEdit.featureId)
    ).toMatchObject([
      { featureName: 'Raise top', resultBodyId: bodyId },
      { featureName: 'Soften', resultBodyId: downstream.bodyId }
    ]);
  });

  it('counts a sweep as affected by an edit to its guide rail sketch', () => {
    // A guide rail is a sketch the sweep's geometry depends on exactly as its
    // path is. Leaving it out of this walk means the pre-save downstream
    // guard never derives the sweep, and a rail edit that the adapter will
    // later refuse is saved unguarded.
    const start = createProjectDocument('Guided', toUserId('user_guided'));
    const document: ProjectDocument = addSketchFeature(start, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 4,
        height: 2,
        centerX: 0,
        centerY: 0
      }
    }).document;
    const profileSketchId = document.sketchOrder[0]!;
    const path = addSketchFeature(document, {
      name: 'Path',
      plane: 'XZ',
      offset: 0,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    });
    const rail = addSketchFeature(path.document, {
      name: 'Rail',
      plane: 'XZ',
      offset: 10,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    });
    const pathReference = (sketchId: SketchId) => ({
      sketchId,
      entityIds: findSketch(rail.document, sketchId)!.objectIds
    });
    const swept = sweepProfile(rail.document, {
      name: 'Guided sweep',
      profile: {
        sketchId: profileSketchId,
        profile: {
          profileId: 'profile_1',
          regionFingerprint: 1,
          samplePoint: { x: 0, y: 0 },
          sourceArea: 8,
          sourceEntityIds: findSketch(rail.document, profileSketchId)!.objectIds
        }
      },
      path: pathReference(path.sketchId),
      mode: 'standard',
      guide: pathReference(rail.sketchId)
    });
    const railFeature = listFeaturesInOrder(swept.document).find(
      (feature) => feature.name === 'Rail'
    )!;

    expect(
      affectedFeatureTargets(swept.document, railFeature.featureId)
    ).toMatchObject([
      { featureName: 'Guided sweep', resultBodyId: swept.bodyId }
    ]);
  });

  it('includes a downstream hole and everything past it', () => {
    const plate = addPrimitiveFeature(
      createProjectDocument('Hole branch', toUserId('user_hole')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 10, depth: 24 }
      }
    );
    const plateBodyId = plate.bodyOrder[0]!;
    const hole = holeBody(plate, {
      name: 'Mounting hole',
      targetBodyId: plateBodyId,
      faceHash: 4242,
      style: 'simple',
      diameter: 6,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    });
    const softened = filletEdges(hole.document, {
      name: 'Soften hole rim',
      targetBodyId: hole.bodyId,
      edgeHashes: [303],
      size: 1
    });
    const sourceFeature = listFeaturesInOrder(softened.document)[0]!;

    const targets = affectedFeatureTargets(
      softened.document,
      sourceFeature.featureId
    );
    expect(
      targets.map(({ featureName, resultBodyId }) => ({
        featureName,
        resultBodyId
      }))
    ).toEqual([
      { featureName: 'Plate', resultBodyId: plateBodyId },
      { featureName: 'Mounting hole', resultBodyId: hole.bodyId },
      { featureName: 'Soften hole rim', resultBodyId: softened.bodyId }
    ]);
  });

  it('targets the moved span and its downstream, in the new order', () => {
    const first = addPrimitiveFeature(
      createProjectDocument('Reorder span', toUserId('user_affected')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 4 }
      }
    );
    const plateBodyId = first.bodyOrder[0]!;
    const moved = transformBody(first, {
      name: 'Lift plate',
      targetBodyId: plateBodyId,
      translation: { x: 0, y: 0, z: 5 }
    }).document;
    const second = addPrimitiveFeature(moved, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 8, height: 8, depth: 8 }
    });
    const blockBodyId = second.bodyOrder[1]!;
    const filleted = filletEdges(second, {
      name: 'Block fillet',
      targetBodyId: blockBodyId,
      edgeHashes: [11],
      size: 1
    });
    const document = filleted.document;
    const id = (name: string) =>
      listFeaturesInOrder(document).find((feature) => feature.name === name)!
        .featureId;
    const names = (
      targets: ReturnType<typeof reorderFeatureTargets>
    ): string[] => targets.map((target) => target.featureName);

    // Lift plate (1) moves below Block (2): the plate before the span replays
    // unchanged, the fillet only depends on Block, and the refusal must name
    // whatever runs first in the new order.
    expect(names(reorderFeatureTargets(document, id('Lift plate'), 2))).toEqual(
      ['Block', 'Lift plate', 'Block fillet']
    );
    // Moving Block to the top drags the whole plate branch into the span.
    expect(names(reorderFeatureTargets(document, id('Block'), 0))).toEqual([
      'Block',
      'Plate',
      'Lift plate',
      'Block fillet'
    ]);
    expect(
      reorderFeatureTargets(document, id('Block'), 0).at(-1)?.resultBodyId
    ).toBe(filleted.bodyId);
    // A no-op or out-of-range move rebuilds nothing.
    expect(reorderFeatureTargets(document, id('Block'), 2)).toEqual([]);
    expect(reorderFeatureTargets(document, id('Block'), 9)).toEqual([]);
  });

  it('refuses only failures the reorder introduces', () => {
    const block = addPrimitiveFeature(
      createProjectDocument('Reorder sketch', toUserId('user_affected')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 8, height: 8, depth: 8 }
      }
    );
    const sketched = addSketchFeature(block, {
      name: 'Top sketch',
      plane: 'XY',
      offset: 8,
      object: {
        objectKind: 'rectangle',
        width: 2,
        height: 2,
        centerX: 0,
        centerY: 0
      }
    }).document;
    const [blockFeature, sketch] = listFeaturesInOrder(sketched);
    const failed = {
      featureId: sketch!.featureId,
      featureName: 'Top sketch',
      message: 'Feature "Top sketch": The attachment face no longer exists.',
      kind: 'build-failed' as const
    };
    const blockBodyId = sketched.bodyOrder[0]!;
    const derived = (
      featureWarnings: (typeof failed)[],
      blockBuilt = true
    ): ProjectDocument['derived'] => ({
      ...sketched.derived,
      bodyRepresentations: blockBuilt
        ? ({
            [blockBodyId]: {}
          } as unknown as ProjectDocument['derived']['bodyRepresentations'])
        : {},
      warnings: featureWarnings.map((warning) => warning.message),
      featureWarnings
    });

    const refusal = reorderRefusal(
      sketched,
      derived([failed]),
      sketch!.featureId,
      0
    );
    expect(refusal).toMatchObject({
      featureId: sketch!.featureId,
      featureName: 'Top sketch',
      message: 'The attachment face no longer exists.'
    });
    // A clean rebuild, or a failure the current model already has, is not
    // this reorder's doing.
    expect(
      reorderRefusal(sketched, derived([]), sketch!.featureId, 0)
    ).toBeNull();
    const alreadyFailing = { ...sketched, derived: derived([failed]) };
    expect(
      reorderRefusal(
        alreadyFailing,
        derived([failed]),
        blockFeature!.featureId,
        1
      )
    ).toBeNull();
    // The same holds for a body feature: a Block that already fails does not
    // block the move, but one the move breaks is refused by name.
    const blockFailed = {
      featureId: blockFeature!.featureId,
      featureName: 'Block',
      message: 'Feature "Block": Box dimensions must be positive.',
      kind: 'build-failed' as const
    };
    const brokenBlock = {
      ...sketched,
      derived: derived([blockFailed], false)
    };
    expect(
      reorderRefusal(
        brokenBlock,
        derived([blockFailed], false),
        sketch!.featureId,
        0
      )
    ).toBeNull();
    expect(
      reorderRefusal(sketched, derived([], false), sketch!.featureId, 0)
    ).toMatchObject({
      featureName: 'Block',
      message: 'The operation did not produce its result body.'
    });
  });

  it('judges prior failures by identity, not a shared name', () => {
    const first = addPrimitiveFeature(
      createProjectDocument('Namesakes', toUserId('user_affected')),
      {
        name: 'Twin',
        primitiveKind: 'box',
        dimensions: { width: 8, height: 8, depth: 8 }
      }
    );
    const document = addPrimitiveFeature(first, {
      name: 'Twin',
      primitiveKind: 'box',
      dimensions: { width: 4, height: 4, depth: 4 }
    });
    const [failing, healthy] = listFeaturesInOrder(document);
    const warning = (feature: typeof failing) => ({
      featureId: feature!.featureId,
      featureName: 'Twin',
      message: 'Feature "Twin": Box dimensions must be positive.',
      kind: 'build-failed' as const
    });
    const bodies = Object.fromEntries(
      document.bodyOrder.map((bodyId) => [bodyId, {}])
    ) as unknown as ProjectDocument['derived']['bodyRepresentations'];
    const before = {
      ...document,
      derived: {
        ...document.derived,
        bodyRepresentations: bodies,
        warnings: [warning(failing).message]
      }
    };
    const candidate: ProjectDocument['derived'] = {
      ...before.derived,
      warnings: [warning(failing).message, warning(healthy).message],
      featureWarnings: [warning(failing), warning(healthy)]
    };

    // The saved model's warning names "Twin" without saying which one. With
    // the session's attribution, only the first is a prior failure; without
    // it, neither namesake can be assumed to have failed.
    for (const prior of [[warning(failing)], undefined])
      expect(
        reorderRefusal(before, candidate, healthy!.featureId, 0, prior)
      ).toMatchObject({ featureId: healthy!.featureId });
    expect(
      reorderRefusal(
        before,
        { ...candidate, featureWarnings: [warning(failing)] },
        healthy!.featureId,
        0,
        [warning(failing)]
      )
    ).toBeNull();
  });

  it('does not take an unattributed advisory for a prior failure', () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Advisory', toUserId('user_affected')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 8, height: 8, depth: 2 }
      }
    );
    const sketched = addSketchFeature(document, {
      name: 'Mark',
      plane: 'XY',
      offset: 2,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 }
    }).document;
    const [plate, mark] = listFeaturesInOrder(sketched);
    const bodyRepresentations = {
      [sketched.bodyOrder[0]!]: {}
    } as unknown as ProjectDocument['derived']['bodyRepresentations'];
    const failure = {
      featureId: plate!.featureId,
      featureName: 'Plate',
      message: 'Feature "Plate": Box dimensions must be positive.',
      kind: 'build-failed' as const
    };
    const candidate: ProjectDocument['derived'] = {
      ...sketched.derived,
      bodyRepresentations,
      warnings: [failure.message],
      featureWarnings: [failure]
    };
    const reopened = (warning: string) => ({
      ...sketched,
      derived: { ...candidate, featureWarnings: undefined, warnings: [warning] }
    });

    // A saved advisory under the same prefix is not the failure the
    // candidate reports, so the move is still refused.
    expect(
      reorderRefusal(
        reopened('Feature "Plate": Curves came back faceted.'),
        candidate,
        mark!.featureId,
        0
      )
    ).toMatchObject({ featureId: plate!.featureId });
    // The identical failure is one the model already had.
    expect(
      reorderRefusal(reopened(failure.message), candidate, mark!.featureId, 0)
    ).toBeNull();
  });

  describe('reorder routing', () => {
    const plate = addPrimitiveFeature(
      createProjectDocument('Reorder routing', toUserId('user_affected')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 4 }
      }
    );
    const document = addPrimitiveFeature(plate, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 8, height: 8, depth: 8 }
    });
    const block = listFeaturesInOrder(document)[1]!.featureId;
    const gates = (overrides: Partial<Parameters<typeof planReorder>[3]>) => ({
      orderGate: vi.fn(),
      canEdit: vi.fn(() => true),
      geometryReady: vi.fn(() => true),
      ...overrides
    });

    it('refuses a reorder without edit rights before anything rebuilds', () => {
      const checks = gates({ canEdit: vi.fn(() => false) });
      expect(planReorder(document, block, 0, checks)).toEqual({
        kind: 'blocked'
      });
      expect(checks.canEdit).toHaveBeenCalledTimes(1);
      // Neither the readiness check nor a rebuild is reached.
      expect(checks.geometryReady).not.toHaveBeenCalled();
    });

    it('waits for the current version rather than a stale projection', () => {
      const checks = gates({ geometryReady: vi.fn(() => false) });
      expect(planReorder(document, block, 0, checks)).toEqual({
        kind: 'pending'
      });
      expect(checks.geometryReady).toHaveBeenCalledWith(document);
    });

    it('validates a permitted reorder once the projection is current', () => {
      const plan = planReorder(document, block, 0, gates({}));
      expect(plan.kind).toBe('validate');
      expect(
        plan.kind === 'validate' &&
          plan.targets.map((target) => target.featureName)
      ).toEqual(['Block', 'Plate']);
    });

    it('leaves no-op and order-gate refusals to the command', () => {
      const refused = gates({
        orderGate: vi.fn(() => {
          throw new Error('Cannot reorder');
        })
      });
      expect(planReorder(document, block, 0, refused)).toEqual({
        kind: 'direct'
      });
      expect(refused.canEdit).not.toHaveBeenCalled();
      const noop = gates({});
      expect(planReorder(document, block, 1, noop)).toEqual({
        kind: 'direct'
      });
      expect(noop.orderGate).not.toHaveBeenCalled();
    });
  });
});
