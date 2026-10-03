import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
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
});
