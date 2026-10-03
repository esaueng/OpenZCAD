import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  appendRevision,
  createCheckpoint,
  createProjectDocument,
  listFeaturesInOrder,
  normalizeDocument,
  restoreFromSaveState
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import { useLocalAutoFrame } from './useLocalAutoFrame';

function boxManager() {
  const manager = new CommandManager(
    createProjectDocument('Local framing', toUserId('user_local_framing'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, depth: 20, height: 20 }
    })
  );
  rebuild(manager, 20);
  return manager;
}

/** Publish a delayed worker result on the real document's body identity. */
function rebuild(manager: CommandManager, width: number) {
  const bodyId = manager.document.bodyOrder[0]!;
  const representation: BodyRepresentation = {
    bodyId,
    name: 'Box',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(),
      indices: new Uint32Array()
    },
    faceCount: 6,
    color: '#ffffff',
    exportableStep: true,
    consumed: false,
    volume: width * 20 * 20,
    bbox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: width, y: 20, z: 20 }
    }
  };
  return manager.commitDerivedState({
    ...manager.document.derived,
    bodyRepresentations: { [bodyId]: representation }
  });
}

function widen(manager: CommandManager, width = 200) {
  return manager.execute(
    commandFactories.updateFeature({
      featureId: listFeaturesInOrder(manager.document)[0]!.featureId,
      data: { dimensions: { width, depth: 20, height: 20 } }
    })
  );
}

function framing(document: ProjectDocument | null) {
  return renderHook(
    ({ document, ready, previewing }) =>
      useLocalAutoFrame(document, ready, previewing),
    {
      initialProps: { document, ready: true, previewing: false }
    }
  );
}

describe('useLocalAutoFrame', () => {
  it('waits for the local exact rebuild and never frames its preview', () => {
    const manager = boxManager();
    const before = manager.document.derived.bodyRepresentations;
    const hook = framing(manager.document);
    const committed = widen(manager);
    act(() => hook.result.current.recordLocalCommit(committed, before));
    hook.rerender({ document: committed, ready: false, previewing: false });
    expect(hook.result.current.autoFrame).toBeNull();
    const exact = rebuild(manager, 200);
    hook.rerender({ document: exact, ready: true, previewing: true });
    expect(hook.result.current.autoFrame).toBeNull();
    hook.rerender({ document: exact, ready: true, previewing: false });
    expect(hook.result.current.autoFrame).toEqual({
      before,
      after: exact.derived.bodyRepresentations
    });
  });

  for (const queued of [false, true]) {
    it.each([0, 2])(
      `cancels ${queued ? 'queued' : 'pending'} local framing when a same-project remote document is %i version(s) ahead`,
      (ahead) => {
        const manager = boxManager();
        const hook = framing(manager.document);
        const before = manager.document.derived.bodyRepresentations;
        const committed = widen(manager);
        act(() => hook.result.current.recordLocalCommit(committed, before));
        hook.rerender({ document: committed, ready: false, previewing: false });
        if (queued) {
          hook.rerender({
            document: rebuild(manager, 200),
            ready: true,
            previewing: false
          });
          expect(hook.result.current.autoFrame).not.toBeNull();
        }
        const remote = new CommandManager(normalizeDocument(committed));
        if (ahead) widen(remote, 400);
        expect(remote.document.projectId).toBe(committed.projectId);
        expect(remote.document.version).toBe(committed.version + ahead);
        // The successful hydrate cancels before publishing its document.
        act(() => hook.result.current.clearAutoFrame());
        hook.rerender({
          document: remote.document,
          ready: false,
          previewing: false
        });
        hook.rerender({
          document: rebuild(remote, 400),
          ready: true,
          previewing: false
        });
        expect(hook.result.current.autoFrame).toBeNull();
      }
    );

    it.each(['undo', 'redo'] as const)(
      `cancels ${queued ? 'queued' : 'pending'} local framing after a successful %s`,
      (direction) => {
        const manager = boxManager();
        const hook = framing(manager.document);
        const before = manager.document.derived.bodyRepresentations;
        const committed = widen(manager);
        act(() => hook.result.current.recordLocalCommit(committed, before));
        hook.rerender({ document: committed, ready: false, previewing: false });
        if (queued) {
          hook.rerender({
            document: rebuild(manager, 200),
            ready: true,
            previewing: false
          });
          expect(hook.result.current.autoFrame).not.toBeNull();
        }
        if (direction === 'redo') manager.undo();
        const restored = manager[direction]();
        expect(restored.version).toBeGreaterThan(committed.version);
        act(() => hook.result.current.clearAutoFrame());
        hook.rerender({ document: restored, ready: false, previewing: false });
        hook.rerender({
          document: rebuild(manager, direction === 'undo' ? 20 : 200),
          ready: true,
          previewing: false
        });
        expect(hook.result.current.autoFrame).toBeNull();
      }
    );

    it(`cancels ${queued ? 'queued' : 'pending'} local framing after restoring a save state`, () => {
      const manager = boxManager();
      const saved = createCheckpoint(manager.document, 'Saved Box');
      const hook = framing(saved);
      const before = saved.derived.bodyRepresentations;
      const committed = widen(manager);
      act(() => hook.result.current.recordLocalCommit(committed, before));
      hook.rerender({ document: committed, ready: false, previewing: false });
      if (queued) {
        hook.rerender({
          document: rebuild(manager, 200),
          ready: true,
          previewing: false
        });
        expect(hook.result.current.autoFrame).not.toBeNull();
      }
      const guarded = createCheckpoint(
        appendRevision(manager.document, 'Before restore'),
        'Before restore'
      );
      const restored = createCheckpoint(
        restoreFromSaveState(guarded, saved, 'Restored Saved Box'),
        'Restored Saved Box'
      );
      manager.applyDocumentEdit(restored, 'Restored Saved Box');
      expect(manager.document.version).toBeGreaterThan(committed.version);
      expect(listFeaturesInOrder(manager.document)[0]!.data).toMatchObject({
        dimensions: { width: 20 }
      });
      act(() => hook.result.current.clearAutoFrame());
      hook.rerender({ document: restored, ready: false, previewing: false });
      hook.rerender({
        document: rebuild(manager, 20),
        ready: true,
        previewing: false
      });
      expect(hook.result.current.autoFrame).toBeNull();
      manager.undo();
      expect(listFeaturesInOrder(manager.document)[0]!.data).toMatchObject({
        dimensions: { width: 200 }
      });
    });
  }

  it('drops a queued fit when the workspace leaves its document', () => {
    const manager = boxManager();
    const hook = framing(manager.document);
    const before = manager.document.derived.bodyRepresentations;
    act(() => hook.result.current.recordLocalCommit(widen(manager), before));
    hook.rerender({
      document: rebuild(manager, 200),
      ready: true,
      previewing: false
    });
    expect(hook.result.current.autoFrame).not.toBeNull();
    act(() => hook.result.current.clearAutoFrame());
    hook.rerender({ document: null, ready: false, previewing: false });
    expect(hook.result.current.autoFrame).toBeNull();
  });

  it('keeps a local fit through a geometry-preserving normalization version bump', () => {
    const manager = boxManager();
    const hook = framing(manager.document);
    const before = manager.document.derived.bodyRepresentations;
    const committed = widen(manager);
    act(() => hook.result.current.recordLocalCommit(committed, before));
    hook.rerender({ document: committed, ready: false, previewing: false });
    rebuild(manager, 200);
    const normalized = manager.normalize(
      commandFactories.updateFeature({
        featureId: listFeaturesInOrder(manager.document)[0]!.featureId,
        name: 'Normalized Box'
      })
    );
    expect(normalized.version).toBeGreaterThan(committed.version);
    hook.rerender({ document: normalized, ready: true, previewing: false });
    expect(hook.result.current.autoFrame).toEqual({
      before,
      after: normalized.derived.bodyRepresentations
    });
  });

  it('frames a new local transaction after the previous request was cancelled', () => {
    const manager = boxManager();
    const hook = framing(manager.document);
    const before = manager.document.derived.bodyRepresentations;
    act(() => hook.result.current.recordLocalCommit(widen(manager), before));
    act(() => hook.result.current.clearAutoFrame());
    const current = rebuild(manager, 200);
    hook.rerender({ document: current, ready: true, previewing: false });
    expect(hook.result.current.autoFrame).toBeNull();
    const transaction = manager.runTransaction('Widen Box', [
      commandFactories.updateFeature({
        featureId: listFeaturesInOrder(current)[0]!.featureId,
        data: { dimensions: { width: 300, depth: 20, height: 20 } }
      })
    ]);
    act(() =>
      hook.result.current.recordLocalCommit(
        transaction,
        current.derived.bodyRepresentations
      )
    );
    hook.rerender({
      document: rebuild(manager, 300),
      ready: true,
      previewing: false
    });
    expect(hook.result.current.autoFrame?.before).toBe(
      current.derived.bodyRepresentations
    );
    expect(hook.result.current.autoFrame?.after).toBe(
      manager.document.derived.bodyRepresentations
    );
  });
});
