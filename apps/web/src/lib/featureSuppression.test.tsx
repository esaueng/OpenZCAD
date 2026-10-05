import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createProjectDocument,
  createSplitFeatureIds,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  isFeatureSuppressed,
  toUserId,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  useValidatedFeatureCommit,
  type ValidatedFeatureCommitOptions
} from '../hooks/useValidatedFeatureCommit';
import type { FeatureBuildError } from './featureValidation';
import { validateFeatureSuppression } from './featureSuppression';

function chain() {
  const manager = new CommandManager(
    createProjectDocument(
      'Suppression',
      toUserId('user_suppression_validation')
    )
  );
  const source = createBodyFeatureIds();
  const copy = createBodyFeatureIds();
  manager.runTransaction('Chain', [
    commandFactories.addPrimitive({
      name: 'Source',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 },
      ids: source
    }),
    commandFactories.mirrorBody({
      name: 'Copy',
      targetBodyId: source.bodyId,
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
      ids: copy
    }),
    commandFactories.transformBody({
      name: 'Move copy',
      targetBodyId: copy.bodyId,
      translation: { x: 0, y: 0, z: 20 }
    })
  ]);
  const [feature, dependent, move] = listFeaturesInOrder(manager.document);
  const command = commandFactories.setNodeMetadata({
    nodeId: feature!.id,
    metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
  });
  const derived: ProjectDocument['derived'] = {
    ...manager.document.derived,
    bodyRepresentations: {},
    warnings: [],
    featureWarnings: []
  };
  return {
    manager,
    feature: feature!,
    dependent: dependent!,
    move: move!,
    command,
    derived,
    copy
  };
}

function body(
  bodyId: BodyId
): ProjectDocument['derived']['bodyRepresentations'][BodyId] {
  return {
    bodyId,
    name: 'Body',
    source: 'primitive',
    color: '#56b4e9',
    consumed: false,
    exportableStep: true,
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(),
      indices: new Uint32Array()
    },
    faceCount: 6,
    volume: 1000,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }
  };
}

describe('exact suppression preflight', () => {
  it('refuses atomically with every active dependent and its exact reason', async () => {
    const { manager, feature, dependent, move, command, derived } = chain();
    derived.featureWarnings = [dependent, move].map((item) => ({
      featureId: item.featureId,
      featureName: item.name,
      kind: 'build-failed',
      message: `Feature "${item.name}": Target is unavailable.`
    }));
    const before = manager.document;
    const commitTransaction = vi.fn(() => true);
    const onFailure = vi.fn();
    const onRejection = vi.fn<(error: FeatureBuildError) => void>();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async () => derived,
        commit: vi.fn(),
        commitTransaction,
        onBusy: vi.fn(),
        onStatus: vi.fn(),
        onRejection
      })
    );
    await act(async () => {
      expect(
        await result.current.runTransaction([command], {
          label: 'Suppress Source',
          targets: [],
          validateDerived: (candidate) =>
            validateFeatureSuppression(before, candidate, feature),
          successMessage: 'Suppressed Source',
          onFailure
        })
      ).toBe('rejected');
    });
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(manager.document).toBe(before);
    expect(isFeatureSuppressed(listFeaturesInOrder(manager.document)[0]!)).toBe(
      false
    );
    expect(onFailure).toHaveBeenCalledWith(
      'Cannot suppress "Source". Dependent features cannot rebuild: "Copy": Target is unavailable.; "Move copy": Target is unavailable.'
    );
    expect(onRejection.mock.calls[0]![0].featureId).toBe(dependent.featureId);
  });

  it('commits a validated suppression once, with undo restoring the previous history', async () => {
    const { manager, feature, command, derived, copy } = chain();
    derived.bodyRepresentations[copy.bodyId] = body(copy.bodyId);
    const before = manager.document;
    const commitTransaction = vi.fn<
      ValidatedFeatureCommitOptions['commitTransaction']
    >((label, commands, exact) => {
      manager.runTransaction(label, commands);
      if (exact) manager.commitDerivedState(exact);
      return true;
    });
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async () => derived,
        commit: vi.fn(),
        commitTransaction,
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );
    await act(async () => {
      expect(
        await result.current.runTransaction([command], {
          label: 'Suppress Source',
          targets: [],
          validateDerived: (candidate) =>
            validateFeatureSuppression(before, candidate, feature),
          successMessage: 'Suppressed Source'
        })
      ).toBe('committed');
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(isFeatureSuppressed(listFeaturesInOrder(manager.document)[0]!)).toBe(
      true
    );
    manager.undo();
    expect(isFeatureSuppressed(listFeaturesInOrder(manager.document)[0]!)).toBe(
      false
    );
  });

  it('does not commit when the document changes during the exact check', async () => {
    const { manager, feature, command, derived, copy } = chain();
    derived.bodyRepresentations[copy.bodyId] = body(copy.bodyId);
    const before = manager.document;
    const commitTransaction = vi.fn(() => true);
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async () => {
          manager.execute(
            commandFactories.setNodeMetadata({
              nodeId: feature.id,
              metadata: { color: '#ffffff' }
            })
          );
          return derived;
        },
        commit: vi.fn(),
        commitTransaction,
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );
    await act(async () => {
      expect(
        await result.current.runTransaction([command], {
          label: 'Suppress Source',
          targets: [],
          validateDerived: (candidate) =>
            validateFeatureSuppression(before, candidate, feature),
          successMessage: 'Suppressed Source'
        })
      ).toBe('rejected');
    });
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(isFeatureSuppressed(listFeaturesInOrder(manager.document)[0]!)).toBe(
      false
    );
  });

  it('uses feature IDs for refusal attribution, checks in-place edits and ignores paused dependents', () => {
    const { manager, feature, dependent, move, derived, copy } = chain();
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Copy',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    const unrelated = listFeaturesInOrder(manager.document).at(-1)!;
    derived.bodyRepresentations[copy.bodyId] = body(copy.bodyId);
    derived.featureWarnings = [
      {
        featureId: unrelated.featureId,
        featureName: 'Copy',
        kind: 'build-failed',
        message: 'Feature "Copy": Unrelated failure.'
      }
    ];
    expect(() =>
      validateFeatureSuppression(manager.document, derived, feature)
    ).not.toThrow();
    derived.featureWarnings.push({
      featureId: move.featureId,
      featureName: move.name,
      kind: 'refusal',
      message: 'Feature "Move copy": Exact reference is stale.'
    });
    expect(() =>
      validateFeatureSuppression(manager.document, derived, feature)
    ).toThrow('"Move copy": Exact reference is stale.');
    manager.runTransaction(
      'Pause dependents',
      [dependent, move].map((item) =>
        commandFactories.setNodeMetadata({
          nodeId: item.id,
          metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
        })
      )
    );
    expect(() =>
      validateFeatureSuppression(manager.document, derived, feature)
    ).not.toThrow();
  });

  it('requires both results of a dependent split', () => {
    const { manager, feature, derived, copy } = chain();
    const split = createSplitFeatureIds();
    manager.execute(
      commandFactories.splitBody({
        name: 'Split copy',
        targetBodyId: copy.bodyId,
        plane: { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
        ids: split
      })
    );
    derived.bodyRepresentations[copy.bodyId] = body(copy.bodyId);
    derived.bodyRepresentations[split.bodyId] = body(split.bodyId);
    expect(() =>
      validateFeatureSuppression(manager.document, derived, feature)
    ).toThrow(
      '"Split copy": The dependent feature did not produce its result body.'
    );
    derived.bodyRepresentations[split.secondBodyId] = body(split.secondBodyId);
    expect(() =>
      validateFeatureSuppression(manager.document, derived, feature)
    ).not.toThrow();
  });

  it('refuses an attached sketch failure even though sketches have no result body', () => {
    const { manager, feature, derived, copy } = chain();
    manager.execute(
      commandFactories.addSketch({
        name: 'Attached profile',
        planeRef: {
          type: 'face',
          bodyId: copy.bodyId,
          faceHash: 123,
          sourceArea: 100,
          sourceCenter: { x: 0, y: 0, z: 5 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          frame: {
            origin: { x: 0, y: 0, z: 5 },
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: { x: 0, y: 0, z: 1 }
          }
        },
        objects: []
      })
    );
    const sketch = listFeaturesInOrder(manager.document).at(-1)!;
    expect(sketch.bodyId).toBeUndefined();
    derived.bodyRepresentations[copy.bodyId] = body(copy.bodyId);
    derived.featureWarnings = [
      {
        featureId: sketch.featureId,
        featureName: sketch.name,
        kind: 'build-failed',
        message: 'Feature "Attached profile": Attached face is stale.'
      }
    ];
    expect(() =>
      validateFeatureSuppression(manager.document, derived, feature)
    ).toThrow('"Attached profile": Attached face is stale.');
  });
});
