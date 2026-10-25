import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type FeatureNode,
  type ParametricVector3
} from '@openzcad/shared';
import {
  PRIMITIVE_ANCHORS,
  applyPrimitiveCommand,
  createPrimitiveCommand,
  primitivePlacement
} from './primitivePlacement';

const box = { width: 30, height: 18, depth: 24 };

function boxManager(position: ParametricVector3 = { x: 0, y: 0, z: 0 }) {
  const manager = new CommandManager(
    createProjectDocument('Placement', toUserId('user_placement'))
  );
  manager.execute(createPrimitiveCommand('box', 'Box', box, position));
  return manager;
}

const features = (manager: CommandManager) =>
  listFeaturesInOrder(manager.document);
const primitiveOf = (manager: CommandManager): FeatureNode =>
  features(manager).find(
    (feature) => feature.data.featureKind === 'primitive'
  )!;

describe('primitive placement', () => {
  it('names a different anchor for the box and the cylinder', () => {
    expect(PRIMITIVE_ANCHORS.box.label).toBe('Corner');
    expect(PRIMITIVE_ANCHORS.cylinder.label).toBe('Base center');
  });

  it.each([0, 10])(
    'stores the body number before creating a primitive at X=%s',
    (x) => {
      const initial = createProjectDocument(
        'Numbered placement',
        toUserId('user_numbered_placement')
      );
      const manager = new CommandManager(initial);
      manager.execute(
        createPrimitiveCommand(
          'box',
          'Box',
          box,
          { x: 0, y: 0, z: 0 },
          manager.document
        )
      );
      const command = createPrimitiveCommand(
        'box',
        'Box',
        box,
        { x, y: 0, z: 0 },
        manager.document
      );
      const add = command.commands?.[0] ?? command;
      // G9: History read "Box", "Box" for two boxes.
      expect(add).toMatchObject({
        kind: 'primitive.add',
        payload: { name: 'Box 2', bodyName: 'Box 2' }
      });
      manager.execute(command);
      const names = () =>
        Object.values(manager.document.nodes)
          .filter((node) => node.kind === 'body')
          .map((node) => node.name);
      expect(names()).toEqual(['Box 1', 'Box 2']);
      manager.undo();
      expect(names()).toEqual(['Box 1']);
      manager.redo();
      expect(names()).toEqual(['Box 1', 'Box 2']);
      const replayed = replayCommands(initial, manager.document.commandLog);
      expect(
        Object.values(replayed.nodes)
          .filter((node) => node.kind === 'body')
          .map((node) => node.name)
      ).toEqual(['Box 1', 'Box 2']);
      expect(features(manager).map((feature) => feature.name)).toEqual(
        x === 0 ? ['Box', 'Box 2'] : ['Box', 'Box 2', 'Place Box 2']
      );
    }
  );

  it('creates a placed primitive as the primitive plus its placement Move', () => {
    const manager = boxManager({ x: 10, y: 0, z: '2 * 3' });
    // Expressions are stored as typed, like every other card field.
    const [primitive, place] = features(manager);
    expect(primitive!.data.featureKind).toBe('primitive');
    expect(place).toMatchObject({
      name: 'Place Box',
      data: {
        featureKind: 'transform',
        targetBodyId: primitive!.bodyId,
        transform: { translation: { x: 10, y: 0, z: '2 * 3' } }
      }
    });
    expect(primitivePlacement(manager.document, primitive!)).toEqual({
      feature: place,
      position: { x: 10, y: 0, z: '2 * 3' }
    });
    // One undo removes both.
    manager.undo();
    expect(features(manager)).toHaveLength(0);
  });

  it('reads the origin when nothing places the primitive', () => {
    const manager = boxManager();
    expect(primitivePlacement(manager.document, primitiveOf(manager))).toEqual({
      feature: null,
      position: { x: 0, y: 0, z: 0 }
    });
    expect(primitivePlacement(null, primitiveOf(manager)).feature).toBeNull();
  });

  it('rewrites an existing placement instead of stacking another', () => {
    const manager = boxManager({ x: 10, y: 0, z: 0 });
    manager.execute(
      applyPrimitiveCommand(
        manager.document,
        primitiveOf(manager),
        'Box',
        box,
        { x: 4, y: 5, z: 6 }
      )
    );
    expect(features(manager).map((feature) => feature.name)).toEqual([
      'Box',
      'Place Box'
    ]);
    expect(
      primitivePlacement(manager.document, primitiveOf(manager)).position
    ).toEqual({ x: 4, y: 5, z: 6 });
  });

  it('inserts a placement directly after the primitive, ahead of later edits', () => {
    const manager = boxManager();
    const bodyId = primitiveOf(manager).bodyId!;
    // A rotated Move is a later edit, not the placement.
    manager.execute(
      commandFactories.transformBody({
        name: 'Turn',
        targetBodyId: bodyId,
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 45 }
      })
    );
    expect(
      primitivePlacement(manager.document, primitiveOf(manager)).feature
    ).toBeNull();
    manager.execute(
      applyPrimitiveCommand(
        manager.document,
        primitiveOf(manager),
        'Box',
        box,
        { x: 1, y: 2, z: 3 }
      )
    );
    expect(features(manager).map((feature) => feature.name)).toEqual([
      'Box',
      'Place Box',
      'Turn'
    ]);
    expect(
      primitivePlacement(manager.document, primitiveOf(manager)).position
    ).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('ignores a suppressed Move when reading the placement', () => {
    const manager = boxManager({ x: 10, y: 0, z: 0 });
    const document = structuredClone(manager.document);
    const place = listFeaturesInOrder(document)[1]!;
    document.nodes[place.id]!.metadata = {
      ...place.metadata,
      [FEATURE_SUPPRESSED_METADATA_KEY]: true
    };
    expect(primitivePlacement(document, primitiveOf(manager))).toEqual({
      feature: null,
      position: { x: 0, y: 0, z: 0 }
    });
  });

  it('applies only the dimensions when the position did not move', () => {
    const manager = boxManager({ x: 10, y: 0, z: 0 });
    const command = applyPrimitiveCommand(
      manager.document,
      primitiveOf(manager),
      'Box',
      { ...box, width: 40 },
      { x: 10, y: 0, z: 0 }
    );
    expect(command.commands).toBeUndefined();
    manager.execute(command);
    expect(primitiveOf(manager).data).toMatchObject({
      dimensions: { width: 40 }
    });
  });

  it('places a turned primitive in one Move, read as a later edit', () => {
    const manager = new CommandManager(
      createProjectDocument('Turned', toUserId('user_turned_placement'))
    );
    manager.execute(
      createPrimitiveCommand(
        'cylinder',
        'Cylinder',
        { radius: 3, height: 10 },
        { x: 20, y: 0, z: 5 },
        manager.document,
        { x: 90, y: 0, z: 90 }
      )
    );
    const moves = features(manager).filter(
      (feature) => feature.data.featureKind === 'transform'
    );
    expect(moves.map((move) => move.name)).toEqual(['Place Cylinder']);
    expect(moves[0]!.data).toMatchObject({
      transform: {
        translation: { x: 20, y: 0, z: 5 },
        rotationDeg: { x: 90, y: 0, z: 90 }
      }
    });
    // Its card edits the sizes; a turn stays a Move of its own.
    expect(primitivePlacement(manager.document, primitiveOf(manager)).feature).toBeNull();
  });

  it('adds no Move for an unturned primitive at the origin', () => {
    expect(
      createPrimitiveCommand('box', 'Box', box, { x: 0, y: 0, z: 0 }, null, {
        x: 0,
        y: 0,
        z: 0
      }).kind
    ).toBe('primitive.add');
  });
});
