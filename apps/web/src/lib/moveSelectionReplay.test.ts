import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type TopologySelection
} from '@openzcad/shared';
import { featureResultBodyIds } from './featureHistory';
import {
  selectionRebuiltByMove,
  type MoveAnswer,
  type PendingSelectionSwitch
} from './moveSelectionReplay';

/**
 * A sketch driving an extrude that a fillet is built on, and a block beside
 * them: the three places a pick can land relative to a Move.
 */
function fixture() {
  const manager = new CommandManager(
    createProjectDocument('Replay', toUserId('user_test'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 40,
        height: 20,
        centerX: 0,
        centerY: 0
      }
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  manager.execute(
    commandFactories.extrudeSketch({ name: 'Plate', sketchId, distance: 8 })
  );
  manager.execute(
    commandFactories.filletEdges({
      name: 'Round corners',
      targetBodyId: manager.document.bodyOrder[0]!,
      edgeHashes: [123],
      size: 1
    })
  );
  // The plate as it stands at the end of history: the fillet's result.
  const plate = featureResultBodyIds(
    listFeaturesInOrder(manager.document).at(-1)!
  )[0]!;
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 5, depth: 5 }
    })
  );
  const block = manager.document.bodyOrder.at(-1)!;
  return { document: manager.document, sketchId, plate, block };
}

const { document, sketchId, plate, block } = fixture();

/** Where the pick lands relative to the Move, and the Move it lands under. */
const targets = {
  // Moving the block, picking the block.
  'the moved body': {
    preview: { bodyId: block as string },
    bodyId: block
  },
  // Moving the sketch, picking the plate its extrude (and fillet) made.
  'a body downstream of what moved': {
    preview: { bodyId: sketchId as string, target: 'sketch' as const },
    bodyId: plate
  },
  // Moving the block, picking the plate.
  'an unrelated body': {
    preview: { bodyId: block as string },
    bodyId: plate
  }
};
type TargetName = keyof typeof targets;

const at = { x: 400, y: 300 };
function selection(
  kind: TopologySelection['kind'],
  bodyId: BodyId
): TopologySelection {
  return kind === 'body'
    ? { bodyId, kind }
    : { bodyId, kind, topologyId: `${kind}:1`, hash: 1 };
}
const selections: Record<string, (bodyId: BodyId) => PendingSelectionSwitch> = {
  'body pick': (bodyId) => ({
    kind: 'pick',
    selection: selection('body', bodyId),
    additive: false
  }),
  'face pick': (bodyId) => ({
    kind: 'pick',
    selection: selection('face', bodyId),
    additive: false
  }),
  'edge pick': (bodyId) => ({
    kind: 'pick',
    selection: selection('edge', bodyId),
    additive: false
  }),
  'box select': (bodyId) => ({ kind: 'box', bodyIds: [bodyId] }),
  'right-click on body': (bodyId) => ({
    kind: 'pick',
    selection: selection('body', bodyId),
    additive: false,
    contextMenu: at
  }),
  'right-click on face': (bodyId) => ({
    kind: 'pick',
    selection: selection('face', bodyId),
    additive: false,
    contextMenu: at
  })
};
const carriesTopology = new Set([
  'face pick',
  'edge pick',
  'right-click on face'
]);

const cases = Object.keys(selections).flatMap((selectionName) =>
  (Object.keys(targets) as TargetName[]).flatMap((targetName) =>
    (['apply', 'discard', 'cancel'] as MoveAnswer[]).map(
      (answer) => [selectionName, targetName, answer] as const
    )
  )
);

describe('a selection held back by the unapplied-Move question', () => {
  it.each(cases)('%s on %s, then %s', (selectionName, targetName, answer) => {
    const target = targets[targetName];
    const pending = selections[selectionName]!(target.bodyId);
    const result = selectionRebuiltByMove(
      document,
      target.preview,
      pending,
      answer
    );
    if (answer === 'cancel') {
      // The Move, its values and the selection stay as they were.
      expect(result).toEqual({ replay: null, dropped: 0 });
      return;
    }
    const stale =
      answer === 'apply' &&
      carriesTopology.has(selectionName) &&
      targetName !== 'an unrelated body';
    if (stale) {
      // A face or edge on a rebuilt body names replaced topology, and a
      // right-click's menu goes with it.
      expect(result).toEqual({ replay: null, dropped: 1 });
    } else {
      // Bodies keep their ids through the rebuild, and nothing else was
      // rebuilt: the selection lands exactly as made, menu point included.
      expect(result).toEqual({ replay: pending, dropped: 0 });
    }
  });

  it('drops only the stale edges of a double-clicked run', () => {
    const run: PendingSelectionSwitch = {
      kind: 'edge-chain',
      selections: [selection('edge', plate), selection('edge', block)]
    };
    expect(
      selectionRebuiltByMove(
        document,
        { bodyId: sketchId, target: 'sketch' },
        run,
        'apply'
      )
    ).toEqual({
      replay: { kind: 'edge-chain', selections: [selection('edge', block)] },
      dropped: 1
    });
    expect(
      selectionRebuiltByMove(document, { bodyId: block }, run, 'apply')
    ).toEqual({
      replay: { kind: 'edge-chain', selections: [selection('edge', plate)] },
      dropped: 1
    });
    expect(
      selectionRebuiltByMove(document, { bodyId: block }, run, 'discard')
    ).toEqual({ replay: run, dropped: 0 });
  });
});
