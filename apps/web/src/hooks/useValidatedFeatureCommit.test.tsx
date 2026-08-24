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
  type ValidatedFeatureOutcome,
  type ValidatedFeatureReservation,
  type ValidatedFeatureRunOptions
} from './useValidatedFeatureCommit';
import {
  createInFlightImportChecksums,
  importSourceChecksums
} from '../lib/importArchival';
import type {
  ImportPhase,
  ImportProgressSink,
  ImportRunOutcome,
  ImportRunProgress
} from '../lib/importProgress';
import {
  deleteSourceBlobIfUnreferenced,
  ensureLocalProjectStorage,
  LOCAL_STORAGE_BLOCKED_MESSAGE,
  putSourceBlobIfAbsent,
  releaseSourceBlobClaim,
  type LocalStorageReadiness
} from '../lib/localProjectStore';
import {
  localStepImportSourceStore,
  runStepImport,
  type StepImportMarks,
  type StepImportResult,
  type StepImportSourceStore
} from '../lib/stepImportRun';

const TANGENT_BOSS_DIAGNOSTIC =
  'Union dropped geometry from operand "Boss Body": the result\'s maximum z is 8 mm, but the operand reaches 16 mm (8 mm missing). A cylindrical boss can trigger this kernel failure at exact tangency; move the operand slightly off tangency while keeping positive overlap, then try again.';

/**
 * Remus's own verdict for `test/parity/corpus/f-hostile-dangling-reference.step`,
 * pinned against the kernel in `test/step-import-rejection.test.ts`. It is the
 * text a refused import has to reach the user with, unparaphrased.
 */
const DANGLING_REFERENCE_PARSE_ERROR = 'parse error: entity #999999 not found';

/** What the import says when the bytes have nowhere on this device to go. */
const STORAGE_UNAVAILABLE_STATUS =
  'STEP import over 12 MB needs browser storage, which is unavailable in this session.';

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
    mesh: { kind: 'mesh', vertices: Float32Array.from([]), indices: Uint32Array.from([]) },
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
              mesh: { kind: 'mesh', vertices: new Float32Array(), indices: new Uint32Array() },
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
              mesh: { kind: 'mesh', vertices: new Float32Array(), indices: new Uint32Array() },
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

  it('cannot unlock a run it does not hold, however often it is released', async () => {
    // The import releases its reservation in a `finally`, after handing it to a
    // run that has already released it. That second call is documented as
    // harmless, and the whole `finally` depends on it being so — but "harmless"
    // has to mean "does nothing", not "clears the lock". Clearing it would free
    // whoever holds it NOW: an unrelated operation loses its exclusivity in the
    // middle of validate-then-commit, and the next run interleaves with it.
    const manager = new CommandManager(
      createProjectDocument('Stale release', toUserId('user_stale_release'))
    );
    const gate = deferred<void>();
    const running = importCommand('Running', 'artifact_local_running');
    const third = importCommand('Third', 'artifact_local_third');
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        host(
          manager,
          async () => {
            await gate.promise;
            return derivedWith(running.ids.bodyId, manager.document);
          },
          onStatus
        )
      )
    );

    let refused: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      // A reservation taken and given up without running anything — an import
      // that was turned away before it wrote a byte.
      const stale = result.current.reserve();
      expect(stale).not.toBeNull();
      stale?.release();

      const first = result.current.run(running.command, {
        featureName: 'Running',
        resultBodyId: running.ids.bodyId,
        successMessage: 'running'
      });
      await flush();

      // The turned-away import's `finally` fires, late, on a reservation whose
      // lock somebody else now holds.
      stale?.release();
      stale?.release();

      refused = await result.current.run(third.command, {
        featureName: 'Third',
        resultBodyId: third.ids.bodyId,
        successMessage: 'third'
      });
      gate.settle();
      await first;
    });

    expect(refused).toBe('busy');
    expect(
      listFeaturesInOrder(manager.document).map((feature) => feature.name)
    ).toEqual(['Running']);
    // And the lock really was let go once the run that owned it finished.
    const afterwards = result.current.reserve();
    expect(afterwards).not.toBeNull();
    afterwards?.release();
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
    const file = {
      name: 'Frame.step',
      checksum: 'sha256-frame',
      bytes: 'ISO-10303-21;'
    };
    const gates = [deferred<void>(), deferred<void>()];
    let derives = 0;
    const commitDeriveds: (ProjectDocument['derived'] | null)[] = [];
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        importHost(
          manager,
          async (candidate: ProjectDocument) => {
            const pass = derives;
            derives += 1;
            await gates[pass]?.promise;
            return {
              ...derivedFromCandidate(candidate),
              updatedAt: `rebuild-${pass}`
            };
          },
          commitDeriveds,
          onStatus
        )
      )
    );

    const statuses: string[] = [];
    const session = importSession(
      createDevice(),
      manager,
      () => result.current.reserve(),
      (message) => statuses.push(message)
    );
    let outcome: StepImportResult | undefined;
    await act(async () => {
      const importing = importOnce(file, {
        ...session,
        run: (command, options) => result.current.run(command, options)
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
    expect(outcome?.outcome).toBe('superseded');
    expect(commitDeriveds).toHaveLength(0);
    expect(
      listFeaturesInOrder(manager.document).map((feature) => feature.name)
    ).toEqual(['Box', 'Second box']);
    expect(onStatus).toHaveBeenLastCalledWith(
      VALIDATED_FEATURE_SUPERSEDED_STATUS
    );
    // The source survives, and is remembered as this tab's, so the retry it
    // invites is cheap and still cleans up after itself if the kernel refuses.
    expect(session.device.blobs.get(file.checksum)).toBe(file.bytes);
    expect(session.marks.abandoned.has(file.checksum)).toBe(true);
    // And the user is told which of the two it was. "Not imported" on its own
    // reads as a verdict against the file, which would send them looking for a
    // problem in a file that has none — and hide that the retry is cheap
    // because the bytes are already stored.
    expect(statuses.at(-1)).toBe(
      'Frame.step was not imported: the model kept changing while it rebuilt. ' +
        'Its source is still stored, so importing it again costs only the rebuild.'
    );
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
/**
 * One device's import storage, shared by every tab on it.
 *
 * This is the thing the per-tab bookkeeping cannot see. A tab knows which of
 * ITS imports are in flight and which document IT has open; the blob store
 * underneath is common to all of them, so nothing a tab can consult on its own
 * proves that bytes are free.
 *
 * Which is exactly why deletion is narrower than the store: only the tab that
 * WROTE a key ever asks to delete it. See the ownership rule in
 * `settleImportSource` — the trade is a leak, never a loss.
 */
interface SharedDevice {
  blobs: Map<string, string>;
  claims: Map<string, Set<string>>;
  /** Every delete the store was ever asked for, whoever asked. */
  deleteRequests: string[];
}

function createDevice(): SharedDevice {
  return {
    blobs: new Map<string, string>(),
    claims: new Map<string, Set<string>>(),
    deleteRequests: []
  };
}

/** A file as the fake store keys it: the test names the checksum, not SHA-256. */
interface ImportFile {
  name: string;
  checksum: string;
  bytes: string;
}

/**
 * The uploaded file. A real `File` in the app; here the bytes are a string and
 * `size` is settable, so a test can put a file over a cap without building one.
 */
function uploadedFile(file: ImportFile, size = file.bytes.length): File {
  return {
    name: file.name,
    size,
    type: 'model/step',
    text: () => Promise.resolve(file.bytes)
  } as unknown as File;
}

/**
 * The blob store, over the shared device.
 *
 * `deleteSourceBlob` deletes UNCONDITIONALLY, exactly as the real one does —
 * the store is a dumb key-value store and the whole of the reference decision
 * is `settleImportSource`'s. Every call is recorded, so a test can distinguish
 * "the run decided not to delete" from "the run asked and the store said no",
 * which the surviving bytes alone cannot.
 */
function deviceStore(
  device: SharedDevice,
  file: ImportFile,
  options: {
    /** Held open to park a run inside its own storage write. */
    storing?: Promise<void>;
    readiness?: LocalStorageReadiness;
    /** Rejects the write, as a storage-denied session does. */
    refuseWrite?: boolean;
  } = {}
): StepImportSourceStore {
  return {
    ensureLocalProjectStorage: async () => options.readiness ?? 'ready',
    putSourceBlobIfAbsent: async (_source, claimOptions) => {
      // Not instant: hashing and storing up to 250 MB is the whole window the
      // commit lock has to be reserved across.
      await options.storing;
      if (options.refuseWrite) {
        throw new Error('IndexedDB unavailable.');
      }
      const created = !device.blobs.has(file.checksum);
      device.blobs.set(file.checksum, file.bytes);
      if (claimOptions?.claimId) {
        const claims = device.claims.get(file.checksum) ?? new Set<string>();
        claims.add(claimOptions.claimId);
        device.claims.set(file.checksum, claims);
      }
      return {
        ref: {
          marker: 'openzcad-source-ref',
          version: 1,
          hashAlgorithm: 'sha256',
          checksumSha256: file.checksum,
          logicalBytes: file.bytes.length
        },
        created
      };
    },
    deleteSourceBlobIfUnreferenced: async ({ checksumSha256, claimId }) => {
      device.deleteRequests.push(checksumSha256);
      const claims = device.claims.get(checksumSha256) ?? new Set<string>();
      if ([...claims].some((candidate) => candidate !== claimId)) {
        return false;
      }
      claims.delete(claimId);
      device.blobs.delete(checksumSha256);
      return true;
    },
    releaseSourceBlobClaim: async (checksumSha256, claimId) => {
      const claims = device.claims.get(checksumSha256);
      claims?.delete(claimId);
      if (claims?.size === 0) {
        device.claims.delete(checksumSha256);
      }
    }
  };
}

/** One tab's own state: its marks, its notes, its lock, its open document. */
interface ImportSession {
  device: SharedDevice;
  marks: StepImportMarks;
  reserve(): ValidatedFeatureReservation | null;
  document(): ProjectDocument;
  onStatus?(message: string): void;
  /**
   * The inline sink — whichever feature form is open. Separate from the status
   * bar because a refusal that reached only the status bar reads as the import
   * having silently done nothing, and the two have been wrong independently.
   */
  onFeatureFormError?(message: string): void;
}

let importSequence = 0;

/**
 * Runs the REAL import orchestration against the fake device.
 *
 * Nothing here models the handler: `runStepImport` is the function `App.tsx`
 * calls, and this supplies the same collaborators the app supplies. Dropping
 * the lock release, or the ordering inside it, or the guard in front of the
 * delete therefore changes what these tests observe — which was the defect,
 * when this was a copy of the handler written out by hand.
 */
function importOnce(
  file: ImportFile,
  deps: ImportSession & {
    run(
      command: AnyCommand,
      options: ValidatedFeatureRunOptions
    ): Promise<ValidatedFeatureOutcome>;
    /** Held open to park a run inside its own storage write. */
    storing?: Promise<void>;
    /** Held open to park a run inside its archive upload. */
    archiving?: Promise<void>;
    readiness?: LocalStorageReadiness;
    refuseWrite?: boolean;
    editDisabledReason?(): string | null;
    fileSize?: number;
    limits?: { maxSourceBytes?: number; maxEmbeddedBytes?: number };
    progress?: ImportProgressSink;
    /** Rejects the upload, as a session with no cloud reachable does. */
    refuseArchive?: boolean;
    signal?: AbortSignal;
  }
): Promise<StepImportResult> {
  return runStepImport({
    file: uploadedFile(file, deps.fileSize),
    contentType: 'model/step',
    store: deviceStore(deps.device, file, {
      ...(deps.storing ? { storing: deps.storing } : {}),
      ...(deps.readiness ? { readiness: deps.readiness } : {}),
      ...(deps.refuseWrite ? { refuseWrite: true } : {})
    }),
    archive: async () => {
      await deps.archiving;
      if (deps.refuseArchive) {
        throw new Error('Artifact upload is unavailable.');
      }
      return 'artifact_cloud_step';
    },
    ...(deps.progress ? { progress: deps.progress } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    validatedFeature: { reserve: deps.reserve, run: deps.run },
    status: {
      setStatus: (message) => deps.onStatus?.(message),
      setFeatureFormError: (message) => deps.onFeatureFormError?.(message)
    },
    marks: deps.marks,
    currentDocument: deps.document,
    editDisabledReason: deps.editDisabledReason ?? (() => null),
    newId: () => {
      importSequence += 1;
      return `id-${importSequence}`;
    },
    ...(deps.limits ? { limits: deps.limits } : {})
  });
}

function importSession(
  device: SharedDevice,
  manager: CommandManager,
  reserve: () => ValidatedFeatureReservation | null,
  onStatus?: (message: string) => void
): ImportSession {
  return {
    device,
    marks: {
      inFlight: createInFlightImportChecksums(),
      abandoned: new Set<string>()
    },
    reserve,
    document: () => manager.document,
    ...(onStatus ? { onStatus } : {})
  };
}

/**
 * Every body the candidate declares, rebuilt successfully.
 *
 * The run mints its own feature and body ids, so a fake kernel cannot be told
 * in advance which body to produce — it reads them off the candidate, exactly
 * as the real one derives whatever the document asks for.
 */
function derivedFromCandidate(
  candidate: ProjectDocument,
  warnings: string[] = []
): ProjectDocument['derived'] {
  const bodyIds = Object.values(candidate.nodes)
    .filter((node): node is Extract<typeof node, { kind: 'body' }> =>
      Boolean(node && node.kind === 'body')
    )
    .map((node) => node.bodyId);
  return {
    bodyRepresentations: Object.fromEntries(
      bodyIds.map((bodyId) => [bodyId, bodyRepresentation(bodyId)])
    ),
    exportableBodyIds: bodyIds,
    warnings,
    updatedAt: candidate.derived.updatedAt
  };
}

/** One tab's host: its commit runs the command straight into its manager. */
function tabHost(
  manager: CommandManager,
  derive: (candidate: ProjectDocument) => Promise<ProjectDocument['derived']>,
  options: {
    refuseCommit?: () => boolean;
    onFailure?: () => void;
    /** The status bar, which in the app is the same sink the run writes to. */
    onStatus?: (message: string) => void;
  } = {}
) {
  return {
    manager: () => manager,
    derive,
    ...(options.onFailure ? { onFailure: options.onFailure } : {}),
    commit: (
      command: AnyCommand,
      derived: ProjectDocument['derived'] | null
    ) => {
      if (options.refuseCommit?.()) {
        return false;
      }
      manager.execute(command);
      if (derived) {
        manager.commitDerivedState(derived);
      }
      return true;
    },
    commitTransaction: () => true,
    onBusy: vi.fn(),
    onStatus: options.onStatus ?? vi.fn()
  };
}

/** The kernel accepting whatever it is handed. */
function acceptsEverything(gate?: Promise<void>) {
  return async (candidate: ProjectDocument) => {
    await gate;
    return derivedFromCandidate(candidate);
  };
}

/** The kernel refusing the file `f-hostile-dangling-reference` is drawn from. */
function refusesFile(featureName: string) {
  return async (candidate: ProjectDocument) =>
    derivedFromCandidate(candidate, [
      `Feature "${featureName}": ${DANGLING_REFERENCE_PARSE_ERROR}`
    ]);
}

describe('the import orchestration, run rather than read', () => {
  const file = {
    name: 'Frame.step',
    checksum: 'sha256-frame',
    bytes: 'ISO-10303-21;'
  };

  function oneTab(device: SharedDevice) {
    const manager = new CommandManager(
      createProjectDocument('Import', toUserId('user_import_run'))
    );
    const statuses: string[] = [];
    const push = (message: string) => statuses.push(message);
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        // One sink, as in the app: `onStatus` and the run's own `setStatus` are
        // both the status bar, so the order they arrive in is what the user sees.
        tabHost(manager, acceptsEverything(), { onStatus: push })
      )
    );
    const session = importSession(
      device,
      manager,
      () => result.current.reserve(),
      push
    );
    return { manager, statuses, result, session };
  }

  it('keeps the bytes of the import it committed, and never asks otherwise', async () => {
    // The bytes are on the device from before the kernel is consulted, and the
    // feature that lands rebuilds from them. Asking to delete them at all would
    // be the bug — the store deletes whatever it is handed — so the assertion is
    // that no delete was ever requested, not merely that the bytes survived.
    const device = createDevice();
    const { session, result, manager } = oneTab(device);
    let storedDuringRun: string | undefined;

    await act(async () => {
      await importOnce(file, {
        ...session,
        run: (command, options) => {
          // Mid-run: the bytes are on the device and nothing has committed yet.
          storedDuringRun = device.blobs.get(file.checksum);
          return result.current.run(command, options);
        }
      });
    });

    expect(storedDuringRun).toBe(file.bytes);
    expect(device.blobs.get(file.checksum)).toBe(file.bytes);
    expect(device.deleteRequests).toEqual([]);
    expect(
      listFeaturesInOrder(manager.document).map((feature) => feature.name)
    ).toEqual(['Frame']);
  });

  it('wires the app to the real device store, not to a lookalike', () => {
    // The mutation class no behavioural test can reach: `App.tsx` is rendered by
    // nothing, so a store member wired to the wrong function there leaves every
    // suite green while a refused import leaks its bytes — or worse, deletes
    // bytes it never wrote. There is no wiring in `App.tsx` to get wrong,
    // because the store is defaulted; this pins that default to the real
    // module's exports by identity.
    expect(localStepImportSourceStore.ensureLocalProjectStorage).toBe(
      ensureLocalProjectStorage
    );
    expect(localStepImportSourceStore.putSourceBlobIfAbsent).toBe(
      putSourceBlobIfAbsent
    );
    expect(localStepImportSourceStore.deleteSourceBlobIfUnreferenced).toBe(
      deleteSourceBlobIfUnreferenced
    );
    expect(localStepImportSourceStore.releaseSourceBlobClaim).toBe(
      releaseSourceBlobClaim
    );
  });

  it('leaves the commit lock free on every path that never reaches a run', async () => {
    // The release in the handler's `finally`. A run releases the lock itself,
    // so this only ever matters on the paths that never got to one — and those
    // are the paths where losing it is worst, because nothing failed loudly.
    // A stranded lock is not a failed import: it is every later boolean,
    // fillet and primitive edit in the tab silently doing nothing.
    const device = createDevice();
    const { session, result } = oneTab(device);

    await act(async () => {
      // Storage refuses the write and the file is too large to embed, so the
      // run returns from inside the `try` without ever calling `run`.
      const declined = await importOnce(file, {
        ...session,
        refuseWrite: true,
        fileSize: 40 * 1024 * 1024,
        limits: { maxEmbeddedBytes: 12 * 1024 * 1024 },
        run: () => {
          throw new Error('the run must not be reached');
        }
      });
      expect(declined.outcome).toBe('declined');
    });

    // The proof, and the only one that matters: the lock is free.
    const afterwards = result.current.reserve();
    expect(afterwards).not.toBeNull();
    afterwards?.release();
  });

  it('settles the storage schema before it takes the lock, not after', async () => {
    // Ordering, run rather than read out of the source. Opening the database is
    // the browser's to schedule, and a commit lock held across it is a lock held
    // for however long that takes — while a stranded commit lock is not one
    // failed import but every validated operation in the tab silently doing
    // nothing until it is reloaded.
    const device = createDevice();
    const { session, result } = oneTab(device);
    const order: string[] = [];

    await act(async () => {
      await runStepImport({
        file: uploadedFile(file),
        contentType: 'model/step',
        store: {
          ...deviceStore(device, file),
          ensureLocalProjectStorage: async () => {
            order.push('storage');
            return 'ready';
          }
        },
        archive: async () => 'artifact_cloud_step',
        validatedFeature: {
          reserve: () => {
            order.push('lock');
            return result.current.reserve();
          },
          run: (command, options) => result.current.run(command, options)
        },
        status: {
          setStatus: () => undefined,
          setFeatureFormError: () => undefined
        },
        marks: session.marks,
        currentDocument: session.document,
        editDisabledReason: () => null,
        newId: () => 'id-order'
      });
    });

    expect(order).toEqual(['storage', 'lock']);
  });

  it('reclaims the bytes of an import that broke before the kernel saw it', async () => {
    // Reading the file back fails — a revoked blob URL, a file the user moved
    // or unplugged mid-import. The bytes were already written by then, and no
    // verdict on them exists or ever will.
    //
    // These are as abandoned as a refusal's, and the distinction matters
    // because the two look identical from outside: neither committed. Keeping
    // them would be the quiet direction to be wrong in — the retry writes
    // nothing, since content addressing lands it on this same key, and so it
    // would find bytes it did not create and decline to clean them up forever.
    const manager = new CommandManager(
      createProjectDocument('Broken read', toUserId('user_broken_read'))
    );
    const device = createDevice();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(tabHost(manager, acceptsEverything()))
    );
    const session = importSession(device, manager, () =>
      result.current.reserve()
    );
    const statuses: string[] = [];

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await runStepImport({
        file: {
          name: file.name,
          size: file.bytes.length,
          type: 'model/step',
          text: () => Promise.reject(new Error('The file could not be read.'))
        } as unknown as File,
        contentType: 'model/step',
        store: deviceStore(device, file),
        archive: async () => 'artifact_cloud_step',
        validatedFeature: {
          reserve: session.reserve,
          run: () => {
            throw new Error('the kernel must never be reached');
          }
        },
        status: {
          setStatus: (message) => statuses.push(message),
          setFeatureFormError: () => undefined
        },
        marks: session.marks,
        currentDocument: session.document,
        editDisabledReason: () => null,
        newId: () => 'id-broken'
      });
    });

    expect(outcome?.outcome).toBe('failed');
    expect(statuses).toEqual(['The file could not be read.']);
    // Written, then reclaimed — not merely never written.
    expect(outcome?.sourceBlobCreated).toBe(true);
    expect(outcome?.sourceDeleted).toBe(true);
    expect(device.deleteRequests).toEqual([file.checksum]);
    expect(device.blobs.has(file.checksum)).toBe(false);
    // The lock is free again, or the tab is finished for every later operation.
    const afterwards = result.current.reserve();
    expect(afterwards).not.toBeNull();
    afterwards?.release();
  });

  it('imports a small file with the source embedded when there is no storage', async () => {
    // Private browsing, or storage denied. A file small enough to embed needs no
    // blob store at all, which is how every import worked before
    // content-addressed references — so this is not a reason to decline.
    const device = createDevice();
    const { session, result, manager, statuses } = oneTab(device);

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await importOnce(file, {
        ...session,
        readiness: 'unavailable',
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(outcome?.outcome).toBe('committed');
    // Nothing was written to a store that could not be written to.
    expect(device.blobs.size).toBe(0);
    expect(statuses).not.toContain(STORAGE_UNAVAILABLE_STATUS);
    // The feature landed carrying its own source text, as every import did
    // before content-addressed references.
    const [feature] = listFeaturesInOrder(manager.document);
    expect(feature?.data.featureKind).toBe('imported-step');
    expect(
      feature?.data.featureKind === 'imported-step' && feature.data.stepText
    ).toBe(file.bytes);
  });

  it('declines a file too large to embed when there is no storage', async () => {
    // The other half of the same rule: past the embedding cap there is nowhere
    // for the bytes to go, so the import stops — and it stops before the commit
    // lock is ever taken, because nothing about it can succeed.
    const device = createDevice();
    const { session, statuses } = oneTab(device);

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await importOnce(file, {
        ...session,
        readiness: 'unavailable',
        fileSize: 40 * 1024 * 1024,
        limits: { maxEmbeddedBytes: 12 * 1024 * 1024 },
        run: () => {
          throw new Error('the run must not be reached');
        }
      });
    });

    expect(outcome?.outcome).toBe('declined');
    expect(statuses).toEqual([STORAGE_UNAVAILABLE_STATUS]);
    expect(device.blobs.size).toBe(0);
  });

  it('declines a blocked schema upgrade before taking the commit lock', async () => {
    const device = createDevice();
    const { session, statuses } = oneTab(device);
    const reserve = vi.fn(session.reserve);

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await importOnce(file, {
        ...session,
        reserve,
        readiness: 'blocked',
        run: () => {
          throw new Error('the run must not be reached');
        }
      });
    });

    expect(outcome?.outcome).toBe('declined');
    expect(reserve).not.toHaveBeenCalled();
    expect(statuses).toEqual([LOCAL_STORAGE_BLOCKED_MESSAGE]);
    expect(device.blobs.size).toBe(0);
  });

  it('never writes bytes for a file over the reference-form cap', async () => {
    const device = createDevice();
    const { session, statuses } = oneTab(device);

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await importOnce(file, {
        ...session,
        fileSize: 260 * 1024 * 1024,
        run: () => {
          throw new Error('the run must not be reached');
        }
      });
    });

    expect(outcome?.outcome).toBe('declined');
    expect(statuses).toEqual(['STEP import is limited to 128 MB.']);
    expect(device.blobs.size).toBe(0);
  });

  it('takes its own in-flight mark down again when the run is over', async () => {
    // The mark is what stops a concurrent import of the same file pruning
    // these bytes. Left up, it also stops THIS tab's next refused import of the
    // same file from ever cleaning up after itself — a leak that survives until
    // the tab is closed, and one no single import can notice.
    const device = createDevice();
    const { session, result } = oneTab(device);
    let markedDuringRun = false;

    await act(async () => {
      await importOnce(file, {
        ...session,
        run: (command, options) => {
          markedDuringRun = session.marks.inFlight.has(file.checksum);
          return result.current.run(command, options);
        }
      });
    });

    expect(markedDuringRun).toBe(true);
    expect(session.marks.inFlight.has(file.checksum)).toBe(false);
  });

  it('says whether the source reached the account or only this device', async () => {
    // Two different situations wearing one word. A source that never uploaded
    // is a project only this machine can rebuild, and the File menu's retry is
    // the way out of it — but only for someone who knows they are in it.
    const device = createDevice();
    const { session, result, statuses } = oneTab(device);

    await act(async () => {
      await importOnce(file, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      });
    });
    expect(statuses.at(-1)).toBe(
      'Imported editable STEP solid from Frame.step: exact body rebuilt, source archived.'
    );

    const offline = oneTab(createDevice());
    await act(async () => {
      await runStepImport({
        file: uploadedFile(file),
        contentType: 'model/step',
        store: deviceStore(offline.session.device, file),
        archive: () =>
          Promise.reject(new Error('Artifact upload is unavailable.')),
        validatedFeature: {
          reserve: offline.session.reserve,
          run: (command, options) =>
            offline.result.current.run(command, options)
        },
        status: {
          setStatus: (message) => offline.statuses.push(message),
          setFeatureFormError: () => undefined
        },
        marks: offline.session.marks,
        currentDocument: offline.session.document,
        editDisabledReason: () => null,
        newId: () => 'id-offline'
      });
    });
    expect(offline.statuses.at(-1)).toBe(
      'Imported editable STEP solid from Frame.step: exact body rebuilt (cloud archive unavailable; source saved locally).'
    );
  });

  it('spends no upload on an import the commit is no longer allowed to make', async () => {
    // Edit permission can flip during a rebuild that takes minutes — View mode,
    // or the project opened in a second tab. Archiving anyway transfers up to
    // 250 MB and mints an artifact the commit is then refused, so nothing ever
    // points at it.
    const device = createDevice();
    const manager = new CommandManager(
      createProjectDocument('Import', toUserId('user_import_run'))
    );
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(tabHost(manager, acceptsEverything()))
    );
    const session = importSession(device, manager, () =>
      result.current.reserve()
    );
    const archived = vi.fn(async () => 'artifact_cloud_step');

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await runStepImport({
        file: uploadedFile(file),
        contentType: 'model/step',
        store: deviceStore(device, file),
        archive: archived,
        validatedFeature: {
          reserve: session.reserve,
          run: (command, options) => result.current.run(command, options)
        },
        status: {
          setStatus: () => undefined,
          setFeatureFormError: () => undefined
        },
        marks: session.marks,
        currentDocument: session.document,
        editDisabledReason: () => 'View mode is read-only',
        newId: () => 'id-readonly'
      });
    });

    expect(archived).not.toHaveBeenCalled();
    expect(outcome?.outcome).toBe('rejected');
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
  });

  it('keeps a refusal out of whatever form happens to be open', async () => {
    // The host's inline sink renders in the feature form the user is editing.
    // An import has no form of its own, so routing its refusal there shows a
    // STEP parse error as the refusal of an unrelated operation.
    const device = createDevice();
    const manager = new CommandManager(
      createProjectDocument('Import', toUserId('user_import_run'))
    );
    const hostFailure = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        tabHost(manager, refusesFile('Frame'), { onFailure: hostFailure })
      )
    );
    const session = importSession(device, manager, () =>
      result.current.reserve()
    );

    await act(async () => {
      await importOnce(file, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(hostFailure).not.toHaveBeenCalled();
  });

  it('does not turn a failed cleanup into a second verdict on the import', async () => {
    // The cleanup runs after the import has already succeeded or failed on its
    // own terms. Storage failing there leaves the bytes in place, which is the
    // safe direction — an orphaned blob is a leak, a deleted one is the source
    // of somebody's committed feature — and there is nothing the user could do
    // about it. So it must not reject out of the handler and contradict the
    // verdict already on screen.
    const device = createDevice();
    const manager = new CommandManager(
      createProjectDocument('Import', toUserId('user_import_run'))
    );
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(tabHost(manager, refusesFile('Frame')))
    );
    const session = importSession(device, manager, () =>
      result.current.reserve()
    );

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await runStepImport({
        file: uploadedFile(file),
        contentType: 'model/step',
        store: {
          ...deviceStore(device, file),
          deleteSourceBlobIfUnreferenced: () => {
            throw new Error('IndexedDB unavailable.');
          }
        },
        archive: async () => 'artifact_cloud_step',
        validatedFeature: {
          reserve: session.reserve,
          run: (command, options) => result.current.run(command, options)
        },
        status: {
          setStatus: () => undefined,
          setFeatureFormError: () => undefined
        },
        marks: session.marks,
        currentDocument: session.document,
        editDisabledReason: () => null,
        newId: () => 'id-cleanup-failed'
      });
    });

    expect(outcome?.outcome).toBe('rejected');
    expect(outcome?.sourceDeleted).toBe(false);
    // Kept, not deleted: the failure leaves the device exactly as it was.
    expect(device.blobs.get(file.checksum)).toBe(file.bytes);
  });

  it('reclaims the bytes of a file the kernel refused', async () => {
    const device = createDevice();
    const manager = new CommandManager(
      createProjectDocument('Import', toUserId('user_import_run'))
    );
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(tabHost(manager, refusesFile('Frame')))
    );
    const session = importSession(device, manager, () =>
      result.current.reserve()
    );

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await importOnce(file, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(outcome?.outcome).toBe('rejected');
    expect(outcome?.sourceDeleted).toBe(true);
    expect(device.blobs.size).toBe(0);
    expect(device.deleteRequests).toEqual([file.checksum]);
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
  });
});

describe('importing the same file twice at once', () => {
  const file = {
    name: 'Frame.step',
    checksum: 'sha256-frame',
    bytes: 'ISO-10303-21;'
  };

  it('keeps the source blob the first import is still validating against', async () => {
    // Storage is content-addressed and device-global, so the second import
    // lands on the SAME key. It bounces off the commit lock without validating
    // anything — and used to be indistinguishable from a kernel refusal, so it
    // pruned the bytes the first import was about to commit against.
    const manager = new CommandManager(
      createProjectDocument('Twice', toUserId('user_double_import'))
    );
    const device = createDevice();
    const gate = deferred<void>();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        tabHost(manager, acceptsEverything(gate.promise))
      )
    );

    const session = importSession(device, manager, () =>
      result.current.reserve()
    );
    let firstOutcome: StepImportResult | undefined;
    let secondOutcome: StepImportResult | undefined;
    await act(async () => {
      const first = importOnce(file, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      }).then((outcome) => {
        firstOutcome = outcome;
      });
      secondOutcome = await importOnce(file, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      });
      gate.settle();
      await first;
    });

    // The bytes the committed feature rebuilds from are still there.
    expect(device.blobs.get(file.checksum)).toBe(file.bytes);
    expect(secondOutcome?.outcome).toBe('declined');
    expect(firstOutcome?.outcome).toBe('committed');
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
    const device = createDevice();
    const upload = deferred<void>();
    let refuseSecond = false;
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        tabHost(manager, async (candidate: ProjectDocument) =>
          derivedFromCandidate(
            candidate,
            refuseSecond
              ? [`Feature "Frame": ${DANGLING_REFERENCE_PARSE_ERROR}`]
              : []
          )
        )
      )
    );

    const session = importSession(device, manager, () =>
      result.current.reserve()
    );
    let firstOutcome: StepImportResult | undefined;
    let secondOutcome: StepImportResult | undefined;
    await act(async () => {
      const first = importOnce(file, {
        ...session,
        archiving: upload.promise,
        run: (command, options) => result.current.run(command, options)
      }).then((outcome) => {
        firstOutcome = outcome;
      });
      await flush();
      refuseSecond = true;
      secondOutcome = await importOnce(file, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      });
      refuseSecond = false;
      upload.settle();
      await first;
    });

    expect(device.blobs.get(file.checksum)).toBe(file.bytes);
    expect(secondOutcome?.outcome).toBe('rejected');
    expect(secondOutcome?.sourceDeleted).toBe(false);
    expect(firstOutcome?.outcome).toBe('committed');
    expect(listFeaturesInOrder(manager.document)).toHaveLength(1);
  });

  it('keeps the bytes a concurrent import committed against while the first cleans up', async () => {
    // The first import created the bytes and is refused after its upload, so it
    // is the one entitled to delete them. By then a second import of the same
    // file has finished and released every mark it held — and content
    // addressing means the feature it committed points at this very checksum.
    //
    // What says the bytes must stay is the open document: the second import's
    // committed feature names this very checksum, and the first import reads
    // that before it decides.
    const manager = new CommandManager(
      createProjectDocument('Twice', toUserId('user_double_import'))
    );
    const device = createDevice();
    const upload = deferred<void>();
    let refuseCommit = false;
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        tabHost(manager, acceptsEverything(), {
          refuseCommit: () => refuseCommit
        })
      )
    );

    const session = importSession(device, manager, () =>
      result.current.reserve()
    );
    let firstOutcome: StepImportResult | undefined;
    let secondOutcome: StepImportResult | undefined;
    await act(async () => {
      const first = importOnce(file, {
        ...session,
        archiving: upload.promise,
        run: (command, options) => result.current.run(command, options)
      }).then((outcome) => {
        firstOutcome = outcome;
      });
      await flush();
      // The lock is free while the first import uploads, so this one runs to
      // completion inside that window: it writes its bytes, validates, commits,
      // and lets go of every tab-local hold on the checksum.
      secondOutcome = await importOnce(file, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      });
      expect(secondOutcome.outcome).toBe('committed');
      expect(importSourceChecksums(manager.document).has(file.checksum)).toBe(
        true
      );

      // The project went read-only during the upload: accepted by the kernel,
      // refused by the commit, so the first import's bytes look abandoned.
      refuseCommit = true;
      upload.settle();
      await first;
    });

    expect(firstOutcome?.outcome).toBe('rejected');
    expect(firstOutcome?.sourceDeleted).toBe(false);
    expect(device.blobs.get(file.checksum)).toBe(file.bytes);
    // Not merely undeleted: never even asked for. The store deletes whatever it
    // is handed, so a run that asked would have destroyed the committed
    // feature's source and this assertion is the one that catches it.
    expect(device.deleteRequests).toEqual([]);
    expect(listFeaturesInOrder(manager.document)).toHaveLength(1);
  });

  it('keeps bytes a concurrent import is still holding, with nothing else to say so', async () => {
    // The in-flight mark carrying the decision ALONE, which is the only way to
    // know it is wired in at all.
    //
    // Every other guard is arranged to be silent here. The first import created
    // the bytes, so ownership does not stop it. Neither import has committed,
    // so the open document names nothing. The first import has already released
    // its own mark by the time it decides. The one remaining fact is that a
    // SECOND import is parked mid-run holding the same checksum — and content
    // addressing means it is about to commit against these exact bytes.
    const manager = new CommandManager(
      createProjectDocument('Held', toUserId('user_held_import'))
    );
    const device = createDevice();
    const firstUpload = deferred<void>();
    const secondUpload = deferred<void>();
    let refuseCommit = false;
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        tabHost(manager, acceptsEverything(), {
          refuseCommit: () => refuseCommit
        })
      )
    );
    // ONE session, so both imports share this tab's marks — as they do in the
    // app, where the marks live for the life of the window.
    const session = importSession(device, manager, () =>
      result.current.reserve()
    );

    let firstOutcome: StepImportResult | undefined;
    let secondOutcome: StepImportResult | undefined;
    await act(async () => {
      const first = importOnce(file, {
        ...session,
        archiving: firstUpload.promise,
        run: (command, options) => result.current.run(command, options)
      }).then((outcome) => {
        firstOutcome = outcome;
      });
      await flush();
      // The lock is free while the first import uploads, so the second gets in
      // and parks in its own upload, still holding its mark.
      const second = importOnce(file, {
        ...session,
        archiving: secondUpload.promise,
        run: (command, options) => result.current.run(command, options)
      }).then((outcome) => {
        secondOutcome = outcome;
      });
      await flush();

      // The first import comes back to a project it may no longer write to, so
      // it is refused and reaches its cleanup while the second is still parked.
      refuseCommit = true;
      firstUpload.settle();
      await first;

      expect(firstOutcome?.outcome).toBe('rejected');
      // Never asked. The store deletes whatever it is handed, so a run that
      // asked would already have taken the second import's source with it.
      expect(device.deleteRequests).toEqual([]);
      expect(device.blobs.get(file.checksum)).toBe(file.bytes);

      // And the second import lands on bytes that were still there for it.
      refuseCommit = false;
      secondUpload.settle();
      await second;
    });

    expect(secondOutcome?.outcome).toBe('committed');
    expect(device.blobs.get(file.checksum)).toBe(file.bytes);
    expect(importSourceChecksums(manager.document).has(file.checksum)).toBe(
      true
    );
  });

  it('keeps the bytes of a run the hook never judged', async () => {
    // `run` reports `busy` for a tab with no open project, and it does so
    // without ever consulting the kernel. Nothing was decided about this file,
    // so its bytes are not garbage — the obvious next step is the same import
    // again, and content addressing means a retry that found them deleted would
    // have to transfer the whole file a second time.
    //
    // Treating this as a refusal is the destructive direction, and the outcome
    // alone does not distinguish the two: both are "not committed".
    const manager = new CommandManager(
      createProjectDocument('No project', toUserId('user_no_project'))
    );
    const device = createDevice();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        ...tabHost(manager, acceptsEverything()),
        // Closed between the reservation and the run, which the hook answers
        // with `busy` rather than a verdict.
        manager: () => null
      })
    );
    const session = importSession(device, manager, () =>
      result.current.reserve()
    );

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await importOnce(file, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(outcome?.outcome).toBe('busy');
    expect(outcome?.sourceDeleted).toBe(false);
    expect(device.deleteRequests).toEqual([]);
    expect(device.blobs.get(file.checksum)).toBe(file.bytes);
    // And the tab keeps its licence, so a later run of its own can still
    // reclaim them rather than leaking them forever.
    expect(session.marks.abandoned.has(file.checksum)).toBe(true);
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
    const device = createDevice();
    const gate = deferred<void>();
    let refuseRetry = false;
    const statuses: string[] = [];
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        tabHost(manager, async (candidate: ProjectDocument) => {
          await gate.promise;
          return derivedFromCandidate(
            candidate,
            refuseRetry
              ? [`Feature "Retry": ${DANGLING_REFERENCE_PARSE_ERROR}`]
              : []
          );
        })
      )
    );

    const held = {
      name: 'Running.step',
      checksum: 'sha256-running',
      bytes: 'ISO-10303-21; /* a */'
    };
    const rejectedFile = {
      name: 'Retry.step',
      checksum: 'sha256-second',
      bytes: 'ISO-10303-21; /* b */'
    };
    const session = importSession(
      device,
      manager,
      () => result.current.reserve(),
      (message) => statuses.push(message)
    );
    let turnedAwayOutcome: StepImportResult | undefined;
    let retryOutcome: StepImportResult | undefined;
    const inlineErrors: string[] = [];
    await act(async () => {
      const first = importOnce(held, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      });
      turnedAwayOutcome = await importOnce(rejectedFile, {
        ...session,
        onFeatureFormError: (message) => inlineErrors.push(message),
        run: (command, options) => result.current.run(command, options)
      });
      gate.settle();
      await first;

      expect(turnedAwayOutcome.outcome).toBe('declined');
      expect(statuses).toEqual([VALIDATED_FEATURE_BUSY_STATUS]);
      // BOTH surfaces. This refusal is decided by the run itself — the lock was
      // never free, so the hook is never reached and its own busy reporting
      // cannot cover this path. The status bar alone leaves the open feature
      // form, which is what the user is actually looking at, saying nothing.
      expect(inlineErrors).toEqual([VALIDATED_FEATURE_BUSY_STATUS]);
      // Nothing was written, so nothing is left to leak.
      expect(device.blobs.has(rejectedFile.checksum)).toBe(false);

      // And the retry, once the lock is free, still owns what it writes: the
      // kernel refuses this file, and its bytes go with it.
      refuseRetry = true;
      retryOutcome = await importOnce(rejectedFile, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(retryOutcome?.outcome).toBe('rejected');
    expect(device.blobs.has(rejectedFile.checksum)).toBe(false);
    expect(device.blobs.get(held.checksum)).toBe(held.bytes);
  });

  it('writes no source bytes while another import is still storing its own', async () => {
    // The window a busy CHECK leaves open, and the reason the lock is reserved
    // instead. Between asking whether the lock was free and the run that takes
    // it, an import hashes and stores up to 250 MB and parses the header —
    // seconds to minutes. A second import starting inside that window was told
    // the lock was free, wrote its own bytes, and only then bounced off the run:
    // exactly the orphan the check existed to prevent.
    const manager = new CommandManager(
      createProjectDocument('Storing', toUserId('user_storing_import'))
    );
    const device = createDevice();
    const storing = deferred<void>();
    const statuses: string[] = [];
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(tabHost(manager, acceptsEverything()))
    );

    const held = {
      name: 'Storing.step',
      checksum: 'sha256-storing',
      bytes: 'ISO-10303-21; /* a */'
    };
    const blocked = {
      name: 'Blocked.step',
      checksum: 'sha256-blocked',
      bytes: 'ISO-10303-21; /* b */'
    };
    const session = importSession(
      device,
      manager,
      () => result.current.reserve(),
      (message) => statuses.push(message)
    );
    let blockedOutcome: StepImportResult | undefined;
    await act(async () => {
      // Reserved, and now sitting in its own storage write — the run has not
      // started, so `isRunning()` would have said "free".
      const storingImport = importOnce(held, {
        ...session,
        storing: storing.promise,
        run: (command, options) => result.current.run(command, options)
      });
      await flush();

      blockedOutcome = await importOnce(blocked, {
        ...session,
        run: (command, options) => result.current.run(command, options)
      });

      storing.settle();
      await storingImport;
    });

    expect(blockedOutcome?.outcome).toBe('declined');
    expect(statuses).toEqual([VALIDATED_FEATURE_BUSY_STATUS]);
    expect(device.blobs.has(blocked.checksum)).toBe(false);
    expect(device.blobs.get(held.checksum)).toBe(held.bytes);
  });

  it('leaves the commit lock free when storage cannot be opened', async () => {
    // Opening the blob store is the browser's to schedule, and asked for under
    // the commit lock it takes the lock with it for however long that costs. A
    // stranded commit lock disables every validated operation in the tab until
    // it is reloaded, so the question is asked FIRST — and when the answer ends
    // the import, the lock is still there for the next thing that wants it.
    const manager = new CommandManager(
      createProjectDocument('No storage', toUserId('user_no_storage'))
    );
    const device = createDevice();
    const statuses: string[] = [];
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(tabHost(manager, acceptsEverything()))
    );

    const file = {
      name: 'Denied.step',
      checksum: 'sha256-denied',
      bytes: 'ISO-10303-21; /* a */'
    };
    const session = importSession(
      device,
      manager,
      () => result.current.reserve(),
      (message) => statuses.push(message)
    );
    const reserved: Array<ValidatedFeatureReservation | null> = [];

    let deniedOutcome: StepImportResult | undefined;
    let laterOutcome: StepImportResult | undefined;
    await act(async () => {
      deniedOutcome = await importOnce(file, {
        ...session,
        readiness: 'unavailable',
        // Too large to embed, so no storage really is the end of this import.
        fileSize: 40 * 1024 * 1024,
        limits: { maxEmbeddedBytes: 12 * 1024 * 1024 },
        reserve: () => {
          const reservation = result.current.reserve();
          reserved.push(reservation);
          return reservation;
        },
        run: (command, options) => result.current.run(command, options)
      });

      // The proof that nothing was stranded: a later operation still gets the
      // lock. An open taken under it and left waiting would have parked this.
      laterOutcome = await importOnce(
        {
          name: 'Later.step',
          checksum: 'sha256-later',
          bytes: 'ISO-10303-21; /* b */'
        },
        {
          ...session,
          run: (command, options) => result.current.run(command, options)
        }
      );
    });

    expect(deniedOutcome?.outcome).toBe('declined');
    // The lock was never even asked for, so nothing could have been left
    // holding it.
    expect(reserved).toEqual([]);
    expect(statuses).toEqual([STORAGE_UNAVAILABLE_STATUS]);
    // Nor were any bytes written for an import that never started.
    expect(device.blobs.has(file.checksum)).toBe(false);
    expect(laterOutcome?.outcome).toBe('committed');
  });
});

/**
 * Two tabs, one device. Each has its own hook, its own in-flight marks, its own
 * abandoned-bytes note and its own open project — and they share one blob
 * store, because IndexedDB belongs to the origin and not to the window.
 *
 * That is the whole hazard: tab B is told `created: false` for bytes tab A is
 * committing a feature against, its own open document says nothing about them,
 * and every guard tab B can consult on its own says they are free.
 *
 * THE POSTURE, and what these tests pin. Only the tab that WROTE a key ever
 * deletes it, only when it wrote it in this import (or in an earlier one of its
 * own that reached no verdict), and only when its live document does not
 * reference it. That is unreachable from any tab that did not write the key, so
 * a refusal in one window cannot destroy bytes another window needs — however
 * certain it is, and whether or not the other tab has saved anything yet.
 *
 * The price is a leak, and it is the deliberate side to be wrong on: bytes
 * written by a tab that was closed mid-import are collected by nobody, up to
 * 250 MB per orphaned import. A leaked blob costs disk; a wrongly deleted one
 * costs somebody's model.
 */
describe('two tabs importing one file', () => {
  const file = {
    name: 'Bracket.step',
    checksum: 'sha256-bracket',
    bytes: 'ISO-10303-21; /* b */'
  };

  function twoTabs() {
    const device = createDevice();
    const managerA = new CommandManager(
      createProjectDocument('Project A', toUserId('user_tab_a'))
    );
    const managerB = new CommandManager(
      createProjectDocument('Project B', toUserId('user_tab_b'))
    );
    return { device, managerA, managerB };
  }

  it('keeps a second tab commit safe from the creating tab later refusing', async () => {
    // The hole sourceBlobClaims exists to close. Tab A created the key but
    // reached no verdict, so its tab-local abandoned note licenses a retry to
    // clean it up. Tab B then commits the same file before autosave persists its
    // document. Its device-wide claim is the only evidence visible to tab A.
    const { device, managerA, managerB } = twoTabs();
    const tabA = renderHook(() =>
      useValidatedFeatureCommit(tabHost(managerA, acceptsEverything()))
    );
    const tabB = renderHook(() =>
      useValidatedFeatureCommit(tabHost(managerB, acceptsEverything()))
    );
    const sessionA = importSession(device, managerA, () =>
      tabA.result.current.reserve()
    );
    const sessionB = importSession(device, managerB, () =>
      tabB.result.current.reserve()
    );

    let noVerdict: StepImportResult | undefined;
    let committed: StepImportResult | undefined;
    let refusedRetry: StepImportResult | undefined;
    await act(async () => {
      noVerdict = await importOnce(file, {
        ...sessionA,
        run: async () => 'superseded'
      });
      committed = await importOnce(file, {
        ...sessionB,
        run: async () => 'committed'
      });
      refusedRetry = await importOnce(file, {
        ...sessionA,
        run: async () => 'rejected'
      });
    });

    expect(noVerdict?.outcome).toBe('superseded');
    expect(sessionA.marks.abandoned.has(file.checksum)).toBe(true);
    expect(committed?.outcome).toBe('committed');
    expect(refusedRetry?.outcome).toBe('rejected');
    expect(refusedRetry?.sourceDeleted).toBe(false);
    // Tab A did ask, and the shared store refused because tab B's claim still
    // bridges its commit to autosave. This distinguishes the new subsystem from
    // the older created:false guard, which does not apply to tab A's retry.
    expect(device.deleteRequests).toEqual([file.checksum]);
    expect(device.blobs.get(file.checksum)).toBe(file.bytes);
    expect(device.claims.get(file.checksum)?.size).toBe(1);
  });

  it('never deletes bytes it did not write, however free they look', async () => {
    // The load-bearing test. Tab A imported this file and committed a feature
    // against it. Tab B then imports the SAME file: content addressing lands it
    // on the same key, so nothing is written, and the kernel refuses tab B's
    // copy. Everything tab B can see says the bytes are unwanted — its own
    // document does not name them, no import of its own is in flight, and
    // project A is not open in this window.
    //
    // `created: false` is the entire defence, and it is enough.
    const { device, managerA, managerB } = twoTabs();

    const tabA = renderHook(() =>
      useValidatedFeatureCommit(tabHost(managerA, acceptsEverything()))
    );
    const tabB = renderHook(() =>
      useValidatedFeatureCommit(tabHost(managerB, refusesFile('Bracket')))
    );
    const sessionA = importSession(device, managerA, () =>
      tabA.result.current.reserve()
    );
    const sessionB = importSession(device, managerB, () =>
      tabB.result.current.reserve()
    );

    let outcomeA: StepImportResult | undefined;
    let outcomeB: StepImportResult | undefined;
    await act(async () => {
      outcomeA = await importOnce(file, {
        ...sessionA,
        run: (command, options) => tabA.result.current.run(command, options)
      });
      outcomeB = await importOnce(file, {
        ...sessionB,
        run: (command, options) => tabB.result.current.run(command, options)
      });
    });

    expect(outcomeA?.outcome).toBe('committed');
    expect(outcomeB?.outcome).toBe('rejected');
    expect(outcomeB?.sourceDeleted).toBe(false);
    // Never asked, not merely refused: the store deletes whatever it is handed,
    // so a run that asked would have taken the source of tab A's feature with
    // it. Tab A has saved nothing — this is exactly the window in which no
    // amount of reading the device would have said otherwise.
    expect(device.deleteRequests).toEqual([]);
    expect(device.blobs.get(file.checksum)).toBe(file.bytes);
    expect(
      listFeaturesInOrder(managerA.document).map((feature) => feature.name)
    ).toEqual(['Bracket']);
    // Nothing landed in the refusing tab's own project.
    expect(listFeaturesInOrder(managerB.document)).toHaveLength(0);
  });

  it('leaves the licence with the tab that wrote the bytes, and nowhere else', async () => {
    // The other direction of the same rule, and the reason the leak is a leak.
    // Tab A wrote these bytes in an earlier run that reached no verdict, so tab
    // A — and only tab A — still counts them as its own to clean up. Tab B's
    // refused import of the same file finds a key it did not create and stops,
    // and no amount of refusing lets it acquire the licence: `abandoned` is
    // only ever added to below that guard.
    const { device, managerA, managerB } = twoTabs();

    const tabA = renderHook(() =>
      useValidatedFeatureCommit(tabHost(managerA, refusesFile('Bracket')))
    );
    const tabB = renderHook(() =>
      useValidatedFeatureCommit(tabHost(managerB, refusesFile('Bracket')))
    );
    const sessionA = importSession(device, managerA, () =>
      tabA.result.current.reserve()
    );
    const sessionB = importSession(device, managerB, () =>
      tabB.result.current.reserve()
    );

    device.blobs.set(file.checksum, file.bytes);
    sessionA.marks.abandoned.add(file.checksum);

    let outcomeB: StepImportResult | undefined;
    let retryA: StepImportResult | undefined;
    await act(async () => {
      outcomeB = await importOnce(file, {
        ...sessionB,
        run: (command, options) => tabB.result.current.run(command, options)
      });
      retryA = await importOnce(file, {
        ...sessionA,
        run: (command, options) => tabA.result.current.run(command, options)
      });
    });

    expect(outcomeB?.outcome).toBe('rejected');
    expect(outcomeB?.sourceDeleted).toBe(false);
    // Tab B's refusal did not hand it the licence either.
    expect(sessionB.marks.abandoned.has(file.checksum)).toBe(false);
    // Tab A's own retry is refused too, and its bytes go with it — otherwise a
    // genuine kernel refusal would keep 250 MB on the device forever, since
    // content addressing means the retry writes nothing.
    expect(retryA?.outcome).toBe('rejected');
    expect(retryA?.sourceDeleted).toBe(true);
    expect(device.deleteRequests).toEqual([file.checksum]);
    expect(device.blobs.has(file.checksum)).toBe(false);
  });

  it('still reclaims bytes no other tab ever wrote', async () => {
    // The counterweight: a refusal must still be able to free its own 250 MB,
    // or the rule above would have traded data loss for an unbounded leak.
    // Nothing else on the device has ever seen this file.
    const { device, managerB } = twoTabs();
    const tabB = renderHook(() =>
      useValidatedFeatureCommit(tabHost(managerB, refusesFile('Bracket')))
    );
    const sessionB = importSession(device, managerB, () =>
      tabB.result.current.reserve()
    );

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await importOnce(file, {
        ...sessionB,
        run: (command, options) => tabB.result.current.run(command, options)
      });
    });

    expect(outcome?.outcome).toBe('rejected');
    expect(outcome?.sourceDeleted).toBe(true);
    expect(device.deleteRequests).toEqual([file.checksum]);
    expect(device.blobs.has(file.checksum)).toBe(false);
  });
});

/**
 * What the progress card is told, taken off the REAL run rather than a
 * description of it. The card can only be as truthful as this sequence: a
 * phase emitted in the wrong place, or an ending mapped to the wrong tone, is
 * a panel confidently reporting something that did not happen.
 */
describe('what an import reports while it runs', () => {
  const file = {
    name: 'Frame.step',
    checksum: 'sha256-frame',
    bytes: 'ISO-10303-21;'
  };

  function recorder(): ImportProgressSink & {
    phases: ImportPhase[];
    updates: ImportRunProgress[];
    started: { fileName: string; phases: readonly ImportPhase[] } | null;
    ended: ImportRunOutcome | null;
  } {
    const sink = {
      phases: [] as ImportPhase[],
      updates: [] as ImportRunProgress[],
      started: null as { fileName: string; phases: readonly ImportPhase[] } | null,
      ended: null as ImportRunOutcome | null,
      start(input: { fileName: string; phases: readonly ImportPhase[] }) {
        sink.started = input;
      },
      update(progress: ImportRunProgress) {
        sink.updates.push(progress);
        if (sink.phases.at(-1) !== progress.phase) {
          sink.phases.push(progress.phase);
        }
      },
      finish(outcome: ImportRunOutcome) {
        sink.ended = outcome;
      }
    };
    return sink;
  }

  function oneTab(device: SharedDevice, derive = acceptsEverything()) {
    const manager = new CommandManager(
      createProjectDocument('Progress', toUserId('user_import_progress'))
    );
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(tabHost(manager, derive))
    );
    const session = importSession(device, manager, () =>
      result.current.reserve()
    );
    return { manager, result, session };
  }

  it('walks the phases in the order they actually happen', async () => {
    const device = createDevice();
    const { session, result } = oneTab(device);
    const progress = recorder();

    await act(async () => {
      await importOnce(file, {
        ...session,
        progress,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(progress.started?.fileName).toBe('Frame.step');
    expect(progress.started?.phases).toEqual([
      'saving',
      'reading',
      'building',
      'archiving'
    ]);
    expect(progress.phases).toEqual([
      'saving',
      'reading',
      'building',
      'archiving'
    ]);
  });

  /**
   * The kernel call is one synchronous trip into wasm. Reporting any fraction
   * for it would be an invention, and the card draws a null as a held, striped
   * bar precisely so it does not have to.
   */
  it('reports no fraction for the phase that cannot measure itself', async () => {
    const device = createDevice();
    const { session, result } = oneTab(device);
    const progress = recorder();

    await act(async () => {
      await importOnce(file, {
        ...session,
        progress,
        run: (command, options) => result.current.run(command, options)
      });
    });

    const building = progress.updates.filter(
      (update) => update.phase === 'building'
    );
    expect(building).not.toHaveLength(0);
    expect(building.every((update) => update.fraction === null)).toBe(true);
  });

  /**
   * A storage-denied session writes no blob, so it has no `saving` phase at
   * all. Announcing one would divide the bar over a phase that never runs and
   * start every such import a tenth of the way along.
   */
  it('leaves out the phase a storage-denied session never runs', async () => {
    const device = createDevice();
    const { session, result } = oneTab(device);
    const progress = recorder();

    await act(async () => {
      await importOnce(file, {
        ...session,
        readiness: 'unavailable',
        progress,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(progress.started?.phases).toEqual([
      'reading',
      'building',
      'archiving'
    ]);
    expect(progress.phases).not.toContain('saving');
  });

  it('ends a committed and archived import quietly', async () => {
    const device = createDevice();
    const { session, result } = oneTab(device);
    const progress = recorder();

    await act(async () => {
      await importOnce(file, {
        ...session,
        progress,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(progress.ended).toEqual({ tone: 'ok', message: 'Imported — 1 body' });
  });

  /**
   * The ending most worth surfacing: the body is in the model, but its source
   * never left this device, so no other device can rebuild the project. It is
   * the only ending that carries an action.
   */
  it('ends an unarchived import with the retry it needs', async () => {
    const device = createDevice();
    const { session, result } = oneTab(device);
    const progress = recorder();

    await act(async () => {
      await importOnce(file, {
        ...session,
        refuseArchive: true,
        progress,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(progress.ended).toEqual({
      tone: 'warning',
      message: 'Imported, but saved on this device only',
      action: 'archive'
    });
  });

  /**
   * The kernel's own words. They already reach the status bar, which the next
   * message overwrites; the card is this import's own surface and can keep
   * them.
   */
  it('ends a refusal with the reason the kernel gave', async () => {
    const device = createDevice();
    const { session, result } = oneTab(device, refusesFile('Frame'));
    const progress = recorder();

    await act(async () => {
      await importOnce(file, {
        ...session,
        progress,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(progress.ended?.tone).toBe('error');
    // The kernel's diagnosis, not a generic "import failed" — this is the one
    // sentence that tells the user what to fix upstream.
    expect(progress.ended?.message).toBe(DANGLING_REFERENCE_PARSE_ERROR);
    expect(progress.ended?.action).toBeUndefined();
  });

  /**
   * Turned away before any work started. The status bar already says why, and
   * a card that appeared and vanished in the same breath would read as a
   * glitch rather than as an answer.
   */
  it('says nothing at all for an import refused before it began', async () => {
    const device = createDevice();
    const { session, result } = oneTab(device);
    const progress = recorder();

    await act(async () => {
      await importOnce(file, {
        ...session,
        progress,
        fileSize: 900,
        limits: { maxSourceBytes: 100 },
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(progress.started).toBeNull();
    expect(progress.ended).toBeNull();
  });

  /** Every run that announces itself must also settle. A card left spinning
   * forever is worse than the single status line this replaces. */
  it('always settles a run it announced', async () => {
    const device = createDevice();
    const { session, result } = oneTab(device, refusesFile('Frame'));

    for (const variant of ['committed', 'refused', 'unarchived'] as const) {
      const progress = recorder();
      const tab = oneTab(
        createDevice(),
        variant === 'refused' ? refusesFile('Frame') : acceptsEverything()
      );
      await act(async () => {
        await importOnce(file, {
          ...tab.session,
          progress,
          ...(variant === 'unarchived' ? { refuseArchive: true } : {}),
          run: (command, options) => tab.result.current.run(command, options)
        });
      });
      expect(progress.started, variant).not.toBeNull();
      expect(progress.ended, variant).not.toBeNull();
    }

    // The busy path too: a second import bounced off the commit lock is
    // declined before it announces anything.
    const held = result.current.reserve();
    const progress = recorder();
    await act(async () => {
      await importOnce(file, {
        ...session,
        progress,
        run: (command, options) => result.current.run(command, options)
      });
    });
    expect(progress.started).toBeNull();
    held?.release();
    expect(device.blobs.size).toBe(0);
  });
});

/**
 * Cancelling, against the REAL orchestration.
 *
 * The stakes here are not cosmetic. A cancel decides whether up to 250 MB of
 * source bytes stay on the device forever, whether an upload is spent on a
 * result nobody wants, and whether a body the user stopped lands in history
 * anyway. Each of those is checked below by running the thing, not by reading
 * it.
 */
describe('cancelling an import', () => {
  const file = {
    name: 'Frame.step',
    checksum: 'sha256-frame',
    bytes: 'ISO-10303-21;'
  };

  function oneTab(device: SharedDevice, derive = acceptsEverything()) {
    const manager = new CommandManager(
      createProjectDocument('Cancel', toUserId('user_import_cancel'))
    );
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(tabHost(manager, derive))
    );
    const session = importSession(device, manager, () =>
      result.current.reserve()
    );
    return { manager, result, session };
  }

  it('stops before the file is ever stored when cancelled up front', async () => {
    const device = createDevice();
    const { session, result, manager } = oneTab(device);
    const abort = new AbortController();
    abort.abort();

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await importOnce(file, {
        ...session,
        signal: abort.signal,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(outcome?.outcome).toBe('cancelled');
    expect(device.blobs.size).toBe(0);
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
  });

  /**
   * The bytes are PRUNED, not kept. Nothing sweeps unreferenced blobs, so
   * keeping them would leave up to 250 MB on the device every time someone
   * changes their mind about an import.
   */
  it('takes back the bytes it wrote', async () => {
    const device = createDevice();
    const { session, result, manager } = oneTab(device);
    const abort = new AbortController();
    const gate = deferred<void>();

    let outcome: StepImportResult | undefined;
    await act(async () => {
      const running = importOnce(file, {
        ...session,
        signal: abort.signal,
        storing: gate.promise,
        run: (command, options) => result.current.run(command, options)
      });
      // Cancelled while the write is parked, so the bytes are already on the
      // device when the cancel lands — the case that leaks if this is wrong.
      abort.abort();
      gate.settle();
      outcome = await running;
    });

    expect(outcome?.outcome).toBe('cancelled');
    expect(outcome?.sourceDeleted).toBe(true);
    expect(device.blobs.has(file.checksum)).toBe(false);
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
  });

  /**
   * The rebuild cannot be interrupted, so it runs to completion — but its
   * result must not land, and the upload ahead of the commit must never
   * happen. Spending a 250 MB transfer on a withdrawn import is the expensive
   * way to get this wrong.
   */
  it('neither archives nor commits a rebuild cancelled while it ran', async () => {
    const device = createDevice();
    const manager = new CommandManager(
      createProjectDocument('Cancel', toUserId('user_cancel_rebuild'))
    );
    const abort = new AbortController();
    const rebuilding = deferred<void>();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        tabHost(manager, acceptsEverything(rebuilding.promise))
      )
    );
    const session = importSession(device, manager, () =>
      result.current.reserve()
    );
    let archiveCalls = 0;

    let outcome: StepImportResult | undefined;
    await act(async () => {
      const running = runStepImport({
        file: uploadedFile(file),
        contentType: 'model/step',
        store: deviceStore(device, file),
        signal: abort.signal,
        archive: async () => {
          archiveCalls += 1;
          return 'artifact_cloud_step';
        },
        validatedFeature: {
          reserve: session.reserve,
          run: (command, options) => result.current.run(command, options)
        },
        status: {
          setStatus: () => undefined,
          setFeatureFormError: () => undefined
        },
        marks: session.marks,
        currentDocument: session.document,
        editDisabledReason: () => null,
        newId: () => 'id-cancel-rebuild'
      });
      // The kernel is mid-rebuild and cannot be stopped; the cancel lands
      // while it is still running.
      abort.abort();
      rebuilding.settle();
      outcome = await running;
    });

    expect(outcome?.outcome).toBe('cancelled');
    expect(archiveCalls).toBe(0);
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
    expect(device.blobs.has(file.checksum)).toBe(false);
  });

  /** And the lock has to come back, or the tab is dead for every later edit. */
  it('gives the commit lock back', async () => {
    const device = createDevice();
    const { session, result } = oneTab(device);
    const abort = new AbortController();
    abort.abort();

    await act(async () => {
      await importOnce(file, {
        ...session,
        signal: abort.signal,
        run: (command, options) => result.current.run(command, options)
      });
    });

    const afterwards = result.current.reserve();
    expect(afterwards).not.toBeNull();
    afterwards?.release();
  });

  it('reports the ending as cancelled rather than as a failure', async () => {
    const device = createDevice();
    const { session, result } = oneTab(device);
    const abort = new AbortController();
    abort.abort();
    const endings: ImportRunOutcome[] = [];

    await act(async () => {
      await importOnce(file, {
        ...session,
        signal: abort.signal,
        progress: {
          start: () => undefined,
          update: () => undefined,
          finish: (outcome) => endings.push(outcome)
        },
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(endings).toEqual([{ tone: 'cancelled', message: 'Import cancelled' }]);
  });

  /**
   * A cancelled read must not be mistaken for "storage is unavailable". That
   * catch exists to fall back to embedding the file in the document — which
   * would complete, in full, the import the user just stopped.
   */
  it('does not fall back to embedding the file it was told to stop reading', async () => {
    const device = createDevice();
    const { session, result, manager } = oneTab(device);
    const abort = new AbortController();
    abort.abort();

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await runStepImport({
        file: uploadedFile(file),
        contentType: 'model/step',
        // A store that rejects the write, exactly as a storage-denied session
        // does: without the cancellation guard the run embeds and commits.
        store: deviceStore(device, file, { refuseWrite: true }),
        signal: abort.signal,
        archive: async () => 'artifact_cloud_step',
        validatedFeature: {
          reserve: session.reserve,
          run: (command, options) => result.current.run(command, options)
        },
        status: {
          setStatus: () => undefined,
          setFeatureFormError: () => undefined
        },
        marks: session.marks,
        currentDocument: session.document,
        editDisabledReason: () => null,
        newId: () => 'id-cancel-embed'
      });
    });

    expect(outcome?.outcome).toBe('cancelled');
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
  });

  /** An import left alone still commits; the guards must not fire on their own. */
  it('leaves an uncancelled import untouched', async () => {
    const device = createDevice();
    const { session, result, manager } = oneTab(device);
    const abort = new AbortController();

    let outcome: StepImportResult | undefined;
    await act(async () => {
      outcome = await importOnce(file, {
        ...session,
        signal: abort.signal,
        run: (command, options) => result.current.run(command, options)
      });
    });

    expect(outcome?.outcome).toBe('committed');
    expect(listFeaturesInOrder(manager.document)).toHaveLength(1);
    expect(device.blobs.has(file.checksum)).toBe(true);
  });

  /**
   * A cancel reaches the end of the run two different ways: THROWN, when it
   * stopped the read or landed on a phase boundary, and RETURNED by the commit
   * hook, when it stopped a rebuild that had to run to completion anyway.
   *
   * Only the thrown path passes through the run's catch. Saying this there
   * left the status bar reading "Checking … against exact geometry" forever
   * after every cancel during a rebuild — the long case, and the one anyone
   * would actually reach for. Both paths are checked here.
   */
  it('tells the status bar it was cancelled, whichever way the cancel arrived', async () => {
    const thrownPath: string[] = [];
    const device = createDevice();
    const first = oneTab(device);
    const abortEarly = new AbortController();
    abortEarly.abort();
    await act(async () => {
      await importOnce(file, {
        ...first.session,
        signal: abortEarly.signal,
        onStatus: (message) => thrownPath.push(message),
        run: (command, options) => first.result.current.run(command, options)
      });
    });
    expect(thrownPath.at(-1)).toBe(
      'Frame.step was not imported: you cancelled it.'
    );

    // Returned: the abort has to land while `derive` is genuinely in flight,
    // AFTER the phase-boundary check in front of the rebuild. Aborting any
    // earlier takes the thrown path and proves nothing about this one.
    const returnedPath: string[] = [];
    const secondDevice = createDevice();
    const manager = new CommandManager(
      createProjectDocument('Cancel', toUserId('user_cancel_status'))
    );
    const rebuilding = deferred<void>();
    const enteredRebuild = deferred<void>();
    const abortLate = new AbortController();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit(
        tabHost(
          manager,
          async (candidate: ProjectDocument) => {
            enteredRebuild.settle();
            await rebuilding.promise;
            return derivedFromCandidate(candidate);
          },
          { onStatus: (message) => returnedPath.push(message) }
        )
      )
    );
    const session = importSession(
      secondDevice,
      manager,
      () => result.current.reserve(),
      (message) => returnedPath.push(message)
    );
    await act(async () => {
      const running = importOnce(file, {
        ...session,
        signal: abortLate.signal,
        run: (command, options) => result.current.run(command, options)
      });
      await enteredRebuild.promise;
      abortLate.abort();
      rebuilding.settle();
      await running;
    });
    // The rebuild ran to completion and was then declined, so this is the
    // hook RETURNING 'cancelled' rather than the run throwing.
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
    expect(returnedPath.at(-1)).toBe(
      'Frame.step was not imported: you cancelled it.'
    );
  });
});