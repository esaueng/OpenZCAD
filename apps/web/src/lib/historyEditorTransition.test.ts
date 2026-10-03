import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { resolveHistoryEditorFeature } from './historyEditorTransition';

function pendingSplit() {
  const manager = new CommandManager(
    createProjectDocument('Pending history edit', toUserId('user_history_edit'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, depth: 20, height: 20 }
    })
  );
  manager.execute(
    commandFactories.splitBody({
      name: 'Original split',
      targetBodyId: manager.document.bodyOrder[0]!,
      plane: { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    })
  );
  const feature = listFeaturesInOrder(manager.document).find(
    (candidate) => candidate.data.featureKind === 'split'
  )!;
  return {
    manager,
    feature,
    request: {
      projectId: manager.document.projectId,
      featureId: feature.featureId
    }
  };
}

describe('resolveHistoryEditorFeature', () => {
  it('opens the current name and parameters when sync changed a pending feature', () => {
    const { manager, feature, request } = pendingSplit();
    manager.execute(
      commandFactories.updateFeature({
        featureId: request.featureId,
        name: 'Changed split',
        data: {
          plane: { origin: { x: 9, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
        }
      })
    );
    const current = resolveHistoryEditorFeature(manager.document, request);
    expect(current).not.toBe(feature);
    expect(current).toMatchObject({
      name: 'Changed split',
      data: { featureKind: 'split', plane: { origin: { x: 9, y: 0, z: 0 } } }
    });
    expect(feature.name).toBe('Original split');
  });

  it('refuses a feature deleted while its Move choice was pending', () => {
    const { manager, request } = pendingSplit();
    manager.execute(
      commandFactories.deleteFeature({ featureId: request.featureId })
    );
    expect(resolveHistoryEditorFeature(manager.document, request)).toBeNull();
  });

  it('refuses a current feature that cannot use a modeling editor', () => {
    const { manager, feature, request } = pendingSplit();
    const box = listFeaturesInOrder(manager.document)[0]!;
    expect(
      resolveHistoryEditorFeature(
        {
          ...manager.document,
          nodes: {
            ...manager.document.nodes,
            [feature.id]: {
              ...feature,
              featureKind: box.featureKind,
              data: box.data
            }
          }
        },
        request
      )
    ).toBeNull();
  });

  it('resolves the current editable kind instead of the originally requested tool', () => {
    const { manager, feature, request } = pendingSplit();
    const current = resolveHistoryEditorFeature(
      {
        ...manager.document,
        nodes: {
          ...manager.document.nodes,
          [feature.id]: {
            ...feature,
            name: 'Replacement shell',
            featureKind: 'shell',
            data: {
              featureKind: 'shell',
              targetBodyId: manager.document.bodyOrder[0]!,
              openingFaceHashes: [],
              thickness: 2
            }
          }
        }
      },
      request
    );
    expect(current).toMatchObject({
      name: 'Replacement shell',
      data: { featureKind: 'shell', thickness: 2 }
    });
  });

  it('refuses another project even if it carries the same feature ids', () => {
    const { manager, request } = pendingSplit();
    const other = createProjectDocument(
      'Other project',
      toUserId('user_history_edit')
    );
    expect(
      resolveHistoryEditorFeature(
        {
          ...manager.document,
          projectId: other.projectId
        },
        request
      )
    ).toBeNull();
    expect(resolveHistoryEditorFeature(null, request)).toBeNull();
  });
});
