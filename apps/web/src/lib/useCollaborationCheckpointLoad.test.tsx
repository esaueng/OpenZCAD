import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type CollaborationServerMessage,
  type ProjectDocument
} from '@openzcad/shared';
import {
  loadLocalProject,
  loadLocalSaveState,
  saveLocalProject
} from './localProjectStore';
import * as localStore from './localProjectStore';
import { useCollaboration } from './useCollaboration';
import { preserveFailedCheckpoint } from './collaborationCheckpointFallback';
import { STALE_CHUNK_MESSAGE } from './staleChunk';

const chunkError = new Error('Checkpoint action chunk unavailable.');

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  readonly sent: Array<{ type: string; document?: ProjectDocument }> = [];
  constructor(_url: string) {
    super();
    Socket.instances.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw) as (typeof this.sent)[number]);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  receive(frame: CollaborationServerMessage) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(frame) })
    );
  }
}

beforeEach(() => {
  vi.doMock('./collaborationCheckpoint', () => {
    throw chunkError;
  });
  globalThis.indexedDB = new IDBFactory();
  sessionStorage.clear();
  localStorage.clear();
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('./collaborationCheckpoint');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(document: ProjectDocument) {
  let live = document;
  let current = true;
  let userId = toUserId('member');
  let enabled = true;
  const apply = vi.fn((next: ProjectDocument) => {
    live = next;
  });
  const hook = renderHook(
    (props: {
      document: ProjectDocument;
      userId: typeof userId;
      enabled: boolean;
    }) =>
      useCollaboration({
        ...props,
        session: {
          userId: props.userId,
          displayName: 'Member',
          mode: 'development'
        },
        onRemoteDocument: vi.fn(),
        onConflict: vi.fn()
      }),
    { initialProps: { document, userId, enabled } }
  );
  const socket = Socket.instances[0]!;
  act(() => {
    socket.readyState = Socket.OPEN;
    socket.dispatchEvent(new Event('open'));
    socket.receive({
      type: 'state',
      members: [],
      document,
      role: 'editor',
      lease: null
    });
    socket.receive({
      type: 'lease-granted',
      lease: {
        projectId: document.projectId,
        leaseId: 'checkpoint_lease',
        clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
        userId,
        expiresAt: Date.now() + 60_000
      }
    });
  });
  const rerender = () => hook.rerender({ document: live, userId, enabled });
  return {
    ...hook,
    socket,
    apply,
    options: {
      isCurrent: () => current,
      readDocument: () => live,
      applyDocument: apply
    },
    read: () => live,
    edit(next: ProjectDocument) {
      live = next;
      rerender();
    },
    depart(kind: 'navigation' | 'account' | 'disabled' | 'project') {
      if (kind === 'navigation') current = false;
      if (kind === 'account') userId = toUserId('other-member');
      if (kind === 'disabled') enabled = false;
      if (kind === 'project')
        live = createProjectDocument('New workspace', toUserId('owner'));
      rerender();
    }
  };
}

function box(document: ProjectDocument, name: string) {
  return addPrimitiveFeature(document, {
    name,
    primitiveKind: 'box',
    dimensions: { width: 2, depth: 2, height: 2 }
  });
}

async function rejectedSave(
  operation: Promise<ProjectDocument>
): Promise<Error> {
  let result: unknown;
  await act(async () => {
    result = await operation.catch((error: unknown) => error);
  });
  expect(result).toBeInstanceOf(Error);
  return result as Error;
}

describe('named saves when the checkpoint action cannot load', () => {
  it('keeps the device durability confirmation with native chunk-load guidance', async () => {
    const clicked = createProjectDocument(
      'Missing native module',
      toUserId('owner')
    );
    const hook = setup(clicked);
    const primary = new TypeError(
      'Failed to fetch dynamically imported module: https://app.test/assets/checkpoint-old.js'
    );
    const error = await rejectedSave(
      preserveFailedCheckpoint(
        primary,
        clicked,
        'Offline milestone',
        hook.options,
        () => true
      )
    );
    expect(error.cause).toBe(primary);
    expect(error.message).toBe(
      `${STALE_CHUNK_MESSAGE} The named save is stored on this device.`
    );
    const checkpoint = hook.read().checkpoints.at(-1)!;
    expect(
      await loadLocalSaveState(clicked.projectId, checkpoint.checkpointId)
    ).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('uses the named-save deadline for a held import and never starts its late action', async () => {
    const clicked = createProjectDocument('Held action', toUserId('owner'));
    const later = box(clicked, 'Buffered box');
    const action = vi.fn(async () => clicked);
    let resolve!: (module: {
      saveCollaborationCheckpoint: typeof action;
    }) => void;
    const pending = new Promise<{ saveCollaborationCheckpoint: typeof action }>(
      (done) => {
        resolve = done;
      }
    );
    const loading = vi.fn(() => pending);
    vi.doMock('./collaborationCheckpoint', loading);
    const hook = setup(clicked);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let outcome = 'pending';
    const saving = hook.result.current.saveCheckpoint(
      clicked,
      'Deadline milestone',
      hook.options
    );
    const settled = saving.then(
      () => {
        outcome = 'resolved';
      },
      () => {
        outcome = 'rejected';
      }
    );
    hook.edit(later);
    try {
      await vi.waitFor(() => expect(loading).toHaveBeenCalledOnce());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_000);
      });
      expect(outcome).toBe('pending');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
        // IndexedDB completes its real task queue after the deadline fires.
        await vi.waitFor(() => expect(outcome).toBe('rejected'));
      });
      expect(outcome).toBe('rejected');
      const error = await rejectedSave(saving);
      expect(error.message).toContain(
        'The room did not confirm the named save. Please retry.'
      );
      expect(error.message).toContain(
        'The named save is stored on this device.'
      );
      const local = hook.read().checkpoints.at(-1)!;
      expect(local.reason).toBe('Deadline milestone');
      expect(
        (await loadLocalSaveState(clicked.projectId, local.checkpointId))?.nodes
      ).toEqual(clicked.nodes);
      expect(hook.read().nodes).toEqual(later.nodes);
      expect(
        hook.socket.sent.filter((frame) => frame.type === 'document').at(-1)
          ?.document?.nodes
      ).toEqual(later.nodes);
    } finally {
      resolve({ saveCollaborationCheckpoint: action });
      await act(async () => {
        await vi.dynamicImportSettled();
        await settled;
      });
      hook.unmount();
    }
    expect(action).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await localStore.listLocalSaveStateIds(clicked.projectId)
    ).toHaveProperty('size', 1);
  });

  it('cancels a held import promptly on a room change and never starts its late action', async () => {
    const clicked = createProjectDocument(
      'Departing held action',
      toUserId('owner')
    );
    const action = vi.fn(async () => clicked);
    let resolve!: (module: {
      saveCollaborationCheckpoint: typeof action;
    }) => void;
    vi.doMock(
      './collaborationCheckpoint',
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const hook = setup(clicked);
    let outcome = 'pending';
    const saving = hook.result.current.saveCheckpoint(
      clicked,
      'Cancelled milestone',
      hook.options
    );
    const settled = saving.then(
      () => {
        outcome = 'resolved';
      },
      () => {
        outcome = 'rejected';
      }
    );
    await waitFor(() => expect(resolve).toBeDefined());
    hook.depart('project');
    const next = hook.read();
    try {
      await waitFor(() => expect(outcome).toBe('rejected'), { timeout: 1_000 });
      const error = await rejectedSave(saving);
      expect(error.message).toContain(
        'The named save is stored on this device.'
      );
      expect(hook.apply).not.toHaveBeenCalled();
      expect(hook.read()).toBe(next);
      expect(
        await localStore.listLocalSaveStateIds(clicked.projectId)
      ).toHaveProperty('size', 1);
    } finally {
      resolve({ saveCollaborationCheckpoint: action });
      await act(async () => {
        await vi.dynamicImportSettled();
        await settled;
      });
      hook.unmount();
    }
    expect(action).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('durably names the clicked snapshot while retaining buffered edits and the newer stored project head', async () => {
    const clicked = box(
      createProjectDocument('Offline named save', toUserId('owner')),
      'Clicked box'
    );
    const later = box(clicked, 'Buffered box');
    await saveLocalProject(later);
    const hook = setup(clicked);
    const saving = hook.result.current.saveCheckpoint(
      clicked,
      '  Offline milestone  ',
      hook.options
    );
    hook.edit(later);
    const error = await rejectedSave(saving);
    // Vitest wraps a rejected module factory; preserve that primary rejection
    // and its original chunk error, rather than replacing it with storage.
    expect((error.cause as Error).cause).toBe(chunkError);
    expect(error.message).toContain((error.cause as Error).message);
    expect(error.message).toContain('The named save is stored on this device.');
    const local = hook.read().checkpoints.at(-1)!;
    expect(local.reason).toBe('Offline milestone');
    expect(local.documentVersion).toBe(clicked.version);
    const stored = await loadLocalSaveState(
      clicked.projectId,
      local.checkpointId
    );
    expect(stored?.nodes).toEqual(clicked.nodes);
    expect(stored?.revisions.at(-1)?.revisionId).toBe(local.revisionId);
    expect(hook.read().nodes).toEqual(later.nodes);
    expect((await loadLocalProject(clicked.projectId))?.nodes).toEqual(
      later.nodes
    );
    expect(hook.result.current.roomVersion).toBe(clicked.version);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      hook.socket.sent.filter((frame) => frame.type === 'document').at(-1)
        ?.document?.nodes
    ).toEqual(later.nodes);
    hook.unmount();
  });

  it.each(['navigation', 'account', 'disabled', 'project'] as const)(
    'stores the captured name without applying it after %s changes',
    async (departure) => {
      const clicked = box(
        createProjectDocument('Departing named save', toUserId('owner')),
        'Clicked box'
      );
      const hook = setup(clicked);
      const saving = hook.result.current.saveCheckpoint(
        clicked,
        'Departed milestone',
        hook.options
      );
      hook.depart(departure);
      const next = hook.read();
      const error = await rejectedSave(saving);
      expect(error.message).toContain(
        'The named save is stored on this device.'
      );
      expect(hook.apply).not.toHaveBeenCalled();
      expect(hook.read()).toBe(next);
      const ids = await localStore.listLocalSaveStateIds(clicked.projectId);
      const saveStates = await Promise.all(
        Array.from(ids, (id) => loadLocalSaveState(clicked.projectId, id))
      );
      const local = saveStates.find(
        (state) => state?.checkpoints.at(-1)?.reason === 'Departed milestone'
      );
      expect(local?.nodes).toEqual(clicked.nodes);
      expect(fetch).not.toHaveBeenCalled();
      hook.unmount();
    }
  );

  it('preserves the module-load error when device storage also fails', async () => {
    const clicked = createProjectDocument('Full device', toUserId('owner'));
    const storage = vi
      .spyOn(localStore, 'saveLocalSaveStates')
      .mockRejectedValue(new Error('Device quota exceeded.'));
    const hook = setup(clicked);
    const error = await rejectedSave(
      hook.result.current.saveCheckpoint(clicked, 'Not stored', hook.options)
    );
    expect((error.cause as Error).cause).toBe(chunkError);
    expect(error.message).toContain((error.cause as Error).message);
    expect(error.message).toContain(
      'The named save could not be stored on this device.'
    );
    expect(error.message).not.toContain('Device quota exceeded.');
    expect(storage).toHaveBeenCalledOnce();
    expect(hook.apply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    hook.unmount();
  });
});
