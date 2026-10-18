import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  listFeaturesInOrder,
  setParameter,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  extrudeEditTargets,
  extrudePreviewMagnitude
} from '../apps/web/src/lib/extrudeEditing';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ProjectDocument,
  type ThroughAllSide
} from '@openzcad/shared';

/**
 * F01 through-all, first slice (docs/plans/f01-through-all-qualification.md):
 * a cut through one explicit target with an explicit side. The span is
 * recomputed from the target on every rebuild; nothing derived is stored.
 */
function block(depth: number | string = 10): {
  document: ProjectDocument;
  blockId: BodyId;
} {
  let document = createProjectDocument(
    'Through all',
    toUserId('user_through_all')
  );
  document = setParameter(document, {
    name: 'block_d',
    expression: String(depth)
  });
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 'block_d' }
  });
  return { document, blockId: document.bodyOrder[0]! };
}

/** A 4 × 4 square at (10, 10) on XY offset `planeZ`, cut through the block. */
function cut(
  document: ProjectDocument,
  blockId: BodyId,
  side: ThroughAllSide,
  planeZ = 0
) {
  const sketched = addSketchFeature(document, {
    name: 'Hole sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset: planeZ },
    objects: [
      { objectKind: 'rectangle', width: 4, height: 4, centerX: 10, centerY: 10 }
    ]
  });
  return extrudeSketch(sketched.document, {
    name: 'Through cut',
    sketchId: sketched.sketchId,
    distance: 2,
    operation: 'cut',
    targetBodyId: blockId,
    endCondition: 'through-all',
    throughAllSide: side
  });
}

const HOLE = 4 * 4;

describe('F01 through-all: document contract', () => {
  it('stores the end condition and side, and nothing derived', () => {
    const { document, blockId } = block();
    const result = cut(document, blockId, 'forward');
    const feature = listFeaturesInOrder(result.document).at(-1)!;
    expect(feature.data).toMatchObject({
      featureKind: 'extrude',
      distance: 2,
      operation: 'cut',
      targetBodyId: blockId,
      endCondition: 'through-all',
      throughAllSide: 'forward'
    });
  });

  it.each([
    [{ operation: 'add' }, /cut extrusion only/],
    [{ operation: 'cut', targetBodyId: undefined }, /one explicit target/],
    [{ operation: 'cut', throughAllSide: undefined }, /needs a side/],
    [{ operation: 'cut', symmetric: true }, /not symmetric/],
    [{ operation: 'cut', backDistance: 3 }, /no back distance/]
  ])('refuses %o', (patch, message) => {
    const { document, blockId } = block();
    const sketched = addSketchFeature(document, {
      name: 'S',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 10,
          centerY: 10
        }
      ]
    });
    expect(() =>
      extrudeSketch(sketched.document, {
        name: 'Bad',
        sketchId: sketched.sketchId,
        distance: 2,
        targetBodyId: blockId,
        endCondition: 'through-all',
        throughAllSide: 'forward',
        ...(patch as object)
      } as never)
    ).toThrow(message);
  });

  it('switches back to blind by clearing the extent, through one undoable edit', () => {
    const { document, blockId } = block();
    const result = cut(document, blockId, 'both');
    const featureId = listFeaturesInOrder(result.document).at(-1)!.featureId;
    const manager = new CommandManager(result.document);
    manager.execute(
      commandFactories.updateFeature({
        featureId,
        clearData: ['endCondition', 'throughAllSide']
      })
    );
    const data = listFeaturesInOrder(manager.document).at(-1)!.data;
    expect(data).not.toHaveProperty('endCondition');
    expect(data).not.toHaveProperty('throughAllSide');
    manager.undo();
    expect(listFeaturesInOrder(manager.document).at(-1)!.data).toMatchObject({
      endCondition: 'through-all',
      throughAllSide: 'both'
    });
    // Leaving a side behind with a blind extent is refused.
    expect(() =>
      updateFeature(result.document, {
        featureId,
        clearData: ['endCondition']
      })
    ).toThrow(/blind extrude has no through-all side/);
  });
});

describe('F01 through-all: editing', () => {
  it('still lists the cut target when a through-all cut is reopened', () => {
    const { document, blockId } = block();
    const result = cut(document, blockId, 'forward');
    const feature = listFeaturesInOrder(result.document).at(-1)!;
    expect(
      extrudeEditTargets(result.document, feature).map((body) => body.bodyId)
    ).toEqual([blockId]);
  });
});

describe('F01 through-all: edit preview', () => {
  it('never resolves the dormant distance of a through-all edit', () => {
    const unresolvable = () => {
      throw new Error('Unknown identifier "gone"');
    };
    expect(
      extrudePreviewMagnitude(
        { distance: 'gone * 2', endCondition: 'through-all' },
        unresolvable
      )
    ).toBe(1);
    expect(
      extrudePreviewMagnitude(
        { distance: -8, endCondition: 'blind' },
        (distance) => Number(distance)
      )
    ).toBe(8);
  });
});

describe('F01 through-all: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function volume(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return derived.bodyRepresentations[bodyId]!.volume;
  }

  it('cuts forward through the whole block from its bottom face', async () => {
    const { document, blockId } = block(10);
    const result = cut(document, blockId, 'forward');
    expect(await volume(result.document, result.bodyId)).toBeCloseTo(
      20 * 20 * 10 - HOLE * 10,
      6
    );
  });

  it('cuts backward and both ways from a mid-block plane', async () => {
    const { document, blockId } = block(10);
    const back = cut(document, blockId, 'backward', 4);
    expect(await volume(back.document, back.bodyId)).toBeCloseTo(
      4000 - HOLE * 4,
      6
    );
    const both = cut(document, blockId, 'both', 4);
    expect(await volume(both.document, both.bodyId)).toBeCloseTo(
      4000 - HOLE * 10,
      6
    );
  });

  it('follows the target when it grows or moves, with no stored depth', async () => {
    const { document, blockId } = block(10);
    const result = cut(document, blockId, 'forward');
    const grown = setParameter(result.document, {
      name: 'block_d',
      expression: '25'
    });
    expect(await volume(grown, result.bodyId)).toBeCloseTo(
      20 * 20 * 25 - HOLE * 25,
      6
    );
    // A rotated, translated target still gets a finite, complete cut.
    const moved = transformBody(document, {
      name: 'Tilt',
      targetBodyId: blockId,
      translation: { x: 0, y: 0, z: 1 },
      rotationDeg: { x: 0, y: 0, z: 30 }
    });
    const tilted = cut(moved.document, moved.bodyId, 'forward');
    expect(await volume(tilted.document, tilted.bodyId)).toBeCloseTo(
      4000 - HOLE * 10,
      6
    );
  });

  it('cuts a thin sheet far from its sketch plane without a false no-overlap refusal', async () => {
    let document = createProjectDocument(
      'Distant sheet',
      toUserId('user_through_all')
    );
    document = addPrimitiveFeature(document, {
      name: 'Sheet',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 0.1 }
    });
    const sheetId = document.bodyOrder[0]!;
    document = transformBody(document, {
      name: 'Lift',
      targetBodyId: sheetId,
      translation: { x: 0, y: 0, z: 1000 }
    }).document;
    const sketched = addSketchFeature(document, {
      name: 'Pin sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 1,
          height: 1,
          centerX: 10,
          centerY: 10
        }
      ]
    });
    const result = extrudeSketch(sketched.document, {
      name: 'Pin hole',
      sketchId: sketched.sketchId,
      distance: 2,
      operation: 'cut',
      targetBodyId: sheetId,
      endCondition: 'through-all',
      throughAllSide: 'forward'
    });
    expect(await volume(result.document, result.bodyId)).toBeCloseTo(
      20 * 20 * 0.1 - 1 * 1 * 0.1,
      6
    );
  });

  it('keeps a small cut in a small distant target instead of calling it total removal', async () => {
    let document = createProjectDocument(
      'Distant chip',
      toUserId('user_through_all')
    );
    document = addPrimitiveFeature(document, {
      name: 'Chip',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 0.1 }
    });
    const chipId = document.bodyOrder[0]!;
    document = transformBody(document, {
      name: 'Lift',
      targetBodyId: chipId,
      translation: { x: 0, y: 0, z: 1000 }
    }).document;
    const sketched = addSketchFeature(document, {
      name: 'Pin sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 0.1,
          height: 0.1,
          centerX: 0.5,
          centerY: 0.5
        }
      ]
    });
    const result = extrudeSketch(sketched.document, {
      name: 'Pin hole',
      sketchId: sketched.sketchId,
      distance: 2,
      operation: 'cut',
      targetBodyId: chipId,
      endCondition: 'through-all',
      throughAllSide: 'forward'
    });
    expect(await volume(result.document, result.bodyId)).toBeCloseTo(
      0.1 - 0.1 * 0.1 * 0.1,
      9
    );
  });

  it('cuts a small hole through a large block at the cut scale', async () => {
    let document = createProjectDocument(
      'Large block',
      toUserId('user_through_all')
    );
    document = addPrimitiveFeature(document, {
      name: 'Big',
      primitiveKind: 'box',
      dimensions: { width: 1000, height: 1000, depth: 1000 }
    });
    const bigId = document.bodyOrder[0]!;
    const sketched = addSketchFeature(document, {
      name: 'Pin sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 0.5,
          height: 0.5,
          centerX: 500,
          centerY: 500
        }
      ]
    });
    const result = extrudeSketch(sketched.document, {
      name: 'Pin hole',
      sketchId: sketched.sketchId,
      distance: 2,
      operation: 'cut',
      targetBodyId: bigId,
      endCondition: 'through-all',
      throughAllSide: 'forward'
    });
    expect(await volume(result.document, result.bodyId)).toBeCloseTo(
      1e9 - 0.5 * 0.5 * 1000,
      0
    );
  });

  it('refuses a profile moved off the target footprint instead of cutting nothing', async () => {
    const { document, blockId } = block(10);
    const sketched = addSketchFeature(document, {
      name: 'Off sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 60,
          centerY: 10
        }
      ]
    });
    const result = extrudeSketch(sketched.document, {
      name: 'Off cut',
      sketchId: sketched.sketchId,
      distance: 2,
      operation: 'cut',
      targetBodyId: blockId,
      endCondition: 'through-all',
      throughAllSide: 'forward'
    });
    const derived = await adapter.syncDocument(result.document);
    expect(derived.warnings.join('\n')).toMatch(/no longer overlaps/);
    expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
  });

  it('refuses a side that misses the target, naming it', async () => {
    const { document, blockId } = block(10);
    const result = cut(document, blockId, 'backward', 0);
    const derived = await adapter.syncDocument(result.document);
    expect(derived.warnings.join('\n')).toMatch(
      /no target in the selected direction \(target Block Body, side backward\)\./
    );
    expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
  });

  it('fails closed on a malformed stored extent instead of building blind', async () => {
    const { document, blockId } = block(10);
    const result = cut(document, blockId, 'forward');
    const node = listFeaturesInOrder(result.document).at(-1)!;
    const forged = (data: Record<string, unknown>): ProjectDocument => ({
      ...result.document,
      nodes: {
        ...result.document.nodes,
        [node.id]: { ...node, data: { ...node.data, ...data } }
      }
    });
    for (const [patch, message] of [
      [{ endCondition: 'to-next' }, /Unknown extrude end condition/],
      [{ endCondition: null }, /Unknown extrude end condition/],
      [{ throughAllSide: ['backward'] }, /needs a side/],
      [
        { endCondition: undefined, throughAllSide: 'both' },
        /blind extrude has no through-all side/
      ]
    ] as const) {
      const derived = await adapter.syncDocument(forged(patch));
      expect(derived.warnings.join('\n')).toMatch(message);
      expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
    }
  });

  it('refuses when its target is gone', async () => {
    const { document, blockId } = block(10);
    const result = cut(document, blockId, 'forward');
    const blockFeature = listFeaturesInOrder(result.document)[0]!;
    const orphaned = deleteFeature(result.document, {
      featureId: blockFeature.featureId
    });
    const derived = await adapter.syncDocument(orphaned);
    expect(derived.warnings.join('\n')).toMatch(/Through-all target/);
  });
});
