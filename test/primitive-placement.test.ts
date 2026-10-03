import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BoundingBox,
  type PrimitiveKind,
  type ProjectDocument
} from '@openzcad/shared';
import {
  applyPrimitiveCommand,
  createPrimitiveCommand,
  primitivePlacement
} from '../apps/web/src/lib/primitivePlacement';

/**
 * The Position row's labels are a claim about the kernel: "Corner" for a box,
 * "Base center" for a cylinder and cone, "Center" for a sphere and torus.
 * These build each primitive through the card's own commands and read the
 * exact bounding box back, so a label that stopped matching the geometry
 * fails here rather than in a user's model.
 */
describe('primitive card placement', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  const position = { x: 15, y: 9, z: 24 };

  const cases: Array<{
    kind: PrimitiveKind;
    dimensions: Record<string, number>;
    expected: BoundingBox;
  }> = [
    {
      kind: 'box',
      dimensions: { width: 30, height: 18, depth: 24 },
      // Corner: the minimum X, Y and Z; the box grows from it.
      expected: { min: { x: 15, y: 9, z: 24 }, max: { x: 45, y: 27, z: 48 } }
    },
    {
      kind: 'cylinder',
      dimensions: { radius: 6, height: 28 },
      // Base center: centred in X and Y, rising along +Z.
      expected: { min: { x: 9, y: 3, z: 24 }, max: { x: 21, y: 15, z: 52 } }
    },
    {
      kind: 'cone',
      dimensions: { bottomRadius: 6, topRadius: 2, height: 28 },
      expected: { min: { x: 9, y: 3, z: 24 }, max: { x: 21, y: 15, z: 52 } }
    },
    {
      kind: 'sphere',
      dimensions: { radius: 6 },
      expected: { min: { x: 9, y: 3, z: 18 }, max: { x: 21, y: 15, z: 30 } }
    },
    {
      kind: 'torus',
      dimensions: { majorRadius: 6, minorRadius: 2 },
      // Center, with the ring flat in XY.
      expected: { min: { x: 7, y: 1, z: 22 }, max: { x: 23, y: 17, z: 26 } }
    }
  ];

  const bounds = async (document: ProjectDocument): Promise<BoundingBox> => {
    document.derived = await adapter.syncDocument(document);
    expect(document.derived.warnings).toEqual([]);
    const bodyId = document.bodyOrder[0]!;
    return document.derived.bodyRepresentations[bodyId]!.bbox;
  };

  const expectBounds = (actual: BoundingBox, expected: BoundingBox) => {
    for (const corner of ['min', 'max'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(actual[corner][axis]).toBeCloseTo(expected[corner][axis], 3);
      }
    }
  };

  it.each(cases)(
    'places a $kind by the point its card names',
    async ({ kind, dimensions, expected }) => {
      const manager = new CommandManager(
        createProjectDocument(`Placed ${kind}`, toUserId('user_placement'))
      );
      manager.execute(
        createPrimitiveCommand(kind, 'Part', dimensions, position)
      );
      expectBounds(await bounds(manager.document), expected);
    }
  );

  it('moves a placed cylinder by editing its card, in one undo step', async () => {
    const manager = new CommandManager(
      createProjectDocument('Edited cylinder', toUserId('user_placement'))
    );
    manager.execute(
      createPrimitiveCommand(
        'cylinder',
        'Cylinder',
        { radius: 6, height: 28 },
        { x: 0, y: 0, z: 0 }
      )
    );
    const cylinder = listFeaturesInOrder(manager.document)[0]!;
    manager.execute(
      applyPrimitiveCommand(
        manager.document,
        cylinder,
        'Cylinder',
        { radius: 6, height: 28 },
        { x: 15, y: 9, z: 24 }
      )
    );
    expect(primitivePlacement(manager.document, cylinder).position).toEqual({
      x: 15,
      y: 9,
      z: 24
    });
    expectBounds(await bounds(manager.document), {
      min: { x: 9, y: 3, z: 24 },
      max: { x: 21, y: 15, z: 52 }
    });

    manager.undo();
    expect(listFeaturesInOrder(manager.document)).toHaveLength(1);
    expectBounds(await bounds(manager.document), {
      min: { x: -6, y: -6, z: 0 },
      max: { x: 6, y: 6, z: 28 }
    });
  });

  it('keeps a box created at the origin a single primitive feature', () => {
    const manager = new CommandManager(
      createProjectDocument('Origin box', toUserId('user_placement'))
    );
    manager.execute(
      createPrimitiveCommand(
        'box',
        'Box',
        { width: 30, height: 18, depth: 24 },
        { x: 0, y: 0, z: 0 }
      )
    );
    expect(
      listFeaturesInOrder(manager.document).map(
        (feature) => feature.data.featureKind
      )
    ).toEqual(['primitive']);
    // The same feature data the card stored before it had a Position row.
    const reference = new CommandManager(
      createProjectDocument('Reference box', toUserId('user_placement'))
    );
    reference.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      })
    );
    expect(listFeaturesInOrder(manager.document)[0]!.data).toEqual(
      listFeaturesInOrder(reference.document)[0]!.data
    );
  });
});
