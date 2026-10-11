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
  type FeatureId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import {
  useValidatedFeatureCommit,
  type ValidatedFeatureCommitOptions
} from '../hooks/useValidatedFeatureCommit';
import type { FeatureBuildError } from './featureValidation';
import {
  activeSuppressionPrompt,
  FeatureSuppressionRefusal,
  resolveSuppressionBranch,
  suppressBranchLabel,
  suppressCommands,
  suppressedBranchMessage,
  suppressionRefusal,
  suppressionRefusalMessage,
  validateFeatureSuppression
} from './featureSuppression';

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

/** Each refused dependent as `"Name": reason`, the reason kept for logs. */
function refused(
  document: ProjectDocument,
  derived: ProjectDocument['derived'],
  source: FeatureNode
): string[] {
  return (
    suppressionRefusal(document, derived, source)?.dependents.map(
      ({ name, reason }) => `"${name}": ${reason}`
    ) ?? []
  );
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
    // One plain sentence: names only, no kernel reasons and no body ids.
    expect(onFailure).toHaveBeenCalledWith(
      '"Source" is used by 2 later features that cannot rebuild without it: "Copy" and "Move copy".'
    );
    // Filed under the feature the user acted on, not its first dependent.
    const rejection = onRejection.mock.calls[0]![0];
    expect(rejection).toBeInstanceOf(FeatureSuppressionRefusal);
    expect(rejection.featureId).toBe(feature.featureId);
    expect(rejection.featureName).toBe('Source');
    expect(
      (rejection as FeatureSuppressionRefusal).dependents.map(
        ({ featureId, reason }) => [featureId, reason]
      )
    ).toEqual([
      [dependent.featureId, 'Target is unavailable.'],
      [move.featureId, 'Target is unavailable.']
    ]);
  });

  it('suppresses the source and its refused dependents in one undoable step', async () => {
    const { manager, feature, dependent, move, derived } = chain();
    const before = manager.document;
    const branch = resolveSuppressionBranch(before, feature.featureId, [
      move.featureId,
      dependent.featureId
    ]);
    expect(branch.features.map((item) => item.name)).toEqual([
      'Source',
      'Move copy',
      'Copy'
    ]);
    const label = suppressBranchLabel('Source', branch.features.length - 1);
    expect(label).toBe('Suppress Source and 2 later features');
    const commitTransaction = vi.fn<
      ValidatedFeatureCommitOptions['commitTransaction']
    >((label, commands) => {
      manager.runTransaction(label, commands);
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
        await result.current.runTransaction(
          suppressCommands(branch.features, label),
          {
            label,
            targets: [],
            validateDerived: (candidate) =>
              validateFeatureSuppression(before, candidate, branch.features),
            successMessage: suppressedBranchMessage('Source', 2)
          }
        )
      ).toBe('committed');
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(
      listFeaturesInOrder(manager.document).slice(0, 3).map(isFeatureSuppressed)
    ).toEqual([true, true, true]);
    manager.undo();
    expect(
      listFeaturesInOrder(manager.document).slice(0, 3).map(isFeatureSuppressed)
    ).toEqual([false, false, false]);
  });

  it('skips already suppressed and deleted features when resolving a branch', () => {
    const { manager, feature, dependent, move } = chain();
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: move.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      })
    );
    const branch = resolveSuppressionBranch(
      manager.document,
      feature.featureId,
      [dependent.featureId, move.featureId, 'feat_gone' as FeatureId]
    );
    expect(branch.source?.featureId).toBe(feature.featureId);
    expect(branch.features.map((item) => item.name)).toEqual([
      'Source',
      'Copy',
      'Move copy'
    ]);
    // Move copy is suppressed already, so it needs no command.
    expect(suppressCommands(branch.features, 'Suppress')).toHaveLength(2);
    expect(
      resolveSuppressionBranch(manager.document, 'feat_gone' as FeatureId, [])
    ).toEqual({ source: null, features: [] });
  });

  it('names at most three dependents in the sentence and counts the rest', () => {
    expect(
      suppressionRefusalMessage(
        'Boss',
        ['Place', 'Union', 'Fillet', 'Hole', 'Chamfer'].map((name) => ({
          name
        }))
      )
    ).toBe(
      '"Boss" is used by 5 later features that cannot rebuild without it: "Place", "Union", "Fillet" and 2 more.'
    );
    expect(suppressionRefusalMessage('Boss', [{ name: 'Union' }])).toBe(
      '"Boss" is used by 1 later feature that cannot rebuild without it: "Union".'
    );
    expect(suppressedBranchMessage('Boss', 0)).toBe('Suppressed Boss');
    expect(suppressedBranchMessage('Boss', 1)).toBe(
      'Suppressed Boss and 1 later feature'
    );
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
    expect(refused(manager.document, derived, feature)).toContain(
      '"Move copy": Exact reference is stale.'
    );
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
    expect(refused(manager.document, derived, feature)).toContain(
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
    expect(refused(manager.document, derived, feature)).toContain(
      '"Attached profile": Attached face is stale.'
    );
  });
});

describe('suppression prompt scope', () => {
  // Codex P2 on #630: a prompt left pending across a project switch hid its
  // dialog but kept the new project's shortcuts and exact entry disabled.
  it('belongs only to the project that raised it', () => {
    const prompt = {
      projectId: 'project_a',
      featureId: 'feat_boss' as FeatureId,
      name: 'Boss',
      dependents: []
    };
    expect(activeSuppressionPrompt(prompt, 'project_a')).toBe(prompt);
    expect(activeSuppressionPrompt(prompt, 'project_b')).toBeNull();
    expect(activeSuppressionPrompt(prompt, undefined)).toBeNull();
    expect(activeSuppressionPrompt(null, 'project_a')).toBeNull();
  });
});
