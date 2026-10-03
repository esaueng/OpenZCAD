import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  findBodyNode,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toBodyId, toUserId } from '@openzcad/shared';
import {
  currentMoveSelectionDocument,
  movePickNeedsFreshTopology,
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
});
