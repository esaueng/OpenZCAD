import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  useValidatedFeatureCommit,
  type ValidatedFeatureOutcome
} from '../hooks/useValidatedFeatureCommit';
import {
  advanceEditCardSession,
  editCardFeatureId,
  editCardSessionMatches
} from './editCardLifecycle';

describe('editCardFeatureId', () => {
  it('names the Inspector card while no tool runs', () => {
    expect(
      editCardFeatureId({
        tool: null,
        inspectorFeatureId: 'box',
        modelingEditFeatureId: null
      })
    ).toBe('box');
  });

  it('names the reopened modeling form while its tool runs', () => {
    expect(
      editCardFeatureId({
        tool: 'hole',
        inspectorFeatureId: 'hole',
        modelingEditFeatureId: 'hole'
      })
    ).toBe('hole');
  });

  it('names nothing under a create card, so a late edit Apply cannot close it', () => {
    // A Box edit still validating when the user starts a Hole must not close
    // the Hole create card it lands on.
    expect(
      editCardFeatureId({
        tool: 'hole',
        inspectorFeatureId: 'box',
        modelingEditFeatureId: null
      })
    ).toBeNull();
    expect(
      editCardFeatureId({
        tool: 'box',
        inspectorFeatureId: 'box',
        modelingEditFeatureId: null
      })
    ).toBeNull();
  });
});

describe('edit card Apply sessions', () => {
  const box = {
    tool: null,
    inspectorFeatureId: 'box',
    modelingEditFeatureId: null
  };
  const closed = { ...box, inspectorFeatureId: null };

  it('keeps the session through rerenders and lets its successful Apply close it', () => {
    const started = advanceEditCardSession(null, box);
    const current = advanceEditCardSession(started, { ...box });
    expect(current).toBe(started);
    expect(editCardSessionMatches(current, started, 'box')).toBe(true);
  });

  it('preserves a reopened card when an earlier Apply for the same feature succeeds', () => {
    const started = advanceEditCardSession(null, box);
    const dismissed = advanceEditCardSession(started, closed);
    const reopened = advanceEditCardSession(dismissed, box);
    expect(reopened.featureId).toBe(started.featureId);
    expect(editCardSessionMatches(reopened, started, 'box')).toBe(false);
    expect(editCardSessionMatches(reopened, reopened, 'box')).toBe(true);
  });

  it('preserves another feature or a create card when an old edit Apply succeeds', () => {
    const started = advanceEditCardSession(null, box);
    const other = advanceEditCardSession(started, {
      ...box,
      inspectorFeatureId: 'cylinder'
    });
    expect(editCardSessionMatches(other, started, 'box')).toBe(false);
    const creating = advanceEditCardSession(other, {
      tool: 'hole',
      inspectorFeatureId: 'box',
      modelingEditFeatureId: null
    });
    expect(editCardSessionMatches(creating, started, 'box')).toBe(false);
  });

  it('distinguishes the Inspector and modeling cards for the same feature', () => {
    const started = advanceEditCardSession(null, {
      ...box,
      inspectorFeatureId: 'hole'
    });
    const editing = advanceEditCardSession(started, {
      tool: 'hole',
      inspectorFeatureId: 'hole',
      modelingEditFeatureId: 'hole'
    });
    expect(editing.featureId).toBe(started.featureId);
    expect(editCardSessionMatches(editing, started, 'hole')).toBe(false);
    expect(editCardSessionMatches(editing, editing, 'hole')).toBe(true);
  });

  it('never closes a card for a missing session or a different feature', () => {
    const current = advanceEditCardSession(null, box);
    expect(editCardSessionMatches(current, null, 'box')).toBe(false);
    expect(editCardSessionMatches(null, current, 'box')).toBe(false);
    expect(editCardSessionMatches(current, current, 'cylinder')).toBe(false);
  });

  it.each([false, true])(
    'commits the checked edit only while its original card is current (reopened=%s)',
    async (reopen) => {
      const manager = new CommandManager(
        createProjectDocument('Edit session', toUserId('user_edit_session'))
      );
      manager.execute(
        commandFactories.addPrimitive({
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: 30, height: 18, depth: 24 }
        })
      );
      const feature = listFeaturesInOrder(manager.document)[0]!;
      const bodyId = feature.bodyId!;
      const before = manager.document;
      const input = { ...box, inspectorFeatureId: feature.id };
      let current = advanceEditCardSession(null, input);
      const started = current;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const derive = vi.fn(async () => {
        await held;
        return {
          ...before.derived,
          bodyRepresentations: {
            [bodyId]: {
              bodyId,
              name: 'Box Body',
              source: 'primitive' as const,
              mesh: {
                kind: 'mesh' as const,
                vertices: new Float32Array(),
                indices: new Uint32Array()
              },
              faceCount: 6,
              color: '#ffffff',
              consumed: false,
              exportableStep: true,
              volume: 17_280,
              bbox: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 40, y: 24, z: 18 }
              }
            }
          },
          warnings: []
        };
      });
      const commit = vi.fn((command: AnyCommand) => {
        manager.execute(command);
        return true;
      });
      const onSuccess = vi.fn();
      const { result } = renderHook(() =>
        useValidatedFeatureCommit({
          manager: () => manager,
          derive,
          commit,
          commitTransaction: vi.fn(() => true),
          onBusy: vi.fn(),
          onStatus: vi.fn()
        })
      );
      let outcome: ValidatedFeatureOutcome | undefined;
      await act(async () => {
        const applying = result.current.run(
          commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { dimensions: { width: 40, height: 18, depth: 24 } }
          }),
          {
            featureName: feature.name,
            resultBodyId: bodyId,
            successMessage: 'Edited Box.',
            cancelled: () =>
              !editCardSessionMatches(current, started, feature.id),
            onSuccess
          }
        );
        await vi.waitFor(() => expect(derive).toHaveBeenCalledTimes(1));
        if (reopen) {
          current = advanceEditCardSession(current, closed);
          current = advanceEditCardSession(current, input);
        }
        release();
        outcome = await applying;
      });
      if (reopen) {
        // The checked result cannot change documentVersion and remount the
        // newly reopened card, so its fresh input remains untouched.
        expect(outcome).toBe('cancelled');
        expect(commit).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
        expect(manager.document).toBe(before);
      } else {
        expect(outcome).toBe('committed');
        expect(commit).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(listFeaturesInOrder(manager.document)[0]!.data).toMatchObject({
          dimensions: { width: 40 }
        });
      }
    }
  );
});
