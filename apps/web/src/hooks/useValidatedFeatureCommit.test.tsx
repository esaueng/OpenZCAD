import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { useValidatedFeatureCommit } from './useValidatedFeatureCommit';

const TANGENT_BOSS_DIAGNOSTIC =
  'Union dropped geometry from operand "Boss Body": the result\'s maximum z is 8 mm, but the operand reaches 16 mm (8 mm missing). A cylindrical boss can trigger this kernel failure at exact tangency; move the operand slightly off tangency while keeping positive overlap, then try again.';

describe('validated feature commit', () => {
  it('keeps a tangent-boss failure out of document history and shows its exact diagnostic', async () => {
    const withPlate = addPrimitiveFeature(
      createProjectDocument('Tangent boss', toUserId('user_tangent_boss')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 60, height: 40, depth: 8 }
      }
    );
    const plateId = withPlate.bodyOrder.at(-1)!;
    const withBoss = addPrimitiveFeature(withPlate, {
      name: 'Boss',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height: 16 }
    });
    const bossId = withBoss.bodyOrder.at(-1)!;
    const manager = new CommandManager(withBoss);
    const command = commandFactories.booleanBodies({
      name: 'Tangent boss union',
      operation: 'union',
      targetBodyIds: [plateId, bossId]
    });
    const resultBodyId = command.payload.ids!.bodyId;
    const before = structuredClone(manager.document);
    const commit = vi.fn(() => true);
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async (
          candidate: ProjectDocument
        ): Promise<ProjectDocument['derived']> => ({
          bodyRepresentations: {
            [resultBodyId]: {
              bodyId: resultBodyId,
              name: 'Tangent boss union',
              source: 'boolean',
              color: '#ff7452',
              consumed: false,
              exportableStep: true,
              mesh: { kind: 'mesh', vertices: [], indices: [] },
              faceCount: 6,
              volume: 19_200,
              bbox: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 60, y: 40, z: 8 }
              }
            }
          },
          exportableBodyIds: [resultBodyId],
          warnings: [
            `Feature "Tangent boss union": ${TANGENT_BOSS_DIAGNOSTIC}`
          ],
          updatedAt: candidate.derived.updatedAt
        }),
        commit,
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus
      })
    );

    let applied = true;
    await act(async () => {
      applied = await result.current.run(command, {
        featureName: 'Tangent boss union',
        resultBodyId,
        successMessage: command.label
      });
    });

    expect(applied).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(manager.document).toEqual(before);
    expect(manager.canUndo).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith(TANGENT_BOSS_DIAGNOSTIC);
  });

  it('rejects a primitive edit when an affected downstream fillet fails', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Fillet resize', toUserId('user_fillet_resize')),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 4.6, height: 12 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const sourceFeature = listFeaturesInOrder(base)[0]!;
    const filleted = filletEdges(base, {
      name: 'Two rim fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [101, 202],
      size: 1
    });
    const manager = new CommandManager(filleted.document);
    const command = commandFactories.updateFeature(
      {
        featureId: sourceFeature.featureId,
        data: { dimensions: { radius: 0.5 } }
      },
      'Resize cylinder radius'
    );
    const before = structuredClone(manager.document);
    const commit = vi.fn(() => true);
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async (
          candidate: ProjectDocument
        ): Promise<ProjectDocument['derived']> => ({
          bodyRepresentations: {
            [sourceBodyId]: {
              bodyId: sourceBodyId,
              name: 'Cylinder',
              source: 'primitive',
              color: '#56b4e9',
              consumed: false,
              exportableStep: true,
              mesh: { kind: 'mesh', vertices: [], indices: [] },
              faceCount: 3,
              volume: Math.PI * 0.5 ** 2 * 12,
              bbox: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 1, y: 1, z: 12 }
              }
            }
          },
          exportableBodyIds: [sourceBodyId],
          warnings: [
            'Feature "Two rim fillet": Fillet could not be created on 2 selected edges with radius 1.'
          ],
          updatedAt: candidate.derived.updatedAt
        }),
        commit,
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus
      })
    );

    let applied = true;
    await act(async () => {
      applied = await result.current.run(command, {
        featureName: 'Cylinder',
        resultBodyId: sourceBodyId,
        targets: [
          { featureName: 'Cylinder', resultBodyId: sourceBodyId },
          { featureName: 'Two rim fillet', resultBodyId: filleted.bodyId }
        ],
        successMessage: command.label
      });
    });

    expect(applied).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(manager.document).toEqual(before);
    expect(manager.canUndo).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith(
      'Fillet could not be created on 2 selected edges with radius 1.'
    );
  });
});
