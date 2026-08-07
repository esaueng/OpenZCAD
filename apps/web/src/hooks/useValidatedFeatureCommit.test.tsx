import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createBodyFeatureIds,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  useValidatedFeatureCommit,
  VALIDATED_FEATURE_BUSY_STATUS,
  VALIDATED_FEATURE_REVALIDATING_STATUS,
  VALIDATED_FEATURE_SUPERSEDED_STATUS,
  type ValidatedFeatureOutcome
} from './useValidatedFeatureCommit';
import {
  createInFlightImportChecksums,
  settleImportSource,
  type InFlightImportChecksums
} from '../lib/importArchival';

const TANGENT_BOSS_DIAGNOSTIC =
  'Union dropped geometry from operand "Boss Body": the result\'s maximum z is 8 mm, but the operand reaches 16 mm (8 mm missing). A cylindrical boss can trigger this kernel failure at exact tangency; move the operand slightly off tangency while keeping positive overlap, then try again.';

/**
 * BrepKit's own verdict for `test/parity/corpus/f-hostile-dangling-reference.step`,
 * pinned against the kernel in `test/step-import-rejection.test.ts`. It is the
 * text a refused import has to reach the user with, unparaphrased.
 */
const DANGLING_REFERENCE_PARSE_ERROR = 'parse error: entity #999999 not found';

function bodyRepresentation(
  bodyId: BodyId
): ProjectDocument['derived']['bodyRepresentations'][BodyId] {
  return {
    bodyId,
    name: 'Imported',
    source: 'imported-step',
    color: '#56b4e9',
    consumed: false,
    exportableStep: true,
    mesh: { kind: 'mesh', vertices: [], indices: [] },
    faceCount: 6,
    volume: 6000,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 30 } }
  };
}

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

    let applied: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      applied = await result.current.run(command, {
        featureName: 'Tangent boss union',
        resultBodyId,
        successMessage: command.label
      });
    });

    expect(applied).toBe('rejected');
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

    let applied: ValidatedFeatureOutcome | undefined;
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

    expect(applied).toBe('rejected');
    expect(commit).not.toHaveBeenCalled();
    expect(manager.document).toEqual(before);
    expect(manager.canUndo).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith(
      'Fillet could not be created on 2 selected edges with radius 1.'
    );
  });
});

/**
 * A STEP import used to commit synchronously and claim success before any
 * geometry ran, so a file the kernel could not parse left a success toast, a
 * history row flagged "Feature failed to build", no body, and a blank
 * viewport. It goes through the same pre-flight as every other feature now.
 */
describe('validated STEP import', () => {
  function importProject() {
    const manager = new CommandManager(
      createProjectDocument('Imported frame', toUserId('user_step_import'))
    );
    const ids = createBodyFeatureIds();
    const command = commandFactories.importStep({
      name: 'Frame',
      // Provisional: the real artifact id is only minted in `finalize`, after
      // the candidate is accepted.
      artifactId: 'artifact_local_preflight',
      sourceName: 'frame.step',
      stepText: 'ISO-10303-21;',
      ids
    });
    return { manager, ids, command };
  }

  it('leaves nothing behind when the kernel refuses the file', async () => {
    const { manager, ids, command } = importProject();
    const before = structuredClone(manager.document);
    const commit = vi.fn(() => true);
    const onStatus = vi.fn();
    const onFailure = vi.fn();
    const hostFailure = vi.fn();
    const finalize = vi.fn(() => Promise.resolve(command));
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async (
          candidate: ProjectDocument
        ): Promise<ProjectDocument['derived']> => ({
          bodyRepresentations: {},
          exportableBodyIds: [],
          warnings: [`Feature "Frame": ${DANGLING_REFERENCE_PARSE_ERROR}`],
          updatedAt: candidate.derived.updatedAt
        }),
        commit,
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus,
        onFailure: hostFailure
      })
    );

    let applied: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      applied = await result.current.run(command, {
        featureName: 'Frame',
        resultBodyId: ids.bodyId,
        validatingMessage:
          'Rebuilding frame.step with the exact geometry kernel…',
        finalize,
        successMessage: () => 'unreachable',
        onFailure
      });
    });

    expect(applied).toBe('rejected');
    expect(commit).not.toHaveBeenCalled();
    // The wasted-upload guard: archival is deferred to `finalize`, which a
    // refused candidate never reaches.
    expect(finalize).not.toHaveBeenCalled();
    expect(manager.document).toEqual(before);
    expect(manager.document.version).toBe(before.version);
    expect(manager.document.commandLog).toEqual(before.commandLog);
    expect(manager.document.revisions).toEqual(before.revisions);
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
    expect(manager.document.bodyOrder).toHaveLength(0);
    expect(manager.canUndo).toBe(false);
    expect(manager.canRedo).toBe(false);
    // Verbatim, prefix stripped: a paraphrase would cost the entity number
    // that says which line of the file to look at.
    expect(onStatus).toHaveBeenLastCalledWith(DANGLING_REFERENCE_PARSE_ERROR);
    expect(onStatus.mock.calls[0]).toEqual([
      'Rebuilding frame.step with the exact geometry kernel…'
    ]);
    // An import has no feature form; its refusal must not land in whichever
    // inspector happens to be open.
    expect(hostFailure).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(DANGLING_REFERENCE_PARSE_ERROR);
  });

  it('commits one history entry with its body and reports success only after it exists', async () => {
    const { manager, ids, command } = importProject();
    const before = structuredClone(manager.document);
    const onStatus = vi.fn();
    const statusesWhenBodyExisted: string[] = [];
    onStatus.mockImplementation((message: string) => {
      if (manager.document.derived.bodyRepresentations[ids.bodyId]) {
        statusesWhenBodyExisted.push(message);
      }
    });
    // What `finalize` is for: the archived artifact id is only known once the
    // candidate has been accepted, and it replaces the provisional local one.
    const archived = commandFactories.importStep({
      name: 'Frame',
      artifactId: 'artifact_cloud_frame',
      sourceName: 'frame.step',
      stepText: 'ISO-10303-21;',
      ids
    });
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async (
          candidate: ProjectDocument
        ): Promise<ProjectDocument['derived']> => ({
          bodyRepresentations: { [ids.bodyId]: bodyRepresentation(ids.bodyId) },
          exportableBodyIds: [ids.bodyId],
          warnings: [],
          updatedAt: candidate.derived.updatedAt
        }),
        commit: (committed: AnyCommand, derived) => {
          manager.execute(committed);
          if (derived) {
            manager.commitDerivedState(derived);
          }
          return true;
        },
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus
      })
    );

    let applied: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      applied = await result.current.run(command, {
        featureName: 'Frame',
        resultBodyId: ids.bodyId,
        finalize: () => Promise.resolve(archived),
        successMessage: () =>
          'Imported editable STEP solid from frame.step: exact body rebuilt, source archived.'
      });
    });

    expect(applied).toBe('committed');
    expect(listFeaturesInOrder(manager.document)).toHaveLength(1);
    expect(manager.document.bodyOrder).toEqual([ids.bodyId]);
    expect(manager.document.commandLog).toHaveLength(
      before.commandLog.length + 1
    );
    expect(manager.document.revisions).toHaveLength(
      before.revisions.length + 1
    );
    expect(manager.canUndo).toBe(true);
    // `finalize` decided what landed, and the ids it carried are the ones the
    // pre-flight checked.
    expect(manager.document.commandLog[0]?.payload).toMatchObject({
      artifactId: 'artifact_cloud_frame',
      ids
    });
    expect(
      manager.document.derived.bodyRepresentations[ids.bodyId]
    ).toBeDefined();
    expect(statusesWhenBodyExisted).toEqual([
      'Imported editable STEP solid from frame.step: exact body rebuilt, source archived.'
    ]);
  });
});

/** Resolves after every queued microtask and timer callback has run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function importCommand(name: string, artifactId: string) {
  const ids = createBodyFeatureIds();
  return {
    ids,
    command: commandFactories.importStep({
      name,
      artifactId,
      sourceName: `${name}.step`,
      stepText: 'ISO-10303-21;',
      ids
    })
  };
}

/**
 * The commit lock decides which run owns document history, and both of its
 * edges had a defect: refusing a run said nothing at all, and an import held
 * the lock across an archive upload of up to 250 MB — minutes during which
 * every boolean, fillet, and primitive edit silently did nothing.
 */
describe('the validated commit lock', () => {
  function host(
    manager: CommandManager,
    derive: () => Promise<ProjectDocument['derived']>,
    onStatus: (message: string) => void
  ) {
    return {
      manager: () => manager,
      derive,
      commit: (
        command: AnyCommand,
        derived: ProjectDocument['derived'] | null
      ) => {
        manager.execute(command);
        if (derived) {
          manager.commitDerivedState(derived);
        }
        return true;
      },
      commitTransaction: () => true,
      onBusy: vi.fn(),
      onStatus
    };
  }

  function derivedWith(
    bodyId: BodyId,
    candidate: ProjectDocument
  ): ProjectDocument['derived'] {
    return {
      bodyRepresentations: { [bodyId]: bodyRepresentation(bodyId) },
      exportableBodyIds: [bodyId],
      warnings: [],
      updatedAt: candidate.derived.updatedAt
    };
  }

  it('says so when it refuses a run instead of doing nothing', async () => {
    const manager = new CommandManager(
      createProjectDocument('Busy lock', toUserId('user_busy_lock'))
    );
    const gate = deferred<void>();
    const first = importCommand('First', 'artifact_local_first');
    const second = importCommand('Second', 'artifact_local_second');
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        host(
          manager,
          async () => {
            await gate.promise;
            return derivedWith(first.ids.bodyId, manager.document);
          },
          onStatus
        )
      )
    );

    let refused: ValidatedFeatureOutcome | undefined;
    let accepted: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const running = result.current
        .run(first.command, {
          featureName: 'First',
          resultBodyId: first.ids.bodyId,
          successMessage: 'first'
        })
        .then((outcome) => {
          accepted = outcome;
        });
      await flush();
      refused = await result.current.run(second.command, {
        featureName: 'Second',
        resultBodyId: second.ids.bodyId,
        successMessage: 'second'
      });
      gate.settle();
      await running;
    });

    // Distinguishable from a refusal, because a caller that undoes its own
    // work on refusal must not undo it here: nothing was validated.
    expect(refused).toBe('busy');
    expect(accepted).toBe('committed');
    expect(onStatus).toHaveBeenCalledWith(VALIDATED_FEATURE_BUSY_STATUS);
    expect(listFeaturesInOrder(manager.document)).toHaveLength(1);
  });

  it('puts the busy refusal on the surface the user is looking at', async () => {
    // The status bar is one clipped line at the bottom of the window. A Create
    // form that is open and unchanged is what the user is actually watching,
    // and a refusal that never reaches it still reads as a silent no-op.
    const manager = new CommandManager(
      createProjectDocument('Busy sink', toUserId('user_busy_sink'))
    );
    const gate = deferred<void>();
    const first = importCommand('First', 'artifact_local_first');
    const second = importCommand('Second', 'artifact_local_second');
    const onStatus = vi.fn();
    const hostFailure = vi.fn();
    const runFailure = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        ...host(
          manager,
          async () => {
            await gate.promise;
            return derivedWith(first.ids.bodyId, manager.document);
          },
          onStatus
        ),
        onFailure: hostFailure
      })
    );

    let refused: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const running = result.current.run(first.command, {
        featureName: 'First',
        resultBodyId: first.ids.bodyId,
        successMessage: 'first'
      });
      await flush();
      refused = await result.current.run(second.command, {
        featureName: 'Second',
        resultBodyId: second.ids.bodyId,
        successMessage: 'second',
        onFailure: runFailure
      });
      gate.settle();
      await running;
    });

    expect(refused).toBe('busy');
    expect(onStatus).toHaveBeenCalledWith(VALIDATED_FEATURE_BUSY_STATUS);
    expect(hostFailure).toHaveBeenCalledWith(VALIDATED_FEATURE_BUSY_STATUS);
    // The host's sink and not the run's, deliberately: this says nothing about
    // the input the refused run was carrying — it is a statement about the
    // operation that owns whichever form is showing it. An import replaces the
    // sink precisely so its own parse errors stay out of unrelated panels.
    expect(runFailure).not.toHaveBeenCalled();
  });

  it('lets unrelated modelling through while an import archives', async () => {
    const manager = new CommandManager(
      createProjectDocument('Slow archive', toUserId('user_slow_archive'))
    );
    const upload = deferred<void>();
    const imported = importCommand('Frame', 'artifact_local_preflight');
    const archivedCommand = commandFactories.importStep({
      name: 'Frame',
      artifactId: 'artifact_cloud_frame',
      sourceName: 'Frame.step',
      stepText: 'ISO-10303-21;',
      ids: imported.ids
    });
    const box = commandFactories.addPrimitive({
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const boxBodyId = box.payload.ids!.bodyId;
    const commitDeriveds: (ProjectDocument['derived'] | null)[] = [];
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        ...host(
          manager,
          async () => derivedWith(imported.ids.bodyId, manager.document),
          onStatus
        ),
        derive: async (candidate: ProjectDocument) =>
          derivedWith(
            candidate.bodyOrder.at(-1) ?? imported.ids.bodyId,
            candidate
          ),
        commit: (
          command: AnyCommand,
          derived: ProjectDocument['derived'] | null
        ) => {
          commitDeriveds.push(derived);
          manager.execute(command);
          if (derived) {
            manager.commitDerivedState(derived);
          }
          return true;
        }
      })
    );

    let importOutcome: ValidatedFeatureOutcome | undefined;
    let boxOutcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const importing = result.current
        .run(imported.command, {
          featureName: 'Frame',
          resultBodyId: imported.ids.bodyId,
          finalize: async () => {
            await upload.promise;
            return archivedCommand;
          },
          successMessage: () => 'imported'
        })
        .then((outcome) => {
          importOutcome = outcome;
        });
      await flush();
      // The upload is still running. Before the fix this returned false with
      // no status at all, for as long as 250 MB takes.
      boxOutcome = await result.current.run(box, {
        featureName: 'Box',
        resultBodyId: boxBodyId,
        successMessage: box.label
      });
      upload.settle();
      await importing;
    });

    expect(boxOutcome).toBe('committed');
    expect(importOutcome).toBe('committed');
    // Serialised even though the lock was released: the import waited for the
    // box's run rather than committing on top of it.
    expect(
      listFeaturesInOrder(manager.document).map((feature) => feature.name)
    ).toEqual(['Box', 'Frame']);
    // The box committed its own rebuild; the import's predates it, so it is
    // dropped rather than blanking the body the box just produced.
    expect(commitDeriveds[0]).not.toBeNull();
    expect(commitDeriveds[1]).toBeNull();
    expect(
      manager.document.derived.bodyRepresentations[boxBodyId]
    ).toBeDefined();
  });

  it('commits nothing when finalize refuses before it transfers anything', async () => {
    // The seam the import's edit re-check uses: permission that flipped during
    // a multi-minute rebuild stops the upload rather than producing an
    // artifact the commit is no longer allowed to reference.
    const manager = new CommandManager(
      createProjectDocument('Read-only', toUserId('user_edit_flip'))
    );
    const imported = importCommand('Frame', 'artifact_local_preflight');
    const commit = vi.fn(() => true);
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async (candidate: ProjectDocument) =>
          derivedWith(imported.ids.bodyId, candidate),
        commit,
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus
      })
    );

    let outcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      outcome = await result.current.run(imported.command, {
        featureName: 'Frame',
        resultBodyId: imported.ids.bodyId,
        finalize: () => {
          throw new Error('Cannot import geometry: View mode is read-only.');
        },
        successMessage: () => 'imported'
      });
    });

    expect(outcome).toBe('rejected');
    expect(commit).not.toHaveBeenCalled();
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
    expect(onStatus).toHaveBeenLastCalledWith(
      'Cannot import geometry: View mode is read-only.'
    );
  });

  it('refuses to land an import in a project that was opened meanwhile', async () => {
    const manager = new CommandManager(
      createProjectDocument('Original', toUserId('user_project_switch'))
    );
    const other = new CommandManager(
      createProjectDocument('Other', toUserId('user_project_switch'))
    );
    let live = manager;
    const upload = deferred<void>();
    const imported = importCommand('Frame', 'artifact_local_preflight');
    const commit = vi.fn(() => true);
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => live,
        derive: async (candidate: ProjectDocument) =>
          derivedWith(imported.ids.bodyId, candidate),
        commit,
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus
      })
    );

    let outcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const importing = result.current
        .run(imported.command, {
          featureName: 'Frame',
          resultBodyId: imported.ids.bodyId,
          finalize: async () => {
            await upload.promise;
            return imported.command;
          },
          successMessage: () => 'imported'
        })
        .then((value) => {
          outcome = value;
        });
      await flush();
      live = other;
      upload.settle();
      await importing;
    });

    expect(outcome).toBe('rejected');
    expect(commit).not.toHaveBeenCalled();
    expect(listFeaturesInOrder(other.document)).toHaveLength(0);
  });
});

/**
 * Nothing in the workspace is disabled while a validated run rebuilds, and an
 * import of 80–250 MB rebuilds for minutes. Renaming a feature or dragging a
 * body in that window used to destroy the import outright — and take its
 * source blob with it — because the run refuses any document that moved
 * underneath its rebuild.
 */
describe('an unrelated edit while a run validates', () => {
  function unrelatedBox(name: string) {
    return commandFactories.addPrimitive({
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
  }

  function importHost(
    manager: CommandManager,
    derive: (candidate: ProjectDocument) => Promise<ProjectDocument['derived']>,
    commitDeriveds: (ProjectDocument['derived'] | null)[],
    onStatus: (message: string) => void
  ) {
    return {
      manager: () => manager,
      derive,
      commit: (
        command: AnyCommand,
        derived: ProjectDocument['derived'] | null
      ) => {
        commitDeriveds.push(derived);
        manager.execute(command);
        if (derived) {
          manager.commitDerivedState(derived);
        }
        return true;
      },
      commitTransaction: () => true,
      onBusy: vi.fn(),
      onStatus
    };
  }

  it('rebuilds the import against the moved document instead of destroying it', async () => {
    const manager = new CommandManager(
      createProjectDocument('Live edit', toUserId('user_live_edit'))
    );
    const imported = importCommand('Frame', 'artifact_local_preflight');
    const gate = deferred<void>();
    let derives = 0;
    const commitDeriveds: (ProjectDocument['derived'] | null)[] = [];
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        importHost(
          manager,
          async () => {
            derives += 1;
            const pass = derives;
            if (pass === 1) {
              await gate.promise;
            }
            return {
              bodyRepresentations: {
                [imported.ids.bodyId]: bodyRepresentation(imported.ids.bodyId)
              },
              exportableBodyIds: [imported.ids.bodyId],
              warnings: [],
              // Which rebuild produced this, so the committed one can be told
              // apart from the stale one it replaced.
              updatedAt: `rebuild-${pass}`
            };
          },
          commitDeriveds,
          onStatus
        )
      )
    );

    let outcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const importing = result.current
        .run(imported.command, {
          featureName: 'Frame',
          resultBodyId: imported.ids.bodyId,
          revalidateOnDocumentMove: true,
          successMessage: () => 'imported'
        })
        .then((value) => {
          outcome = value;
        });
      await flush();
      // The user renames a feature, drags a body, edits a parameter — any of
      // which moves the document while the import is still rebuilding.
      manager.execute(unrelatedBox('Box'));
      gate.settle();
      await importing;
    });

    expect(outcome).toBe('committed');
    expect(derives).toBe(2);
    // The edit that landed mid-rebuild is still there, and so is the import.
    expect(
      listFeaturesInOrder(manager.document).map((feature) => feature.name)
    ).toEqual(['Box', 'Frame']);
    // Committed with the rebuild that saw the box, never the one that predates
    // it — attaching the stale rebuild is what would revert the box's geometry.
    expect(commitDeriveds).toHaveLength(1);
    expect(commitDeriveds[0]?.updatedAt).toBe('rebuild-2');
    expect(onStatus).toHaveBeenCalledWith(
      VALIDATED_FEATURE_REVALIDATING_STATUS
    );
  });

  it('keeps the source when the document moves again during the second pass', async () => {
    const manager = new CommandManager(
      createProjectDocument('Restless', toUserId('user_restless_edit'))
    );
    const imported = importCommand('Frame', 'artifact_local_preflight');
    const file = { checksum: 'sha256-frame', bytes: 'ISO-10303-21;' };
    const gates = [deferred<void>(), deferred<void>()];
    let derives = 0;
    const commitDeriveds: (ProjectDocument['derived'] | null)[] = [];
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        importHost(
          manager,
          async () => {
            const pass = derives;
            derives += 1;
            await gates[pass]?.promise;
            return {
              bodyRepresentations: {
                [imported.ids.bodyId]: bodyRepresentation(imported.ids.bodyId)
              },
              exportableBodyIds: [imported.ids.bodyId],
              warnings: [],
              updatedAt: `rebuild-${pass}`
            };
          },
          commitDeriveds,
          onStatus
        )
      )
    );

    const session = importSession(manager, () => result.current.isRunning());
    let outcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const importing = importOnce(file, {
        ...session,
        run: () =>
          result.current.run(imported.command, {
            featureName: 'Frame',
            resultBodyId: imported.ids.bodyId,
            revalidateOnDocumentMove: true,
            successMessage: () => 'imported'
          })
      }).then((value) => {
        outcome = value;
      });
      await flush();
      manager.execute(unrelatedBox('Box'));
      gates[0]!.settle();
      await flush();
      manager.execute(unrelatedBox('Second box'));
      gates[1]!.settle();
      await importing;
    });

    // Two passes and no more: a steady stream of edits must not hold a rebuild
    // running forever.
    expect(derives).toBe(2);
    // Not `rejected`: the kernel never disagreed with this file, so the caller
    // must not undo the work it did on its behalf.
    expect(outcome).toBe('superseded');
    expect(commitDeriveds).toHaveLength(0);
    expect(
      listFeaturesInOrder(manager.document).map((feature) => feature.name)
    ).toEqual(['Box', 'Second box']);
    expect(onStatus).toHaveBeenLastCalledWith(
      VALIDATED_FEATURE_SUPERSEDED_STATUS
    );
    // The source survives, and is remembered as this tab's, so the retry it
    // invites is cheap and still cleans up after itself if the kernel refuses.
    expect(session.blobs.get(file.checksum)).toBe(file.bytes);
    expect(session.abandoned.has(file.checksum)).toBe(true);
  });

  it('still refuses a run that did not ask to be rebuilt', async () => {
    // Re-validating is opt-in. For an edit of an existing feature the move may
    // be a conflicting change to the very thing being edited, which the user
    // needs to be told about rather than quietly validated against.
    const manager = new CommandManager(
      createProjectDocument('Unchanged', toUserId('user_no_revalidate'))
    );
    const imported = importCommand('Frame', 'artifact_local_preflight');
    const gate = deferred<void>();
    let derives = 0;
    const commitDeriveds: (ProjectDocument['derived'] | null)[] = [];
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        importHost(
          manager,
          async () => {
            derives += 1;
            await gate.promise;
            return {
              bodyRepresentations: {
                [imported.ids.bodyId]: bodyRepresentation(imported.ids.bodyId)
              },
              exportableBodyIds: [imported.ids.bodyId],
              warnings: [],
              updatedAt: `rebuild-${derives}`
            };
          },
          commitDeriveds,
          onStatus
        )
      )
    );

    let outcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const running = result.current
        .run(imported.command, {
          featureName: 'Frame',
          resultBodyId: imported.ids.bodyId,
          successMessage: () => 'imported'
        })
        .then((value) => {
          outcome = value;
        });
      await flush();
      manager.execute(unrelatedBox('Box'));
      gate.settle();
      await running;
    });

    expect(outcome).toBe('rejected');
    expect(derives).toBe(1);
    expect(commitDeriveds).toHaveLength(0);
    expect(onStatus).toHaveBeenLastCalledWith(
      'The document changed while the operation validated.'
    );
  });
});

interface ImportSession {
  blobs: Map<string, string>;
  inFlight: InFlightImportChecksums;
  /** Checksums this tab wrote for an import that ended without a verdict. */
  abandoned: Set<string>;
  isRunning(): boolean;
  document(): ProjectDocument;
  onStatus?(message: string): void;
}

/**
 * The import handler reduced to what decides the fate of its source blob, in
 * the handler's own order: refuse before writing anything if the commit lock
 * is held, write the bytes, mark them, read the file, validate, and discard
 * only what a verdict actually abandoned.
 */
async function importOnce(
  file: { checksum: string; bytes: string },
  deps: ImportSession & {
    /** Stands in for reading and parsing the file, which is not instant. */
    readFile?(): Promise<void>;
    run(): Promise<ValidatedFeatureOutcome>;
  }
): Promise<ValidatedFeatureOutcome> {
  await flush();
  // Asked before the bytes are written: nothing sweeps unreferenced blobs.
  if (deps.isRunning()) {
    deps.onStatus?.(VALIDATED_FEATURE_BUSY_STATUS);
    return 'busy';
  }
  const created = !deps.blobs.has(file.checksum);
  deps.blobs.set(file.checksum, file.bytes);
  deps.inFlight.acquire(file.checksum);
  await deps.readFile?.();
  let outcome: ValidatedFeatureOutcome;
  try {
    outcome = await deps.run();
  } finally {
    deps.inFlight.release(file.checksum);
  }
  await settleImportSource({
    checksumSha256: file.checksum,
    result:
      outcome === 'committed'
        ? 'committed'
        : outcome === 'busy' || outcome === 'superseded'
          ? 'no-verdict'
          : 'refused',
    createdByThisImport: created,
    abandonedChecksums: deps.abandoned,
    document: deps.document(),
    inFlightChecksums: deps.inFlight,
    deleteSourceBlob: async (checksum) => {
      deps.blobs.delete(checksum);
    }
  });
  return outcome;
}

function importSession(
  manager: CommandManager,
  isRunning: () => boolean,
  onStatus?: (message: string) => void
): ImportSession {
  return {
    blobs: new Map<string, string>(),
    inFlight: createInFlightImportChecksums(),
    abandoned: new Set<string>(),
    isRunning,
    document: () => manager.document,
    ...(onStatus ? { onStatus } : {})
  };
}

describe('importing the same file twice at once', () => {
  it('keeps the source blob the first import is still validating against', async () => {
    // Storage is content-addressed and device-global, so the second import
    // lands on the SAME key. It bounces off the commit lock without validating
    // anything — and used to be indistinguishable from a kernel refusal, so it
    // pruned the bytes the first import was about to commit against.
    const manager = new CommandManager(
      createProjectDocument('Twice', toUserId('user_double_import'))
    );
    const file = { checksum: 'sha256-frame', bytes: 'ISO-10303-21;' };
    const gate = deferred<void>();
    const imported = importCommand('Frame', 'artifact_local_preflight');
    const second = importCommand('Frame', 'artifact_local_second');
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async (candidate: ProjectDocument) => {
          await gate.promise;
          return {
            bodyRepresentations: {
              [imported.ids.bodyId]: bodyRepresentation(imported.ids.bodyId)
            },
            exportableBodyIds: [imported.ids.bodyId],
            warnings: [],
            updatedAt: candidate.derived.updatedAt
          };
        },
        commit: (
          command: AnyCommand,
          derived: ProjectDocument['derived'] | null
        ) => {
          manager.execute(command);
          if (derived) {
            manager.commitDerivedState(derived);
          }
          return true;
        },
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );

    const session = importSession(manager, () => result.current.isRunning());
    let firstOutcome: ValidatedFeatureOutcome | undefined;
    let secondOutcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const first = importOnce(file, {
        ...session,
        run: () =>
          result.current.run(imported.command, {
            featureName: 'Frame',
            resultBodyId: imported.ids.bodyId,
            successMessage: () => 'imported'
          })
      }).then((outcome) => {
        firstOutcome = outcome;
      });
      secondOutcome = await importOnce(file, {
        ...session,
        run: () =>
          result.current.run(second.command, {
            featureName: 'Frame',
            resultBodyId: second.ids.bodyId,
            successMessage: () => 'imported'
          })
      });
      gate.settle();
      await first;
    });

    // The bytes the committed feature rebuilds from are still there.
    expect(session.blobs.get(file.checksum)).toBe(file.bytes);
    expect(secondOutcome).toBe('busy');
    expect(firstOutcome).toBe('committed');
    expect(listFeaturesInOrder(manager.document)).toHaveLength(1);
  });

  it('keeps the source blob when the second copy is refused mid-archive', async () => {
    // The lock is released while the first import uploads, so a second import
    // of the same file can now reach the kernel — and be refused by it. Its
    // cleanup is a genuine refusal, and the checksum it would prune is the one
    // the first import is seconds away from committing against.
    const manager = new CommandManager(
      createProjectDocument('Twice', toUserId('user_double_import'))
    );
    const file = { checksum: 'sha256-frame', bytes: 'ISO-10303-21;' };
    const upload = deferred<void>();
    const imported = importCommand('Frame', 'artifact_local_preflight');
    const second = importCommand('Refused', 'artifact_local_second');
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async (candidate: ProjectDocument) => ({
          bodyRepresentations: {
            [imported.ids.bodyId]: bodyRepresentation(imported.ids.bodyId)
          },
          exportableBodyIds: [imported.ids.bodyId],
          warnings: [`Feature "Refused": ${DANGLING_REFERENCE_PARSE_ERROR}`],
          updatedAt: candidate.derived.updatedAt
        }),
        commit: (
          command: AnyCommand,
          derived: ProjectDocument['derived'] | null
        ) => {
          manager.execute(command);
          if (derived) {
            manager.commitDerivedState(derived);
          }
          return true;
        },
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );

    const session = importSession(manager, () => result.current.isRunning());
    let firstOutcome: ValidatedFeatureOutcome | undefined;
    let secondOutcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const first = importOnce(file, {
        ...session,
        run: () =>
          result.current.run(imported.command, {
            featureName: 'Frame',
            resultBodyId: imported.ids.bodyId,
            finalize: async () => {
              await upload.promise;
              return imported.command;
            },
            successMessage: () => 'imported'
          })
      }).then((outcome) => {
        firstOutcome = outcome;
      });
      await flush();
      secondOutcome = await importOnce(file, {
        ...session,
        run: () =>
          result.current.run(second.command, {
            featureName: 'Refused',
            resultBodyId: second.ids.bodyId,
            successMessage: () => 'imported'
          })
      });
      upload.settle();
      await first;
    });

    expect(session.blobs.get(file.checksum)).toBe(file.bytes);
    expect(secondOutcome).toBe('rejected');
    expect(firstOutcome).toBe('committed');
    expect(
      listFeaturesInOrder(manager.document).map((feature) => feature.name)
    ).toEqual(['Frame']);
  });

  it('keeps the bytes a second import still holds while the first cleans up', async () => {
    // The first import created the bytes and is refused after its upload, so
    // it is the one entitled to delete them. A second import of the same file
    // slipped in while the lock was released and is still reading its copy of
    // the file — it has not reached the kernel yet, so nothing but the in-flight
    // mark says those bytes are spoken for.
    //
    // The mark has to be a COUNT. As a set, both imports produce one entry, and
    // the first import's own release erases it — after which the first import
    // deletes the source the second is about to commit against, and the
    // committed feature can never rebuild.
    const manager = new CommandManager(
      createProjectDocument('Twice', toUserId('user_double_import'))
    );
    const file = { checksum: 'sha256-frame', bytes: 'ISO-10303-21;' };
    const upload = deferred<void>();
    const secondRead = deferred<void>();
    const imported = importCommand('Frame', 'artifact_local_preflight');
    const second = importCommand('Frame again', 'artifact_local_second');
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async (candidate: ProjectDocument) => ({
          bodyRepresentations: {
            [imported.ids.bodyId]: bodyRepresentation(imported.ids.bodyId),
            [second.ids.bodyId]: bodyRepresentation(second.ids.bodyId)
          },
          exportableBodyIds: [imported.ids.bodyId, second.ids.bodyId],
          warnings: [],
          updatedAt: candidate.derived.updatedAt
        }),
        commit: (
          command: AnyCommand,
          derived: ProjectDocument['derived'] | null
        ) => {
          manager.execute(command);
          if (derived) {
            manager.commitDerivedState(derived);
          }
          return true;
        },
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );

    const session = importSession(manager, () => result.current.isRunning());
    let firstOutcome: ValidatedFeatureOutcome | undefined;
    let secondOutcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const first = importOnce(file, {
        ...session,
        run: () =>
          result.current.run(imported.command, {
            featureName: 'Frame',
            resultBodyId: imported.ids.bodyId,
            finalize: async () => {
              await upload.promise;
              // The project went read-only during the upload: accepted by the
              // kernel, refused by the commit, so its bytes look abandoned.
              throw new Error('Cannot import geometry: View mode is read-only.');
            },
            successMessage: () => 'imported'
          })
      }).then((outcome) => {
        firstOutcome = outcome;
      });
      await flush();
      // The lock is free while the first import uploads, so this one writes and
      // marks its bytes, then sits in its own file read.
      const secondImport = importOnce(file, {
        ...session,
        readFile: () => secondRead.promise,
        run: () =>
          result.current.run(second.command, {
            featureName: 'Frame again',
            resultBodyId: second.ids.bodyId,
            successMessage: () => 'imported'
          })
      }).then((outcome) => {
        secondOutcome = outcome;
      });
      await flush();
      upload.settle();
      await first;

      // The first import has finished refusing and cleaning up while the
      // second still holds the mark.
      expect(firstOutcome).toBe('rejected');
      expect(session.blobs.get(file.checksum)).toBe(file.bytes);

      secondRead.settle();
      await secondImport;
    });

    expect(secondOutcome).toBe('committed');
    expect(session.blobs.get(file.checksum)).toBe(file.bytes);
    expect(
      listFeaturesInOrder(manager.document).map((feature) => feature.name)
    ).toEqual(['Frame again']);
  });

  it('writes no source bytes for an import the commit lock turns away', async () => {
    // The File menu stays enabled while an exact operation runs, so this is
    // reachable by ordinary clicking. Writing up to 250 MB and only then asking
    // left those bytes on the device forever — nothing sweeps unreferenced
    // blobs — and their presence disarmed the cleanup of the retry, which found
    // a key it had not created.
    const manager = new CommandManager(
      createProjectDocument('Busy import', toUserId('user_busy_import'))
    );
    const gate = deferred<void>();
    const running = importCommand('Running', 'artifact_local_running');
    const turnedAway = importCommand('Turned away', 'artifact_local_turned');
    const retry = importCommand('Retry', 'artifact_local_retry');
    const statuses: string[] = [];
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: async (candidate: ProjectDocument) => {
          await gate.promise;
          return {
            bodyRepresentations: {
              [running.ids.bodyId]: bodyRepresentation(running.ids.bodyId)
            },
            exportableBodyIds: [running.ids.bodyId],
            // The second file is the one the kernel cannot parse.
            warnings: [`Feature "Retry": ${DANGLING_REFERENCE_PARSE_ERROR}`],
            updatedAt: candidate.derived.updatedAt
          };
        },
        commit: (
          command: AnyCommand,
          derived: ProjectDocument['derived'] | null
        ) => {
          manager.execute(command);
          if (derived) {
            manager.commitDerivedState(derived);
          }
          return true;
        },
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );

    const held = { checksum: 'sha256-running', bytes: 'ISO-10303-21; /* a */' };
    const rejectedFile = {
      checksum: 'sha256-second',
      bytes: 'ISO-10303-21; /* b */'
    };
    const session = importSession(
      manager,
      () => result.current.isRunning(),
      (message) => statuses.push(message)
    );
    let turnedAwayOutcome: ValidatedFeatureOutcome | undefined;
    let retryOutcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      const first = importOnce(held, {
        ...session,
        run: () =>
          result.current.run(running.command, {
            featureName: 'Running',
            resultBodyId: running.ids.bodyId,
            successMessage: () => 'imported'
          })
      });
      turnedAwayOutcome = await importOnce(rejectedFile, {
        ...session,
        run: () =>
          result.current.run(turnedAway.command, {
            featureName: 'Turned away',
            resultBodyId: turnedAway.ids.bodyId,
            successMessage: () => 'imported'
          })
      });
      gate.settle();
      await first;

      expect(turnedAwayOutcome).toBe('busy');
      expect(statuses).toEqual([VALIDATED_FEATURE_BUSY_STATUS]);
      // Nothing was written, so nothing is left to leak.
      expect(session.blobs.has(rejectedFile.checksum)).toBe(false);

      // And the retry, once the lock is free, still owns what it writes: the
      // kernel refuses this file, and its bytes go with it.
      retryOutcome = await importOnce(rejectedFile, {
        ...session,
        run: () =>
          result.current.run(retry.command, {
            featureName: 'Retry',
            resultBodyId: retry.ids.bodyId,
            successMessage: () => 'imported'
          })
      });
    });

    expect(retryOutcome).toBe('rejected');
    expect(session.blobs.has(rejectedFile.checksum)).toBe(false);
    expect(session.blobs.get(held.checksum)).toBe(held.bytes);
  });
});
