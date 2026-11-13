import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  isFeatureRollbackSuppressed,
  isFeatureSuppressed,
  toUserId,
  type BodyId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { useValidatedFeatureCommit } from '../hooks/useValidatedFeatureCommit';
import { FeatureBuildError } from './featureValidation';
import {
  activeResumePrompt,
  failingFeatureIds,
  HistoryResumeRefusal,
  resumeFailures,
  resumeRefusalMessage,
  rollbackMarkerMove,
  rowResume,
  rowResumeAlreadyFailing,
  validateHistoryResume
} from './historyResume';

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

/** Box → Mirror → Move copy, rolled back after the box. */
function rolledBackChain(options: { suppressMove?: boolean } = {}) {
  const manager = new CommandManager(
    createProjectDocument('Resume', toUserId('user_history_resume'))
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
  const built = listFeaturesInOrder(manager.document);
  if (options.suppressMove) {
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: built[2]!.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      })
    );
  }
  const rollback = rollbackMarkerMove(listFeaturesInOrder(manager.document), 0);
  manager.runTransaction('Roll back after Source', rollback.commands);
  const features = listFeaturesInOrder(manager.document);
  const derived: ProjectDocument['derived'] = {
    ...manager.document.derived,
    bodyRepresentations: {
      [source.bodyId]: body(source.bodyId),
      [copy.bodyId]: body(copy.bodyId)
    },
    warnings: [],
    featureWarnings: []
  };
  return { manager, features, derived, rollback, copyBodyId: copy.bodyId };
}

function failed(
  feature: FeatureNode,
  message: string
): NonNullable<ProjectDocument['derived']['featureWarnings']>[number] {
  return {
    featureId: feature.featureId,
    featureName: feature.name,
    kind: 'build-failed',
    message: `Feature "${feature.name}": ${message}`
  };
}

describe('rollbackMarkerMove', () => {
  it('pauses the later suffix and resumes it as one set of metadata commands', () => {
    const { features, rollback } = rolledBackChain();
    expect(rollback.paused.map((feature) => feature.name)).toEqual([
      'Copy',
      'Move copy'
    ]);
    expect(rollback.resumed).toEqual([]);
    expect(features.map(isFeatureRollbackSuppressed)).toEqual([
      false,
      true,
      true
    ]);

    const resume = rollbackMarkerMove(features, null);
    expect(resume.paused).toEqual([]);
    expect(resume.resumed.map((feature) => feature.name)).toEqual([
      'Copy',
      'Move copy'
    ]);
    expect(resume.commands.map((command) => command.label)).toEqual([
      'Resume Copy',
      'Resume Move copy'
    ]);
  });

  it('moving the marker later resumes only the steps it passes', () => {
    const { features } = rolledBackChain();
    const move = rollbackMarkerMove(features, 1);
    expect(move.resumed.map((feature) => feature.name)).toEqual(['Copy']);
    expect(move.paused).toEqual([]);
    expect(move.commands).toHaveLength(1);
  });

  it('moving the marker earlier only pauses, so it needs no check', () => {
    const { manager, features } = rolledBackChain();
    manager.runTransaction(
      'Resume',
      rollbackMarkerMove(features, null).commands
    );
    const move = rollbackMarkerMove(listFeaturesInOrder(manager.document), 1);
    expect(move.resumed).toEqual([]);
    expect(move.paused.map((feature) => feature.name)).toEqual(['Move copy']);
  });

  it('does not count a step the user also suppressed as resumed', () => {
    const { features } = rolledBackChain({ suppressMove: true });
    const resume = rollbackMarkerMove(features, null);
    // Its rollback key is still cleared, but it stays out of the build.
    expect(resume.commands).toHaveLength(2);
    expect(resume.resumed.map((feature) => feature.name)).toEqual(['Copy']);
    expect(
      resume.commands.every(
        (command) =>
          command.kind === 'node.metadata.set' &&
          JSON.stringify(command.payload).includes(
            FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY
          )
      )
    ).toBe(true);
  });
});

describe('resume preflight decision', () => {
  it('reports each resumed feature that fails in the candidate, with its reason', () => {
    const { features, derived, copyBodyId } = rolledBackChain();
    const resumed = rollbackMarkerMove(features, null).resumed;
    const move = features[2];
    derived.featureWarnings = [
      failed(
        move!,
        'Direct-edit face is stale: The selected face lineage no longer exists.'
      )
    ];
    expect(resumeFailures(resumed, derived)).toEqual([
      {
        featureId: move!.featureId,
        name: 'Move copy',
        reason:
          'Direct-edit face is stale: The selected face lineage no longer exists.'
      }
    ]);
    // A step that produced no result body fails too.
    delete derived.bodyRepresentations[copyBodyId];
    expect(resumeFailures(resumed, derived).map((f) => f.name)).toEqual([
      'Copy',
      'Move copy'
    ]);
  });

  it('passes a clean candidate', () => {
    const { features, derived } = rolledBackChain();
    const resumed = rollbackMarkerMove(features, null).resumed;
    expect(resumeFailures(resumed, derived)).toEqual([]);
    expect(() => validateHistoryResume(resumed, derived)).not.toThrow();
  });

  it('ignores failures outside the resumed steps', () => {
    const { features, derived } = rolledBackChain();
    const resumed = rollbackMarkerMove(features, null).resumed;
    // The source was building before the resume and is not its doing.
    derived.featureWarnings = [failed(features[0]!, 'Unrelated failure.')];
    expect(resumeFailures(resumed, derived)).toEqual([]);
  });

  it('does not blame the resume for a step that was failing when it was paused', () => {
    const { features, derived } = rolledBackChain();
    const resumed = rollbackMarkerMove(features, null).resumed;
    const move = features[2]!;
    derived.featureWarnings = [failed(move, 'Already broken.')];
    const before = new Set(failingFeatureIds(resumed, derived));
    expect([...before]).toEqual([move.featureId]);
    expect(resumeFailures(resumed, derived, before)).toEqual([]);
  });

  it('refuses with a plain sentence, not a feature build error', () => {
    const { features, derived } = rolledBackChain();
    const resumed = rollbackMarkerMove(features, null).resumed;
    derived.featureWarnings = resumed.map((feature) =>
      failed(feature, 'Target is unavailable.')
    );
    let thrown: unknown;
    try {
      validateHistoryResume(resumed, derived);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HistoryResumeRefusal);
    expect(thrown).not.toBeInstanceOf(FeatureBuildError);
    expect((thrown as Error).message).toBe(
      'Resuming would leave 2 features unable to rebuild: "Copy" and "Move copy".'
    );
    expect(resumeRefusalMessage([{ name: 'Fillet 3' }])).toBe(
      'Resuming would leave 1 feature unable to rebuild: "Fillet 3".'
    );
  });

  it('keeps the rollback when the validated candidate fails, and commits a clean one', async () => {
    const { manager, features, derived } = rolledBackChain();
    const resume = rollbackMarkerMove(features, null);
    const before = manager.document;
    let candidate = derived;
    const commitTransaction = vi.fn(
      (
        label: string,
        commands: Parameters<CommandManager['runTransaction']>[1]
      ) => {
        manager.runTransaction(label, commands);
        return true;
      }
    );
    const onRejection = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async () => candidate,
        commit: vi.fn(),
        commitTransaction,
        onBusy: vi.fn(),
        onStatus: vi.fn(),
        onRejection
      })
    );
    const run = () =>
      result.current.runTransaction(resume.commands, {
        label: 'Resume full history',
        targets: [],
        validateDerived: (next) => validateHistoryResume(resume.resumed, next),
        successMessage: 'Full history resumed.',
        onFailure: vi.fn()
      });

    candidate = {
      ...derived,
      featureWarnings: [failed(features[2]!, 'Target is unavailable.')]
    };
    await act(async () => {
      expect(await run()).toBe('rejected');
    });
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(manager.document).toBe(before);
    // Answered by the resume dialog, so no History failure record.
    expect(onRejection).not.toHaveBeenCalled();

    candidate = derived;
    await act(async () => {
      expect(await run()).toBe('committed');
    });
    expect(commitTransaction).toHaveBeenCalledOnce();
    expect(
      listFeaturesInOrder(manager.document).some(isFeatureRollbackSuppressed)
    ).toBe(false);
  });
});

/** Source → Copy → Move copy, all resumed, then `row` suppressed by hand. */
function suppressedRow(row: 0 | 1 | 2) {
  const { manager, features, derived } = rolledBackChain();
  manager.runTransaction('Resume', rollbackMarkerMove(features, null).commands);
  manager.execute(
    commandFactories.setNodeMetadata({
      nodeId: listFeaturesInOrder(manager.document)[row]!.id,
      metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
    })
  );
  return { manager, features: listFeaturesInOrder(manager.document), derived };
}

describe('row resume preflight decision', () => {
  it('is null for a building row, whose toggle suppresses instead', () => {
    const { features } = suppressedRow(1);
    expect(rowResume(features, features[0]!.featureId)).toBeNull();
    expect(rowResume(features, features[2]!.featureId)).toBeNull();
  });

  it("commits the toggle's own command: one step clearing both pauses", () => {
    const { manager, features } = rolledBackChain();
    const resume = rowResume(features, features[1]!.featureId)!;
    expect(resume.command.label).toBe('Resume Copy');
    expect(resume.command.kind).toBe('node.metadata.set');
    expect(resume.command.payload).toEqual({
      nodeId: features[1]!.id,
      metadata: {
        [FEATURE_SUPPRESSED_METADATA_KEY]: null,
        [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: null
      }
    });
    manager.runTransaction(resume.command.label, [resume.command]);
    const after = listFeaturesInOrder(manager.document);
    expect(isFeatureRollbackSuppressed(after[1]!)).toBe(false);
    // The rest of the rollback stays paused.
    expect(isFeatureRollbackSuppressed(after[2]!)).toBe(true);
  });

  it('checks the row and the later features that build, not paused or earlier ones', () => {
    const middle = suppressedRow(1);
    expect(
      rowResume(middle.features, middle.features[1]!.featureId)!.checked.map(
        (feature) => feature.name
      )
    ).toEqual(['Copy', 'Move copy']);
    // Resuming one row of a rollback leaves the rest of it out of the build.
    const { features } = rolledBackChain();
    expect(
      rowResume(features, features[1]!.featureId)!.checked.map(
        (feature) => feature.name
      )
    ).toEqual(['Copy']);
  });

  it('reports the row and a later feature that was building and now fails because of it', () => {
    const { features, derived } = suppressedRow(1);
    const resume = rowResume(features, features[1]!.featureId)!;
    const alreadyFailing = rowResumeAlreadyFailing(resume, derived);
    expect([...alreadyFailing]).toEqual([]);
    const candidate: ProjectDocument['derived'] = {
      ...derived,
      featureWarnings: [
        failed(features[1]!, 'Mirror plane is degenerate.'),
        failed(features[2]!, 'Target is unavailable.')
      ]
    };
    let thrown: unknown;
    try {
      validateHistoryResume(resume.checked, candidate, alreadyFailing);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HistoryResumeRefusal);
    expect(
      (thrown as HistoryResumeRefusal).failures.map((failure) => failure.name)
    ).toEqual(['Copy', 'Move copy']);
    // A failure before the row is not the resume's doing.
    expect(
      resumeFailures(
        resume.checked,
        { ...derived, featureWarnings: [failed(features[0]!, 'Unrelated.')] },
        alreadyFailing
      )
    ).toEqual([]);
  });

  it('does not blame the resume for a later feature that was already failing', () => {
    const { features, derived } = suppressedRow(1);
    const resume = rowResume(features, features[1]!.featureId)!;
    derived.featureWarnings = [failed(features[2]!, 'Already broken.')];
    const alreadyFailing = rowResumeAlreadyFailing(resume, derived);
    expect([...alreadyFailing]).toEqual([features[2]!.featureId]);
    expect(resumeFailures(resume.checked, derived, alreadyFailing)).toEqual([]);
    // Before the rebuild of the current version is in, none is known.
    expect([...rowResumeAlreadyFailing(resume, null)]).toEqual([]);
  });

  it('takes the row as already failing only when a rollback paused it so', () => {
    const rolled = rolledBackChain();
    const copy = rolled.features[1]!;
    const memory = new Set([copy.featureId]);
    const paused = rowResume(rolled.features, copy.featureId)!;
    expect([...rowResumeAlreadyFailing(paused, null, memory)]).toEqual([
      copy.featureId
    ]);
    // Suppressed by hand: the rollback memory says nothing about it.
    const { features } = suppressedRow(1);
    const suppressed = rowResume(features, features[1]!.featureId)!;
    expect([...rowResumeAlreadyFailing(suppressed, null, memory)]).toEqual([]);
  });

  it('keeps the row suppressed when the validated candidate fails, and commits one undo step when clean', async () => {
    const { manager, features, derived } = suppressedRow(1);
    const resume = rowResume(features, features[1]!.featureId)!;
    const before = manager.document;
    let candidate = derived;
    const commitTransaction = vi.fn(
      (
        label: string,
        commands: Parameters<CommandManager['runTransaction']>[1]
      ) => {
        manager.runTransaction(label, commands);
        return true;
      }
    );
    const onRejection = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async () => candidate,
        commit: vi.fn(),
        commitTransaction,
        onBusy: vi.fn(),
        onStatus: vi.fn(),
        onRejection
      })
    );
    const run = () =>
      result.current.runTransaction([resume.command], {
        label: resume.command.label,
        targets: [],
        validateDerived: (next) =>
          validateHistoryResume(
            resume.checked,
            next,
            rowResumeAlreadyFailing(resume, derived)
          ),
        successMessage: 'Resumed Copy',
        onFailure: vi.fn()
      });

    // The row builds; the feature after it, building before, does not.
    candidate = {
      ...derived,
      featureWarnings: [failed(features[2]!, 'Target is unavailable.')]
    };
    await act(async () => {
      expect(await run()).toBe('rejected');
    });
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(manager.document).toBe(before);
    // Answered by the resume dialog, so no History failure record.
    expect(onRejection).not.toHaveBeenCalled();

    candidate = derived;
    await act(async () => {
      expect(await run()).toBe('committed');
    });
    expect(commitTransaction).toHaveBeenCalledWith(
      'Resume Copy',
      [resume.command],
      derived
    );
    expect(
      listFeaturesInOrder(manager.document).some(isFeatureSuppressed)
    ).toBe(false);
    manager.undo();
    expect(isFeatureSuppressed(listFeaturesInOrder(manager.document)[1]!)).toBe(
      true
    );
  });
});

describe('activeResumePrompt', () => {
  it('belongs to the exact version it was checked against', () => {
    const pending = { projectId: 'p1', version: 4 };
    expect(activeResumePrompt(pending, { projectId: 'p1', version: 4 })).toBe(
      pending
    );
    expect(
      activeResumePrompt(pending, { projectId: 'p1', version: 5 })
    ).toBeNull();
    expect(
      activeResumePrompt(pending, { projectId: 'p2', version: 4 })
    ).toBeNull();
    expect(activeResumePrompt(pending, null)).toBeNull();
    expect(
      activeResumePrompt(null, { projectId: 'p1', version: 4 })
    ).toBeNull();
  });
});
