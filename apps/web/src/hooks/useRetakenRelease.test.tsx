import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { useDirectEditCommit } from './useDirectEditCommit';
import {
  RETAKEN_DOCUMENT_CHANGED,
  RETAKEN_EDIT_BUSY,
  useRetakenRelease,
  type RetakenInteraction
} from './useRetakenRelease';

const target = { bodyId: 'body-1', topologyId: 'face-7' };
const dragging: RetakenInteraction = {
  mode: 'face',
  op: 'offset-face',
  phase: 'dragging',
  target
};

/**
 * A box whose width releases are validated by an exact check that answers
 * only when told to, with a drag that may take its handle again meanwhile.
 */
function retakeableBox() {
  const document = addPrimitiveFeature(
    createProjectDocument('Retaken box', toUserId('user_retaken_box')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 10, depth: 10 }
    }
  );
  const bodyId = document.bodyOrder[0]!;
  const feature = listFeaturesInOrder(document)[0]!;
  const manager = new CommandManager(document);
  const checks: { width: number; answer(): void }[] = [];
  const derive = vi.fn(
    (candidate: ProjectDocument) =>
      new Promise<ProjectDocument['derived']>((resolve) => {
        const box = listFeaturesInOrder(candidate)[0] as unknown as {
          data: { dimensions: { width: number } };
        };
        checks.push({
          width: box.data.dimensions.width,
          answer: () =>
            resolve({
              bodyRepresentations: {
                [bodyId]: {
                  bodyId,
                  name: 'Box',
                  source: 'primitive',
                  color: '#56b4e9',
                  consumed: false,
                  exportableStep: true,
                  mesh: {
                    kind: 'mesh',
                    vertices: Float32Array.from([]),
                    indices: Uint32Array.from([])
                  },
                  faceCount: 6,
                  volume: 1,
                  bbox: {
                    min: { x: 0, y: 0, z: 0 },
                    max: { x: 1, y: 1, z: 1 }
                  }
                }
              },
              exportableBodyIds: [bodyId],
              warnings: [],
              updatedAt: candidate.derived.updatedAt
            })
        });
      })
  );
  const host = {
    manager: () => manager,
    derive,
    commit: vi.fn(
      (command: ReturnType<typeof commandFactories.updateFeature>) => {
        manager.execute(command);
        return true;
      }
    ),
    onValidationStart: vi.fn(),
    onValidationFailed: vi.fn(),
    onCommitted: vi.fn(),
    onBusy: vi.fn(),
    onStatus: vi.fn()
  };
  const onStatus = vi.fn();
  let live: CommandManager | null = manager;
  const { result } = renderHook(() => {
    const directEdit = useDirectEditCommit({
      ...host,
      manager: () => live
    });
    const retaken = useRetakenRelease({
      directEdit,
      document: () => live?.document,
      onStatus
    });
    return { directEdit, retaken };
  });
  const release = (width: number) =>
    result.current.directEdit.run(
      commandFactories.updateFeature(
        {
          featureId: feature.featureId,
          data: { dimensions: { width, height: 10, depth: 10 } }
        },
        'Resize Box'
      ),
      bodyId,
      `Width set to ${width}.`,
      width
    );
  const committedWidth = () =>
    (
      listFeaturesInOrder(manager.document)[0] as unknown as {
        data: { dimensions: { width: number } };
      }
    ).data.dimensions.width;
  /** Lets go at `width` and takes the handle again while it is checked. */
  const releaseAndRetake = () => {
    act(() => {
      void release(23);
    });
    let taken = false;
    act(() => {
      taken = result.current.retaken.retake('offset-face', target);
    });
    expect(taken).toBe(true);
  };
  return {
    manager,
    derive,
    checks,
    host,
    onStatus,
    result,
    release,
    committedWidth,
    releaseAndRetake,
    closeProject: () => {
      live = null;
    }
  };
}

/** One edit landed: a single undo returns the box to where it started. */
function expectOneUndoStep(box: ReturnType<typeof retakeableBox>) {
  box.manager.undo();
  expect(box.committedWidth()).toBe(30);
  expect(box.manager.canUndo).toBe(false);
}

describe('a release taken again while it validates', () => {
  it('lands from its running check when let go at the same value: no second check', async () => {
    const box = retakeableBox();
    box.releaseAndRetake();
    expect(box.result.current.retaken.holds('offset-face')).toBe(true);
    // The hand lets go where the release was.
    const edit = box.result.current.retaken.take('offset-face')!;
    expect(edit.submittedValue).toBe(23);
    act(() => {
      expect(box.result.current.retaken.commit(edit)).toBe(true);
    });
    await act(async () => {
      box.checks[0]!.answer();
    });
    expect(box.derive).toHaveBeenCalledTimes(1);
    expect(box.host.commit).toHaveBeenCalledTimes(1);
    expect(box.committedWidth()).toBe(23);
    expectOneUndoStep(box);
    expect(box.host.onBusy).toHaveBeenLastCalledWith(false);
    expect(box.result.current.retaken.holds('offset-face')).toBe(false);
  });

  it('makes one edit at the new value when let go elsewhere', async () => {
    const box = retakeableBox();
    box.releaseAndRetake();
    // A commit of a new value takes the set-aside release and replaces it.
    expect(box.result.current.retaken.take('offset-face')).not.toBeNull();
    act(() => {
      void box.release(20);
    });
    await act(async () => {
      box.checks[0]!.answer();
      box.checks[1]!.answer();
    });
    expect(box.checks.map((check) => check.width)).toEqual([23, 20]);
    expect(box.host.commit).toHaveBeenCalledTimes(1);
    expect(box.committedWidth()).toBe(20);
    expectOneUndoStep(box);
    expect(box.host.onBusy).toHaveBeenLastCalledWith(false);
  });

  it('commits nothing when let go back on the original value', async () => {
    const box = retakeableBox();
    const version = box.manager.document.version;
    box.releaseAndRetake();
    expect(box.host.onBusy).toHaveBeenLastCalledWith(true);
    act(() => {
      box.result.current.retaken.drop('offset-face');
    });
    // Nothing is pending any more, so nothing holds the next edit back.
    expect(box.host.onBusy).toHaveBeenLastCalledWith(false);
    await act(async () => {
      box.checks[0]!.answer();
    });
    expect(box.host.commit).not.toHaveBeenCalled();
    expect(box.manager.document.version).toBe(version);
    expect(box.result.current.retaken.land('offset-face')).toBe(false);
    expect(box.onStatus).not.toHaveBeenCalled();
  });

  it('lands the set-aside release when the retaken drag is refused, blocked or abandoned', async () => {
    const box = retakeableBox();
    box.releaseAndRetake();
    // A refused or blocked value starts no commit of its own: the viewport
    // cancels the drag, which lands the release where it was let go.
    let lands = false;
    act(() => {
      lands = box.result.current.retaken.land('offset-face');
    });
    expect(lands).toBe(true);
    await act(async () => {
      box.checks[0]!.answer();
    });
    expect(box.derive).toHaveBeenCalledTimes(1);
    expect(box.committedWidth()).toBe(23);
    expect(box.host.onStatus).toHaveBeenLastCalledWith('Width set to 23.');
  });

  it('lands the release of a drag that ends without telling', async () => {
    const box = retakeableBox();
    box.releaseAndRetake();
    // Still that drag, at any phase it passes through: nothing happens.
    act(() => {
      box.result.current.retaken.follow(dragging);
      box.result.current.retaken.follow({ ...dragging, phase: 'validating' });
    });
    expect(box.result.current.retaken.holds('offset-face')).toBe(true);
    // The selection moved on under the drag: the release lands, as one
    // still validating does when the user picks elsewhere.
    act(() => {
      box.result.current.retaken.follow({
        ...dragging,
        target: { ...target, topologyId: 'face-8' }
      });
    });
    expect(box.result.current.retaken.holds('offset-face')).toBe(false);
    await act(async () => {
      box.checks[0]!.answer();
    });
    expect(box.committedWidth()).toBe(23);
  });

  it('drops and reports a release the document moved on from', async () => {
    const box = retakeableBox();
    const feature = listFeaturesInOrder(box.manager.document)[0]!;
    box.releaseAndRetake();
    box.manager.execute(
      commandFactories.updateFeature(
        {
          featureId: feature.featureId,
          data: { dimensions: { width: 40, height: 10, depth: 10 } }
        },
        'Resize Box'
      )
    );
    act(() => {
      box.result.current.retaken.follow(dragging);
    });
    expect(box.onStatus).toHaveBeenCalledWith(RETAKEN_DOCUMENT_CHANGED);
    expect(box.host.onBusy).toHaveBeenLastCalledWith(false);
    expect(box.result.current.retaken.holds('offset-face')).toBe(false);
    await act(async () => {
      box.checks[0]!.answer();
    });
    expect(box.host.commit).not.toHaveBeenCalled();
    expect(box.committedWidth()).toBe(40);
  });

  it('reports the document change when the drag ends before anything noticed it', () => {
    const box = retakeableBox();
    const feature = listFeaturesInOrder(box.manager.document)[0]!;
    box.releaseAndRetake();
    box.manager.execute(
      commandFactories.updateFeature(
        {
          featureId: feature.featureId,
          data: { dimensions: { width: 40, height: 10, depth: 10 } }
        },
        'Resize Box'
      )
    );
    expect(box.result.current.retaken.land('offset-face')).toBe(false);
    expect(box.onStatus).toHaveBeenCalledWith(RETAKEN_DOCUMENT_CHANGED);
  });

  it('drops a release silently when its project is closed', () => {
    const box = retakeableBox();
    box.releaseAndRetake();
    box.closeProject();
    act(() => {
      box.result.current.retaken.follow({ mode: 'idle' });
    });
    expect(box.result.current.retaken.holds('offset-face')).toBe(false);
    expect(box.onStatus).not.toHaveBeenCalled();
    expect(box.host.onBusy).toHaveBeenLastCalledWith(false);
  });

  it('reports a release it cannot land while another edit is checked', () => {
    const box = retakeableBox();
    box.releaseAndRetake();
    act(() => {
      void box.release(26);
    });
    expect(box.result.current.directEdit.idle()).toBe(false);
    // The retaken drag's release is still held: a commit for it is not.
    const edit = box.result.current.retaken.take('offset-face')!;
    expect(box.result.current.retaken.commit(edit)).toBe(false);
    expect(box.onStatus).toHaveBeenCalledWith(RETAKEN_EDIT_BUSY);
    // The running edit still owns the busy flag.
    expect(box.host.onBusy).toHaveBeenLastCalledWith(true);
  });

  it('holds nothing for another handle', () => {
    const box = retakeableBox();
    box.releaseAndRetake();
    expect(box.result.current.retaken.holds('resize-cylinder-radius')).toBe(
      false
    );
    expect(box.result.current.retaken.take('resize-cylinder-radius')).toBe(
      null
    );
    expect(box.result.current.retaken.holds('offset-face')).toBe(true);
  });

  it('cannot retake a release that is not validating', () => {
    const box = retakeableBox();
    expect(box.result.current.retaken.retake('offset-face', target)).toBe(
      false
    );
    expect(box.result.current.retaken.holds('offset-face')).toBe(false);
  });
});
