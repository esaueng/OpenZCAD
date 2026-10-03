import { describe, it, expect } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, FEATURE_SUPPRESSED_METADATA_KEY } from '@openzcad/shared';
import type { BodyId } from '@openzcad/shared';
import {
  bodiesRebuiltByMove,
  featureHistory,
  featureResultBodyIds
} from './featureHistory';

export function historyFixture() {
  const manager = new CommandManager(
    createProjectDocument('History', toUserId('user_test'))
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
  const bodyId = manager.document.bodyOrder[0]!;
  manager.execute(
    commandFactories.transformBody({
      name: 'Move plate',
      targetBodyId: bodyId,
      translation: { x: 10, y: 0, z: 0 }
    })
  );
  manager.execute(
    commandFactories.filletEdges({
      name: 'Round corners',
      targetBodyId: bodyId,
      edgeHashes: [123],
      size: 1
    })
  );
  const features = listFeaturesInOrder(manager.document);
  return { manager, features };
}

describe('feature history relationships', () => {
  it('tracks a sketch through an in-place edit to its fillet without counting itself', () => {
    const { manager, features } = historyFixture();
    const graph = featureHistory(manager.document);
    expect(graph.downstream(features[0]!.featureId).map((f) => f.name)).toEqual(
      ['Plate', 'Move plate', 'Round corners']
    );
    expect([...graph.parents.get(features[3]!.featureId)!]).toEqual([
      features[2]!.featureId
    ]);
    expect(graph.downstream(features[3]!.featureId)).toEqual([]);
  });
  it('retains suppressed dependents and does not mistake an unrelated body for a dependency', () => {
    const { manager, features } = historyFixture();
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: features[2]!.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      })
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Independent',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    const graph = featureHistory(manager.document);
    expect(graph.downstream(features[0]!.featureId).map((f) => f.name)).toEqual(
      ['Plate', 'Move plate', 'Round corners']
    );
    expect([...graph.parents.get(graph.features.at(-1)!.featureId)!]).toEqual(
      []
    );
  });
});

it('reports a deleted input instead of treating it as an independent feature', () => {
  const { manager, features } = historyFixture();
  manager.execute(
    commandFactories.deleteFeature({ featureId: features[1]!.featureId })
  );
  const graph = featureHistory(manager.document);
  expect([...graph.missing.get(features[2]!.featureId)!]).toEqual(['body']);
});

it('tracks the second result of a split as a dependency', () => {
  const { manager, features } = historyFixture();
  const bodyId = manager.document.bodyOrder.at(-1)!;
  manager.execute(
    commandFactories.splitBody({
      name: 'Split plate',
      targetBodyId: bodyId,
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    })
  );
  const split = listFeaturesInOrder(manager.document).at(-1)!;
  if (split.data.featureKind !== 'split') throw new Error('Expected split');
  manager.execute(
    commandFactories.transformBody({
      name: 'Move second half',
      targetBodyId: split.data.secondBodyId,
      translation: { x: 0, y: 10, z: 0 }
    })
  );
  const graph = featureHistory(manager.document);
  expect(
    graph.downstream(features[0]!.featureId).map((feature) => feature.name)
  ).toContain('Move second half');
  expect([...graph.parents.get(graph.features.at(-1)!.featureId)!]).toEqual([
    split.featureId
  ]);
  expect(featureResultBodyIds(split)).toEqual([
    split.bodyId,
    split.data.secondBodyId
  ]);
  expect(featureResultBodyIds(graph.features.at(-1)!)).toEqual([
    split.data.secondBodyId
  ]);
});

it('makes a guide rail sketch a parent of the sweep it steers', () => {
  // The rail is a sketch input to the sweep. Without it in the graph the
  // delete toast under-counts the sweep's dependents and the history panel
  // does not mark the rail sketch as one of its parents.
  const manager = new CommandManager(
    createProjectDocument('Guided', toUserId('user_guided'))
  );
  manager.execute(
    commandFactories.addSketch({
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
    })
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Path',
      plane: 'XZ',
      offset: 0,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    })
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Rail',
      plane: 'XZ',
      offset: 10,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    })
  );
  const [profileSketchId, pathSketchId, railSketchId] =
    manager.document.sketchOrder;
  const entityIds = (sketchId: typeof profileSketchId) =>
    findSketch(manager.document, sketchId!)!.objectIds;
  manager.execute(
    commandFactories.sweepProfile({
      name: 'Guided sweep',
      profile: {
        sketchId: profileSketchId!,
        profile: {
          profileId: 'profile_1',
          regionFingerprint: 1,
          samplePoint: { x: 0, y: 0 },
          sourceArea: 8,
          sourceEntityIds: entityIds(profileSketchId)
        }
      },
      path: { sketchId: pathSketchId!, entityIds: entityIds(pathSketchId) },
      mode: 'standard',
      guide: { sketchId: railSketchId!, entityIds: entityIds(railSketchId) }
    })
  );

  const graph = featureHistory(manager.document);
  const named = (name: string) =>
    graph.features.find((feature) => feature.name === name)!.featureId;
  expect([...graph.parents.get(named('Guided sweep'))!].sort()).toEqual(
    [named('Profile'), named('Path'), named('Rail')].sort()
  );
  expect(
    graph.downstream(named('Rail')).map((feature) => feature.name)
  ).toEqual(['Guided sweep']);
});

it('makes the drilled body a dependent of the body a hole consumes', () => {
  // Without a hole case, Box read "Nothing later depends on it" and deleting
  // it skipped the dependent-delete confirmation.
  const manager = new CommandManager(
    createProjectDocument('Drilled', toUserId('user_drilled'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 20, depth: 10 }
    })
  );
  manager.execute(
    commandFactories.holeBody({
      name: 'Hole',
      targetBodyId: manager.document.bodyOrder.at(-1)!,
      faceHash: 1,
      style: 'simple',
      diameter: 5,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    })
  );
  manager.execute(
    commandFactories.filletEdges({
      name: 'Fillet',
      targetBodyId: manager.document.bodyOrder.at(-1)!,
      edgeHashes: [123],
      size: 1
    })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Unrelated',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 5, depth: 5 }
    })
  );
  const graph = featureHistory(manager.document);
  const [box, hole, fillet] = graph.features;
  expect(graph.downstream(box!.featureId).map((f) => f.name)).toEqual([
    'Hole',
    'Fillet'
  ]);
  expect([...graph.parents.get(hole!.featureId)!]).toEqual([box!.featureId]);
  expect([...graph.parents.get(fillet!.featureId)!]).toEqual([hole!.featureId]);
  expect([...graph.missing.get(hole!.featureId)!]).toEqual([]);
});

describe('bodies a Move rebuilds', () => {
  it('follows a moved sketch into the extrude it drives and what is built on it', () => {
    const { manager } = historyFixture();
    const sketchId = manager.document.sketchOrder[0]!;
    const plate = manager.document.bodyOrder[0]!;
    const rounded = featureResultBodyIds(
      listFeaturesInOrder(manager.document).at(-1)!
    )[0]!;
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Unrelated',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 5, depth: 5 }
      })
    );
    // The extrude and everything built on it (the move and the fillet), and
    // not the unrelated box.
    expect(
      bodiesRebuiltByMove(manager.document, { kind: 'sketch', sketchId })
    ).toEqual(new Set([plate, rounded]));
  });

  it('follows a moved body into the features built on it', () => {
    const manager = new CommandManager(
      createProjectDocument('Downstream', toUserId('user_test'))
    );
    for (const name of ['Lower', 'Upper']) {
      manager.execute(
        commandFactories.addPrimitive({
          name,
          primitiveKind: 'box',
          dimensions: { width: 5, height: 5, depth: 5 }
        })
      );
    }
    const [lower, upper] = manager.document.bodyOrder as [BodyId, BodyId];
    manager.execute(
      commandFactories.mirrorBody({
        name: 'Mirror lower',
        targetBodyId: lower,
        plane: { origin: { x: 20, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
      })
    );
    const mirrored = manager.document.bodyOrder.at(-1)!;
    expect(mirrored).not.toBe(lower);
    const rebuilt = bodiesRebuiltByMove(manager.document, {
      kind: 'body',
      bodyId: lower
    });
    expect(rebuilt.has(lower)).toBe(true);
    expect(rebuilt.has(mirrored)).toBe(true);
    expect(rebuilt.has(upper)).toBe(false);
  });
});
