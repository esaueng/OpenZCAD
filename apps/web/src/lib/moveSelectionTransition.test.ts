import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  findBodyNode,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  toBodyId,
  toUserId,
  type ProjectDocument,
  type SketchId,
  type SketchPlaneRef
} from '@openzcad/shared';
import type { RegionPickData } from '@openzcad/viewport';
import {
  currentMoveSelectionDocument,
  movePickNeedsFreshTopology,
  moveSketchPickVisibility,
  resolveMoveSketchRegion,
  type MoveSelectionPick,
  type MoveSelectionRequest
} from './moveSelectionTransition';

function pendingPick(box = false) {
  const manager = new CommandManager(
    createProjectDocument('Move pick', toUserId('user_move_pick'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 18, depth: 24 }
    })
  );
  const bodyId = manager.document.bodyOrder[0]!;
  const request: MoveSelectionRequest = {
    manager,
    projectId: manager.document.projectId,
    version: manager.document.version,
    ...(box
      ? ({ kind: 'box', bodyIds: [bodyId] } as const)
      : ({
          kind: 'viewport',
          selection: { bodyId, kind: 'body' },
          additive: false
        } as const))
  };
  return { manager, bodyId, request };
}

function liveRegions(
  document: ProjectDocument,
  sketchId: SketchId
): RegionPickData[] {
  const sketch = findSketch(document, sketchId)!;
  const objects = sketch.objectIds.flatMap((id) => {
    const node = document.nodes[id];
    return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
  });
  return computeSketchRegions(objects, (value) => Number(value)).map(
    (region) => ({
      sketchId,
      profileId: region.profileId,
      regionFingerprint: region.regionFingerprint,
      samplePoint: region.samplePoint,
      centroid: region.centroid,
      boundingBox: region.boundingBox,
      sourceEntityIds: region.sourceEntityIds,
      area: region.area
    })
  );
}

function pendingSketch(open = false) {
  const manager = new CommandManager(
    createProjectDocument('Sketch pick', toUserId('user_move_sketch'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: open
        ? { objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 0 }
        : {
            objectKind: 'rectangle',
            width: 40,
            height: 20,
            centerX: 0,
            centerY: 0
          }
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const regions = liveRegions(manager.document, sketchId);
  const pick:
    | Extract<MoveSelectionPick, { kind: 'region' }>
    | Extract<MoveSelectionPick, { kind: 'sketch-profile' }> = open
    ? { kind: 'sketch-profile', sketchId }
    : {
        kind: 'region',
        region: structuredClone(regions[0]!),
        modifiers: { additive: true, toggle: false }
      };
  const request: MoveSelectionRequest = {
    ...pick,
    manager,
    projectId: manager.document.projectId,
    version: manager.document.version
  };
  return { manager, sketchId, regions, pick, request };
}

function pendingConsumedSketch() {
  const fixture = pendingSketch();
  fixture.manager.execute(
    commandFactories.extrudeSketch({
      name: 'Plate',
      sketchId: fixture.sketchId,
      distance: 20
    })
  );
  const hidden = new Set<string>();
  for (const feature of listFeaturesInOrder(fixture.manager.document)) {
    if (feature.data.featureKind === 'extrude') {
      hidden.add(feature.data.sketchId);
    }
  }
  return {
    ...fixture,
    hidden,
    request: { ...fixture.request, version: fixture.manager.document.version }
  };
}

describe('temporarily visible sketch picks during Move', () => {
  it('admits only the carried consumed sketch and retains exact ownership', () => {
    const { manager, sketchId, pick, request, hidden } =
      pendingConsumedSketch();
    const preview = { bodyId: sketchId, target: 'sketch' as const };
    expect(currentMoveSelectionDocument(manager, request)).toBe(
      manager.document
    );
    expect(moveSketchPickVisibility(pick, preview, hidden)).toBe('temporary');
    expect(moveSketchPickVisibility(pick, null, hidden)).toBe('hidden');
    expect(moveSketchPickVisibility(pick, { bodyId: sketchId }, hidden)).toBe(
      'hidden'
    );
    expect(moveSketchPickVisibility(pick, preview, new Set())).toBe('visible');
    manager.execute(
      commandFactories.addSketch({
        name: 'Other hidden sketch',
        plane: 'XY',
        offset: 0,
        object: { objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 0 }
      })
    );
    const other = manager.document.sketchOrder.at(-1)!;
    hidden.add(other);
    expect(
      moveSketchPickVisibility(
        { kind: 'sketch-profile', sketchId: other },
        preview,
        hidden
      )
    ).toBe('hidden');
    expect(currentMoveSelectionDocument(manager, request)).toBeNull();
    expect(
      currentMoveSelectionDocument(new CommandManager(manager.document), {
        ...request,
        version: manager.document.version
      })
    ).toBeNull();
  });

  it('requires fresh coordinates after Apply and hides the sketch when Move ends', () => {
    const { manager, sketchId, pick, request, hidden } =
      pendingConsumedSketch();
    const preview = { bodyId: sketchId, target: 'sketch' as const };
    expect(movePickNeedsFreshTopology(preview, pick, manager.document)).toBe(
      true
    );
    expect(
      movePickNeedsFreshTopology(
        preview,
        { kind: 'sketch-profile', sketchId },
        manager.document
      )
    ).toBe(true);
    const before = liveRegions(manager.document, sketchId)[0]!.samplePoint;
    manager.execute(
      commandFactories.translateSketch({ sketchId, du: 20, dv: 0 })
    );
    expect(liveRegions(manager.document, sketchId)[0]!.samplePoint).toEqual({
      x: before.x + 20,
      y: before.y
    });
    expect(currentMoveSelectionDocument(manager, request)).toBeNull();
    expect(moveSketchPickVisibility(pick, null, hidden)).toBe('hidden');
    expect(hidden.has(sketchId)).toBe(true);
    manager.undo();
    expect(liveRegions(manager.document, sketchId)[0]!.samplePoint).toEqual(
      before
    );
    expect(manager.document.version).toBeGreaterThan(request.version);
    expect(currentMoveSelectionDocument(manager, request)).toBeNull();
  });
});

describe('pending Move selection ownership', () => {
  it.each([false, true])(
    'resolves the live document for a body or box pick (%s)',
    (box) => {
      const { manager, request } = pendingPick(box);
      expect(currentMoveSelectionDocument(manager, request)).toBe(
        manager.document
      );
    }
  );

  it('refuses a newer edit and the higher version produced by real Undo', () => {
    const { manager, request } = pendingPick();
    const feature = listFeaturesInOrder(manager.document)[0]!;
    manager.execute(
      commandFactories.updateFeature({
        featureId: feature.featureId,
        name: 'Changed box'
      })
    );
    expect(currentMoveSelectionDocument(manager, request)).toBeNull();
    manager.undo();
    expect(listFeaturesInOrder(manager.document)[0]!.name).toBe('Box');
    expect(manager.document.version).toBeGreaterThan(request.version);
    expect(currentMoveSelectionDocument(manager, request)).toBeNull();
  });

  it('refuses a replaced manager even when its project, version and body IDs match', () => {
    const { manager, request } = pendingPick();
    const replacement = new CommandManager(manager.document);
    expect(replacement.document.projectId).toBe(request.projectId);
    expect(replacement.document.version).toBe(request.version);
    expect(currentMoveSelectionDocument(replacement, request)).toBeNull();
    expect(currentMoveSelectionDocument(null, request)).toBeNull();
  });

  it('refuses a foreign project with the same version and node IDs', () => {
    const { manager, request } = pendingPick();
    manager.document = {
      ...manager.document,
      projectId: createProjectDocument('Other', toUserId('user_move_other'))
        .projectId
    };
    expect(manager.document.version).toBe(request.version);
    expect(currentMoveSelectionDocument(manager, request)).toBeNull();
  });

  it('requires every delayed box target to remain a body and never accepts an empty sweep', () => {
    const { manager, bodyId, request } = pendingPick(true);
    const feature = listFeaturesInOrder(manager.document)[0]!;
    manager.execute(
      commandFactories.deleteFeature({ featureId: feature.featureId })
    );
    expect(findBodyNode(manager.document, bodyId)).toBeUndefined();
    const refreshed = { ...request, version: manager.document.version };
    expect(currentMoveSelectionDocument(manager, refreshed)).toBeNull();
    expect(
      currentMoveSelectionDocument(manager, {
        ...refreshed,
        kind: 'box',
        bodyIds: []
      })
    ).toBeNull();
  });

  it('checks every body in a delayed edge chain before applying a Move', () => {
    const { manager, bodyId, request } = pendingPick();
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Second box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    const otherBodyId = manager.document.bodyOrder[1]!;
    const chain: MoveSelectionRequest = {
      ...request,
      version: manager.document.version,
      kind: 'edge-chain',
      selections: [
        { bodyId, kind: 'edge', topologyId: 'first-edge' },
        { bodyId: otherBodyId, kind: 'edge', topologyId: 'second-edge' }
      ]
    };
    expect(currentMoveSelectionDocument(manager, chain)).toBe(manager.document);
    const otherFeature = listFeaturesInOrder(manager.document)[1]!;
    manager.execute(
      commandFactories.deleteFeature({ featureId: otherFeature.featureId })
    );
    expect(findBodyNode(manager.document, bodyId)).toBeDefined();
    expect(findBodyNode(manager.document, otherBodyId)).toBeUndefined();
    expect(
      currentMoveSelectionDocument(manager, {
        ...chain,
        version: manager.document.version
      })
    ).toBeNull();
  });

  it('refuses empty chains and non-edge members without changing the owned document', () => {
    const { manager, bodyId, request } = pendingPick();
    const before = manager.document;
    for (const selections of [[], [{ bodyId, kind: 'body' as const }]]) {
      expect(
        currentMoveSelectionDocument(manager, {
          ...request,
          kind: 'edge-chain',
          selections
        })
      ).toBeNull();
    }
    expect(manager.document).toBe(before);
  });
});

describe('picks following an applied Move', () => {
  const bodyId = toBodyId('body_moved');
  const otherBodyId = toBodyId('body_other');
  const face: MoveSelectionPick = {
    kind: 'viewport',
    selection: { bodyId, kind: 'face' },
    additive: false,
    detail: { point: { x: 0, y: 0, z: 20 }, normal: { x: 0, y: 0, z: 1 } }
  };

  it('requires a fresh moved-body face or edge, retaining picks of unaffected bodies', () => {
    expect(movePickNeedsFreshTopology({ bodyId }, face)).toBe(true);
    expect(
      movePickNeedsFreshTopology(
        { bodyId },
        {
          ...face,
          selection: { bodyId, kind: 'edge' }
        }
      )
    ).toBe(true);
    expect(movePickNeedsFreshTopology({ bodyId: otherBodyId }, face)).toBe(
      false
    );
  });

  it('never replays a downstream topology point after a sketch Move under a different ID', () => {
    const sketchMove = { bodyId: 'sketch_profile', target: 'sketch' } as const;
    expect(movePickNeedsFreshTopology(sketchMove, face)).toBe(true);
    expect(
      movePickNeedsFreshTopology(sketchMove, {
        ...face,
        selection: { bodyId: otherBodyId, kind: 'edge' }
      })
    ).toBe(true);
    expect(
      movePickNeedsFreshTopology(sketchMove, {
        ...face,
        selection: { bodyId, kind: 'body' }
      })
    ).toBe(false);
    expect(
      movePickNeedsFreshTopology(sketchMove, {
        kind: 'box',
        bodyIds: [bodyId, otherBodyId]
      })
    ).toBe(false);
  });

  it('requires a fresh chain when any member moved, or a sketch can rebuild its bodies', () => {
    const chain: MoveSelectionPick = {
      kind: 'edge-chain',
      selections: [
        { bodyId: otherBodyId, kind: 'edge' },
        { bodyId, kind: 'edge' }
      ]
    };
    expect(movePickNeedsFreshTopology({ bodyId }, chain)).toBe(true);
    expect(
      movePickNeedsFreshTopology({ bodyId: 'unaffected-body' }, chain)
    ).toBe(false);
    expect(
      movePickNeedsFreshTopology(
        { bodyId: 'sketch_profile', target: 'sketch' },
        chain
      )
    ).toBe(true);
    expect(
      movePickNeedsFreshTopology(
        { bodyId },
        { kind: 'edge-chain', selections: [] }
      )
    ).toBe(false);
  });
});

describe('deferred sketch and region selections', () => {
  it('resolves the live unique rectangle region and preserves its modifier intent', () => {
    const { manager, regions, pick, request } = pendingSketch();
    expect(currentMoveSelectionDocument(manager, request)).toBe(
      manager.document
    );
    if (pick.kind !== 'region') throw new Error('expected a region pick');
    expect(resolveMoveSketchRegion(pick, regions)).toBe(regions[0]);
    expect(pick.modifiers).toEqual({ additive: true, toggle: false });
    expect(resolveMoveSketchRegion(pick, [...regions, regions[0]!])).toBeNull();
    for (const region of [
      { ...pick.region, profileId: 'other-profile' },
      { ...pick.region, regionFingerprint: pick.region.regionFingerprint + 1 },
      { ...pick.region, sourceEntityIds: ['other-object'] },
      { ...pick.region, sketchId: 'other-sketch' }
    ]) {
      expect(resolveMoveSketchRegion({ ...pick, region }, regions)).toBeNull();
    }
  });

  it('rejects translated region geometry and real Undo versions before applying a Move', () => {
    const { manager, sketchId, pick, request } = pendingSketch();
    if (pick.kind !== 'region') throw new Error('expected a region pick');
    manager.execute(
      commandFactories.translateSketch({ sketchId, du: 7, dv: 2 })
    );
    const translated = liveRegions(manager.document, sketchId);
    expect(translated[0]!.samplePoint).not.toEqual(pick.region.samplePoint);
    expect(currentMoveSelectionDocument(manager, request)).toBeNull();
    expect(resolveMoveSketchRegion(pick, translated)).toBeNull();
    manager.undo();
    expect(liveRegions(manager.document, sketchId)[0]!.samplePoint).toEqual(
      pick.region.samplePoint
    );
    expect(manager.document.version).toBeGreaterThan(request.version);
    expect(currentMoveSelectionDocument(manager, request)).toBeNull();
  });

  it.each([false, true])(
    'refuses a removed sketch, replacement manager or foreign project (%s)',
    (open) => {
      const { manager, request } = pendingSketch(open);
      expect(
        currentMoveSelectionDocument(
          new CommandManager(manager.document),
          request
        )
      ).toBeNull();
      const feature = listFeaturesInOrder(manager.document)[0]!;
      manager.execute(
        commandFactories.deleteFeature({ featureId: feature.featureId })
      );
      expect(
        currentMoveSelectionDocument(manager, {
          ...request,
          version: manager.document.version
        })
      ).toBeNull();
      const foreign = pendingSketch(open);
      foreign.manager.document = {
        ...foreign.manager.document,
        projectId: manager.document.projectId
      };
      expect(
        currentMoveSelectionDocument(foreign.manager, foreign.request)
      ).toBeNull();
    }
  );

  it('preserves an open-line whole-sketch pick without demanding a closed region', () => {
    const { manager, regions, pick, request } = pendingSketch(true);
    expect(regions).toEqual([]);
    expect(currentMoveSelectionDocument(manager, request)).toBe(
      manager.document
    );
    expect(
      movePickNeedsFreshTopology(
        { bodyId: 'body_move' },
        pick,
        manager.document
      )
    ).toBe(false);
    expect(
      movePickNeedsFreshTopology(
        { bodyId: 'other_sketch', target: 'sketch' },
        pick,
        manager.document
      )
    ).toBe(true);
  });

  it('keeps canonical/fixed regions after body Move but re-picks potentially affected face attachments', () => {
    const { manager, sketchId, pick } = pendingSketch();
    const sketch = findSketch(manager.document, sketchId)!;
    const bodyMove = { bodyId: 'body_move' };
    expect(movePickNeedsFreshTopology(bodyMove, pick, manager.document)).toBe(
      false
    );
    const frame = {
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 }
    };
    for (const planeRef of [
      { type: 'frame', frame },
      {
        type: 'face',
        bodyId: toBodyId('indirect_attachment'),
        faceHash: 1,
        sourceArea: 1,
        sourceCenter: frame.origin,
        sourceNormal: frame.zAxis,
        frame
      }
    ] satisfies SketchPlaneRef[]) {
      manager.document = {
        ...manager.document,
        nodes: {
          ...manager.document.nodes,
          [sketch.id]: { ...sketch, planeRef }
        }
      };
      expect(movePickNeedsFreshTopology(bodyMove, pick, manager.document)).toBe(
        planeRef.type === 'face'
      );
    }
    expect(
      movePickNeedsFreshTopology(
        { bodyId: sketchId, target: 'sketch' },
        pick,
        manager.document
      )
    ).toBe(true);
  });

  it('validates an additive tree body pick before teardown and preserves its stable ID after Move', () => {
    const { manager, bodyId, request } = pendingPick();
    const tree: MoveSelectionRequest = {
      ...request,
      kind: 'body-tree',
      bodyId,
      additive: true
    };
    expect(currentMoveSelectionDocument(manager, tree)).toBe(manager.document);
    expect(movePickNeedsFreshTopology({ bodyId }, tree, manager.document)).toBe(
      false
    );
    manager.execute(
      commandFactories.deleteFeature({
        featureId: listFeaturesInOrder(manager.document)[0]!.featureId
      })
    );
    expect(
      currentMoveSelectionDocument(manager, {
        ...tree,
        version: manager.document.version
      })
    ).toBeNull();
  });
});
