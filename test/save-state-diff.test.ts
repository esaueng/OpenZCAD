import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  createSavePoint,
  diffSaveStates,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';

function base(): CommandManager {
  const manager = new CommandManager(
    createProjectDocument('Bracket', toUserId('user_diff'))
  );
  manager.execute(
    commandFactories.setParameter({ name: 'width', expression: '20' })
  );
  for (const name of ['Base', 'Lug'])
    manager.execute(
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 'width', height: 10, depth: 10 }
      })
    );
  return manager;
}

const feature = (document: ProjectDocument, name: string) =>
  listFeaturesInOrder(document).find((node) => node.name === name)!;

describe('L03 save-state diff', () => {
  it('finds nothing between a model and its own save point', () => {
    const manager = base();
    const before = manager.document;
    // A save point, a rename of it and the revision log are history, not model.
    const saved = createSavePoint(before, 'Manual save');
    expect(diffSaveStates(before, saved).identical).toBe(true);
  });

  it('names what was added, removed, renamed, suppressed and re-expressed', () => {
    const manager = base();
    const before = manager.document;
    const lug = feature(before, 'Lug');
    manager.execute(
      commandFactories.setParameter({ name: 'width', expression: '35' })
    );
    manager.execute(
      commandFactories.setParameter({ name: 'height', expression: '4' })
    );
    manager.execute(
      commandFactories.renameNode({
        nodeId: feature(manager.document, 'Base').id,
        name: 'Plate'
      })
    );
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: lug.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      })
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Pin',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 12 }
      })
    );
    const diff = diffSaveStates(before, manager.document);
    expect(diff.identical).toBe(false);
    expect(diff.features.added.map((item) => item.name)).toEqual(['Pin']);
    expect(diff.features.removed).toEqual([]);
    expect(diff.features.changed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Plate',
          changes: ['renamed from “Base”']
        }),
        expect.objectContaining({ name: 'Lug', changes: ['suppressed'] })
      ])
    );
    expect(diff.features.reordered).toBe(false);
    expect(diff.parameters).toEqual(
      expect.arrayContaining([
        { name: 'width', before: '20', after: '35' },
        { name: 'height', before: null, after: '4' }
      ])
    );
    expect(diff.bodies.added).toHaveLength(1);

    // The other way round reads as the opposite change.
    const back = diffSaveStates(manager.document, before);
    expect(back.features.removed.map((item) => item.name)).toEqual(['Pin']);
    expect(back.parameters).toEqual(
      expect.arrayContaining([
        { name: 'width', before: '35', after: '20' },
        { name: 'height', before: '4', after: null }
      ])
    );
    expect(back.features.changed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Lug', changes: ['unsuppressed'] })
      ])
    );
  });

  it('reports an edited feature, a deletion, a reorder and a project rename', () => {
    const manager = base();
    const before = manager.document;
    const baseFeature = feature(before, 'Base');
    const lug = feature(before, 'Lug');
    manager.execute(
      commandFactories.updateFeature({
        featureId: baseFeature.featureId,
        data: { dimensions: { width: 'width', height: 15, depth: 10 } }
      })
    );
    manager.execute(
      commandFactories.moveFeature({ featureId: lug.featureId, toIndex: 0 })
    );
    const reordered = diffSaveStates(before, manager.document);
    expect(reordered.features.reordered).toBe(true);
    expect(reordered.features.changed).toEqual([
      expect.objectContaining({ name: 'Base', changes: ['edited'] })
    ]);
    manager.execute(
      commandFactories.deleteFeature({ featureId: lug.featureId })
    );
    manager.execute(
      commandFactories.renameNode({
        nodeId: manager.document.rootNodeId,
        name: 'Bracket v2'
      })
    );
    const diff = diffSaveStates(before, manager.document);
    expect(diff.features.removed.map((item) => item.name)).toEqual(['Lug']);
    expect(diff.bodies.removed).toHaveLength(1);
    expect(diff.properties).toEqual([
      { field: 'name', before: 'Bracket', after: 'Bracket v2' }
    ]);
  });
});
