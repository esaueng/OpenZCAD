import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  renameNode,
  setNodeMetadata
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import { useDirectEditCommit } from './useDirectEditCommit';

function body(bodyId: BodyId, name: string): BodyRepresentation {
  return {
    bodyId,
    name,
    source: 'primitive',
    color: '#56b4e9',
    consumed: false,
    exportableStep: true,
    mesh: { kind: 'mesh', vertices: Float32Array.from([]), indices: Uint32Array.from([]) },
    faceCount: 3,
    volume: 1,
    bbox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 }
    }
  };
}

function filletedCylinder() {
  const cylinder = addPrimitiveFeature(
    createProjectDocument('Filleted drag', toUserId('user_filleted_drag')),
    {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4.6, height: 12 }
    }
  );
  const sourceBodyId = cylinder.bodyOrder[0]!;
  const sourceFeature = listFeaturesInOrder(cylinder)[0]!;
  const fillet = filletEdges(cylinder, {
    name: 'Two rim fillet',
    targetBodyId: sourceBodyId,
    edgeHashes: [101, 202],
    size: 1
  });
  const filletFeature = listFeaturesInOrder(fillet.document).at(-1)!;
  return { cylinder, sourceBodyId, sourceFeature, fillet, filletFeature };
}

describe('direct manipulation commit', () => {
  it('commits one primitive history edit after validating its derived fillet', async () => {
    const { sourceBodyId, sourceFeature, fillet } = filletedCylinder();
    const manager = new CommandManager(fillet.document);
    const command = commandFactories.updateFeature(
      {
        featureId: sourceFeature.featureId,
        data: { dimensions: { radius: 6.4 } }
      },
      'Resize Cylinder Radius'
    );
    const onCommitted = vi.fn();
    const { result } = renderHook(() =>
      useDirectEditCommit({
        manager: () => manager,
        derive: async (
          candidate: ProjectDocument
        ): Promise<ProjectDocument['derived']> => ({
          bodyRepresentations: {
            [sourceBodyId]: body(sourceBodyId, 'Cylinder'),
            [fillet.bodyId]: body(fillet.bodyId, 'Two rim fillet')
          },
          exportableBodyIds: [fillet.bodyId],
          warnings: [],
          updatedAt: candidate.derived.updatedAt
        }),
        commit: (candidate) => {
          manager.execute(candidate);
          return true;
        },
        onValidationStart: vi.fn(),
        onValidationFailed: vi.fn(),
        onCommitted,
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );

    let applied = false;
    await act(async () => {
      applied = await result.current.run(
        command,
        fillet.bodyId,
        'Adjusted cylinder radius.',
        6.4,
        undefined,
        [
          { featureName: 'Cylinder', resultBodyId: sourceBodyId },
          { featureName: 'Two rim fillet', resultBodyId: fillet.bodyId }
        ]
      );
    });

    expect(applied).toBe(true);
    expect(onCommitted).toHaveBeenCalledWith(fillet.bodyId);
    expect(listFeaturesInOrder(manager.document)).toHaveLength(2);
    expect(listFeaturesInOrder(manager.document)[0]!.data).toMatchObject({
      dimensions: { radius: 6.4, height: 12 }
    });
    expect(manager.canUndo).toBe(true);
    const undone = manager.undo();
    expect(listFeaturesInOrder(undone)).toHaveLength(2);
    expect(listFeaturesInOrder(undone)[0]!.data).toMatchObject({
      dimensions: { radius: 4.6, height: 12 }
    });
  });

  it('reports a downstream blend failure without changing document history', async () => {
    const { sourceBodyId, sourceFeature, fillet, filletFeature } =
      filletedCylinder();
    const manager = new CommandManager(fillet.document);
    const before = structuredClone(manager.document);
    const command = commandFactories.updateFeature(
      {
        featureId: sourceFeature.featureId,
        data: { dimensions: { radius: 0.5 } }
      },
      'Resize Cylinder Radius'
    );
    const onValidationFailed = vi.fn();
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useDirectEditCommit({
        manager: () => manager,
        derive: async (
          candidate: ProjectDocument
        ): Promise<ProjectDocument['derived']> => ({
          bodyRepresentations: {
            [sourceBodyId]: body(sourceBodyId, 'Cylinder')
          },
          exportableBodyIds: [sourceBodyId],
          warnings: [
            'Feature "Two rim fillet": Fillet could not be created on 2 selected edges with radius 1.'
          ],
          updatedAt: candidate.derived.updatedAt
        }),
        commit: vi.fn(() => true),
        onValidationStart: vi.fn(),
        onValidationFailed,
        onCommitted: vi.fn(),
        onBusy: vi.fn(),
        onStatus
      })
    );

    let applied = true;
    await act(async () => {
      applied = await result.current.run(
        command,
        fillet.bodyId,
        'Adjusted cylinder radius.',
        0.5,
        undefined,
        [
          {
            featureName: 'Cylinder',
            featureId: sourceFeature.featureId,
            resultBodyId: sourceBodyId
          },
          {
            featureName: 'Two rim fillet',
            featureId: filletFeature.featureId,
            resultBodyId: fillet.bodyId
          }
        ]
      );
    });

    expect(applied).toBe(false);
    expect(manager.document).toEqual(before);
    expect(manager.canUndo).toBe(false);
    // The refusal names the existing feature that could not be rebuilt, so the
    // panel can offer to open it rather than describing it in prose.
    expect(onValidationFailed).toHaveBeenCalledWith(
      {
        message:
          'Fillet could not be created on 2 selected edges with radius 1.',
        culprit: {
          featureId: filletFeature.featureId,
          featureName: 'Two rim fillet'
        }
      },
      0.5
    );
    // One owner per diagnostic: the running command shows the rejection at the
    // handle that caused it, and the status line is not handed a second copy
    // that can go stale while the value moves on.
    expect(
      onStatus.mock.calls.flat().filter((message) =>
        String(message).includes('Fillet could not be created')
      )
    ).toEqual([]);
  });

  it('ignores an unrelated suppressed feature with the same name as a validation target', async () => {
    const { sourceBodyId, sourceFeature, fillet, filletFeature } =
      filletedCylinder();
    let document = renameNode(fillet.document, {
      nodeId: sourceFeature.id,
      name: 'Shared name'
    });
    document = renameNode(document, {
      nodeId: filletFeature.id,
      name: 'Shared name'
    });
    document = setNodeMetadata(document, {
      nodeId: filletFeature.id,
      metadata: { suppressed: true }
    });
    const manager = new CommandManager(document);
    const command = commandFactories.updateFeature(
      {
        featureId: sourceFeature.featureId,
        data: { dimensions: { radius: 6.4 } }
      },
      'Resize Cylinder Radius'
    );
    const suppression =
      'Feature "Shared name": Suppressed; skipped during exact rebuild.';
    const onValidationFailed = vi.fn();
    const { result } = renderHook(() =>
      useDirectEditCommit({
        manager: () => manager,
        derive: async (
          candidate: ProjectDocument
        ): Promise<ProjectDocument['derived']> => ({
          bodyRepresentations: {
            [sourceBodyId]: body(sourceBodyId, 'Shared name')
          },
          exportableBodyIds: [sourceBodyId],
          warnings: [suppression],
          featureWarnings: [
            {
              featureId: filletFeature.featureId,
              featureName: 'Shared name',
              message: suppression,
              kind: 'suppressed'
            }
          ],
          updatedAt: candidate.derived.updatedAt
        }),
        commit: (candidate) => {
          manager.execute(candidate);
          return true;
        },
        onValidationStart: vi.fn(),
        onValidationFailed,
        onCommitted: vi.fn(),
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );

    let applied = false;
    await act(async () => {
      applied = await result.current.run(
        command,
        sourceBodyId,
        'Adjusted cylinder radius.',
        6.4,
        undefined,
        [
          {
            featureName: 'Shared name',
            featureId: sourceFeature.featureId,
            resultBodyId: sourceBodyId
          }
        ]
      );
    });

    expect(applied).toBe(true);
    expect(onValidationFailed).not.toHaveBeenCalled();
    expect(listFeaturesInOrder(manager.document)[0]!.data).toMatchObject({
      dimensions: { radius: 6.4, height: 12 }
    });
  });
});
