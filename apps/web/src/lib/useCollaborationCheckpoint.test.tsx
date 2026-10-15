import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  appendRevision,
  createCheckpoint,
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

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  readonly sent: Array<{
    type: string;
    document?: ProjectDocument;
    baseVersion?: number;
  }> = [];
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
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  receive(frame: CollaborationServerMessage) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(frame) })
    );
  }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  sessionStorage.clear();
  localStorage.clear();
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(document: ProjectDocument, room = document) {
  let live = document;
  let current = true;
  const apply = vi.fn((next: ProjectDocument) => {
    live = next;
  });
  const hook = renderHook(
    ({ document }: { document: ProjectDocument }) =>
      useCollaboration({
        enabled: true,
        document,
        session: {
          userId: toUserId('member'),
          displayName: 'Member',
          mode: 'development'
        },
        onRemoteDocument: vi.fn(),
        onConflict: vi.fn()
      }),
    { initialProps: { document } }
  );
  const socket = Socket.instances[0]!;
  act(() => {
    socket.open();
    socket.receive({
      type: 'state',
      members: [],
      document: room,
      role: 'editor',
      lease: null
    });
    socket.receive({
      type: 'lease-granted',
      lease: {
        projectId: document.projectId,
        leaseId: 'checkpoint_lease',
        clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
        userId: toUserId('member'),
        expiresAt: Date.now() + 60_000
      }
    });
  });
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
      hook.rerender({ document: next });
    },
    leave() {
      current = false;
    }
  };
}

function checkpoint(document: ProjectDocument, reason = 'Clicked model') {
  return createCheckpoint(appendRevision(document, reason), reason);
}

describe('durable room checkpoints', () => {
  it('advances the confirmed room base and preserves buffered edits when local checkpoint storage fails', async () => {
    const document = createProjectDocument(
      'Storage failure',
      toUserId('owner')
    );
    const later = addPrimitiveFeature(document, {
      name: 'Buffered box',
      primitiveKind: 'box',
      dimensions: { width: 2, depth: 2, height: 2 }
    });
    let answer!: (response: Response) => void;
    const fetch = vi.fn(
      (_request: RequestInfo | URL, _options?: RequestInit) =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(localStore, 'saveLocalSaveStates').mockRejectedValue(
      new Error('Device quota exceeded.')
    );
    const hook = setup(document);
    let saving!: Promise<ProjectDocument>;
    act(() => {
      saving = hook.result.current.saveCheckpoint(
        document,
        'Clicked model',
        hook.options
      );
    });
    const rejected = expect(saving).rejects.toThrow(
      'The revision is stored in the room. The named save could not be stored on this device.'
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    hook.edit(later);
    const saved = checkpoint(document);
    await act(async () => {
      answer(
        new Response(
          JSON.stringify({
            type: 'ack',
            version: saved.version,
            document: saved
          })
        )
      );
      await rejected;
    });
    expect(hook.result.current.roomVersion).toBe(saved.version);
    expect(hook.read().nodes).toEqual(later.nodes);
    const frame = hook.socket.sent
      .filter((sent) => sent.type === 'document')
      .at(-1)!;
    expect(frame.baseVersion).toBe(saved.version);
    expect(frame.document?.version).toBeGreaterThan(saved.version);
    expect(frame.document?.nodes).toEqual(later.nodes);
    expect(frame.document?.checkpoints.at(-1)?.revisionId).toBe(
      saved.revisions.at(-1)?.revisionId
    );
    hook.unmount();
  });

  it('refuses viewer checkpoints before making an HTTP request or changing the local model', async () => {
    const document = createProjectDocument(
      'Viewer checkpoint',
      toUserId('owner')
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const hook = setup(document);
    act(() => {
      hook.socket.receive({
        type: 'state',
        document,
        members: [],
        role: 'viewer',
        lease: null
      });
    });
    await expect(
      hook.result.current.saveCheckpoint(document, 'Refused', hook.options)
    ).rejects.toThrow('cannot save a room revision');
    expect(fetch).not.toHaveBeenCalled();
    expect(hook.apply).not.toHaveBeenCalled();
    expect(hook.read()).toBe(document);
    hook.unmount();
  });

  it('preserves the primary HTTP failure and the clicked named state on this device', async () => {
    const document = createProjectDocument(
      'Refused checkpoint',
      toUserId('owner')
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'error',
              code: 'storage-limit',
              message: 'Account quota exceeded.'
            }),
            { status: 413 }
          )
      )
    );
    const hook = setup(document);
    await act(async () => {
      await expect(
        hook.result.current.saveCheckpoint(
          document,
          'Retried locally',
          hook.options
        )
      ).rejects.toThrow(
        'Account quota exceeded. The named save is stored on this device.'
      );
    });
    const saved = hook.read().checkpoints.at(-1)!;
    expect(saved.reason).toBe('Retried locally');
    expect(
      (await loadLocalSaveState(document.projectId, saved.checkpointId))?.nodes
    ).toEqual(document.nodes);
    expect(hook.result.current.roomVersion).toBe(document.version);
    hook.unmount();
  });

  it('drains the pending ACK, names the clicked model and publishes buffered edits above the checkpoint ACK', async () => {
    const base = createProjectDocument('Clicked checkpoint', toUserId('owner'));
    const clicked = addPrimitiveFeature(base, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, depth: 10, height: 10 }
    });
    const later = addPrimitiveFeature(clicked, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 2, height: 10 }
    });
    let answer!: (response: Response) => void;
    const fetch = vi.fn(
      (_request: RequestInfo | URL, _options?: RequestInit) =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    vi.stubGlobal('fetch', fetch);
    const hook = setup(clicked, base);
    let saving!: Promise<ProjectDocument>;
    act(() => {
      saving = hook.result.current.saveCheckpoint(
        clicked,
        'Clicked model',
        hook.options
      );
    });
    hook.edit(later);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      hook.socket.sent.filter((frame) => frame.type === 'document')
    ).toHaveLength(1);
    act(() => {
      hook.socket.receive({ type: 'ack', version: clicked.version });
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const request = JSON.parse(
      (fetch.mock.calls[0]![1] as RequestInit).body as string
    ) as {
      document: ProjectDocument;
      checkpointReason: string;
      baseVersion: number;
      leaseId: string;
    };
    expect(request.document.nodes).toEqual(clicked.nodes);
    expect(request.document.bodyOrder).toHaveLength(1);
    expect(request.checkpointReason).toBe('Clicked model');
    expect(request.baseVersion).toBe(clicked.version);
    expect(request.leaseId).toBe('checkpoint_lease');
    const saved = checkpoint(clicked);
    await act(async () => {
      answer(
        new Response(
          JSON.stringify({
            type: 'ack',
            version: saved.version,
            document: saved
          })
        )
      );
      await saving;
    });
    expect(hook.read().nodes).toEqual(later.nodes);
    expect(hook.read().bodyOrder).toHaveLength(2);
    expect(hook.read().version).toBeGreaterThan(saved.version);
    const latest = hook.socket.sent
      .filter((frame) => frame.type === 'document')
      .at(-1)!;
    expect(latest.baseVersion).toBe(saved.version);
    expect(latest.document?.version).toBeGreaterThan(saved.version);
    expect(latest.document?.checkpoints.at(-1)?.revisionId).toBe(
      saved.revisions.at(-1)?.revisionId
    );
    const stored = await loadLocalSaveState(
      base.projectId,
      saved.checkpoints.at(-1)!.checkpointId
    );
    expect(stored?.nodes).toEqual(clicked.nodes);
    expect(stored?.bodyOrder).toHaveLength(1);
    hook.unmount();
  });

  it('rejects an older server that ignores checkpointReason and keeps a named local save state', async () => {
    const document = createProjectDocument('Old server', toUserId('owner'));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ type: 'ack', version: document.version, document })
          )
      )
    );
    const hook = setup(document);
    await act(async () => {
      await expect(
        hook.result.current.saveCheckpoint(
          document,
          'Local milestone',
          hook.options
        )
      ).rejects.toThrow('did not confirm a durable named revision');
    });
    const local = hook.read().checkpoints.at(-1)!;
    expect(local.reason).toBe('Local milestone');
    expect(
      await loadLocalSaveState(document.projectId, local.checkpointId)
    ).not.toBeNull();
    expect(hook.result.current.roomVersion).toBe(document.version);
    hook.unmount();
  });

  it('stores a late authoritative snapshot without overwriting a newer project head or applying it after navigation', async () => {
    const document = createProjectDocument(
      'Departing checkpoint',
      toUserId('owner')
    );
    const later = addPrimitiveFeature(document, {
      name: 'Later box',
      primitiveKind: 'box',
      dimensions: { width: 2, depth: 2, height: 2 }
    });
    let answer!: (response: Response) => void;
    const fetch = vi.fn(
      (_request: RequestInfo | URL, _options?: RequestInit) =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    vi.stubGlobal('fetch', fetch);
    const hook = setup(document);
    let saving!: Promise<ProjectDocument>;
    act(() => {
      saving = hook.result.current.saveCheckpoint(
        document,
        'Clicked model',
        hook.options
      );
    });
    const rejected = expect(saving).rejects.toThrow('room changed');
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    hook.leave();
    hook.edit(later);
    await saveLocalProject(later);
    const saved = checkpoint(document);
    await act(async () => {
      answer(
        new Response(
          JSON.stringify({
            type: 'ack',
            version: saved.version,
            document: saved
          })
        )
      );
      await rejected;
    });
    expect(hook.apply).not.toHaveBeenCalled();
    expect((await loadLocalProject(document.projectId))?.nodes).toEqual(
      later.nodes
    );
    expect(
      await loadLocalSaveState(
        document.projectId,
        saved.checkpoints.at(-1)!.checkpointId
      )
    ).not.toBeNull();
    hook.unmount();
  });

  it('cancels a pending HTTP checkpoint after a committed account change without adopting its late response', async () => {
    const document = createProjectDocument(
      'Account checkpoint',
      toUserId('owner')
    );
    let answer!: (response: Response) => void;
    const fetch = vi.fn(
      (_request: RequestInfo | URL, _options?: RequestInit) =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    vi.stubGlobal('fetch', fetch);
    const hook = setup(document);
    let saving!: Promise<ProjectDocument>;
    act(() => {
      saving = hook.result.current.saveCheckpoint(
        document,
        'Clicked model',
        hook.options
      );
    });
    const rejected = expect(saving).rejects.toThrow('room changed');
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const next = createProjectDocument('New project', toUserId('owner'));
    hook.rerender({ document: next });
    await act(async () => {
      await rejected;
    });
    const saved = checkpoint(document);
    await act(async () => {
      answer(
        new Response(
          JSON.stringify({
            type: 'ack',
            version: saved.version,
            document: saved
          })
        )
      );
    });
    expect(hook.apply).not.toHaveBeenCalled();
    expect(hook.result.current.roomVersion).not.toBe(saved.version);
    hook.unmount();
  });
});
