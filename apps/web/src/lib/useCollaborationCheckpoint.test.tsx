import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  appendRevision,
  createCheckpoint,
  createSavedRevision,
  createProjectDocument,
  importMeshBody
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
  let userId = toUserId('member');
  const apply = vi.fn((next: ProjectDocument) => {
    live = next;
  });
  const hook = renderHook(
    ({
      document,
      userId
    }: {
      document: ProjectDocument;
      userId: ReturnType<typeof toUserId>;
    }) =>
      useCollaboration({
        enabled: true,
        document,
        session: {
          userId,
          displayName: 'Member',
          mode: 'development'
        },
        onRemoteDocument: vi.fn(),
        onConflict: vi.fn()
      }),
    { initialProps: { document, userId } }
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
      hook.rerender({ document: next, userId });
    },
    changeAccount() {
      userId = toUserId('other-member');
      hook.rerender({ document: live, userId });
    },
    leave() {
      current = false;
    }
  };
}

function checkpoint(document: ProjectDocument, reason = 'Clicked model') {
  return createCheckpoint(appendRevision(document, reason), reason);
}

function clickedModel(name: string) {
  return addPrimitiveFeature(createProjectDocument(name, toUserId('owner')), {
    name: 'Clicked box',
    primitiveKind: 'box',
    dimensions: { width: 10, depth: 10, height: 10 }
  });
}

function oversizedDocument(base: ProjectDocument) {
  const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  return importMeshBody(base, {
    name: 'Large mesh',
    artifactId: 'artifact_pending',
    sourceName: 'large.stl',
    triangleCount: 30_000,
    vertices: Array.from(
      { length: 270_000 },
      (_, index) => triangle[index % 9]!
    ),
    indices: Array.from({ length: 90_000 }, (_, index) => index)
  }).document;
}

describe('durable room checkpoints', () => {
  it.each(['lost response', 'deadline'] as const)(
    'keeps the adopted server checkpoint identity after a %s',
    async (failure) => {
      const document = clickedModel('Lost checkpoint ACK');
      let fail!: (error: Error) => void;
      const fetch = vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            fail = reject;
          })
      );
      vi.stubGlobal('fetch', fetch);
      const hook = setup(document);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let outcome: unknown;
      const saving = hook.result.current
        .saveCheckpoint(document, 'Clicked model', hook.options)
        .catch((error: unknown) => {
          outcome = error;
        });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const saved = checkpoint(document);
      act(() => {
        hook.socket.receive({
          type: 'document',
          clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
          document: saved
        });
        hook.edit(saved);
      });
      const sentBeforeFailure = hook.socket.sent.filter(
        (frame) => frame.type === 'document'
      ).length;
      await act(async () => {
        if (failure === 'deadline') await vi.advanceTimersByTimeAsync(15_000);
        else fail(new Error('Checkpoint response lost.'));
        await saving;
      });
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(
        failure === 'deadline'
          ? 'did not confirm the named save'
          : 'Checkpoint response lost.'
      );
      expect((outcome as Error).message).toContain(
        'The named save is stored on this device.'
      );
      expect(hook.read().checkpoints).toEqual(saved.checkpoints);
      expect(hook.read().revisions).toEqual(saved.revisions);
      expect(hook.read().version).toBe(saved.version);
      expect(
        hook.socket.sent.filter((frame) => frame.type === 'document')
      ).toHaveLength(sentBeforeFailure);
      const local = await loadLocalSaveState(
        document.projectId,
        saved.checkpoints.at(-1)!.checkpointId
      );
      expect(local?.checkpoints).toEqual(saved.checkpoints);
      expect(local?.revisions).toEqual(saved.revisions);
      expect(
        await localStore.listLocalSaveStateIds(document.projectId)
      ).toHaveProperty('size', 1);
      hook.unmount();
    }
  );

  it('preserves buffered model edits and newer named metadata after an adopted checkpoint loses its response', async () => {
    const document = clickedModel('Buffered checkpoint ACK');
    let fail!: (error: Error) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            fail = reject;
          })
      )
    );
    const hook = setup(document);
    const saving = hook.result.current
      .saveCheckpoint(document, 'Clicked model', hook.options)
      .catch((error: unknown) => error);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const saved = checkpoint(document);
    act(() => {
      hook.socket.receive({
        type: 'document',
        clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
        document: saved
      });
      hook.edit(saved);
    });
    const later = createSavedRevision(
      addPrimitiveFeature(saved, {
        name: 'Buffered cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 10 }
      }),
      'Newer local note'
    );
    hook.edit(later);
    await saveLocalProject(later);
    await act(async () => {
      fail(new Error('Checkpoint response lost.'));
      await saving;
    });
    expect(hook.read().nodes).toEqual(later.nodes);
    expect(hook.read().version).toBe(later.version);
    expect(hook.read().checkpoints).toEqual(later.checkpoints);
    expect(hook.read().revisions).toEqual(later.revisions);
    const frame = hook.socket.sent
      .filter((sent) => sent.type === 'document')
      .at(-1)!;
    expect(frame.baseVersion).toBe(saved.version);
    expect(frame.document?.nodes).toEqual(later.nodes);
    expect(frame.document?.checkpoints).toEqual(later.checkpoints);
    expect(frame.document?.revisions).toEqual(later.revisions);
    expect((await loadLocalProject(document.projectId))?.nodes).toEqual(
      later.nodes
    );
    const local = await loadLocalSaveState(
      document.projectId,
      saved.checkpoints.at(-1)!.checkpointId
    );
    expect(local?.nodes).toEqual(saved.nodes);
    expect(local?.revisions).toEqual(saved.revisions);
    hook.unmount();
  });

  it('retains an observed server checkpoint locally without applying it after the account changes', async () => {
    const document = clickedModel('Old account checkpoint');
    let answer!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          })
      )
    );
    const hook = setup(document);
    const saving = hook.result.current
      .saveCheckpoint(document, 'Clicked model', hook.options)
      .catch((error: unknown) => error);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const saved = checkpoint(document);
    act(() => {
      hook.socket.receive({
        type: 'document',
        clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
        document: saved
      });
      hook.edit(saved);
      hook.changeAccount();
    });
    await act(async () => {
      await saving;
    });
    expect(hook.apply).not.toHaveBeenCalled();
    expect(hook.read().checkpoints).toEqual(saved.checkpoints);
    expect(
      (
        await loadLocalSaveState(
          document.projectId,
          saved.checkpoints.at(-1)!.checkpointId
        )
      )?.revisions
    ).toEqual(saved.revisions);
    expect(
      await localStore.listLocalSaveStateIds(document.projectId)
    ).toHaveProperty('size', 1);
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
    hook.unmount();
  });

  it.each(['old identity', 'other body', 'other client'] as const)(
    'does not mistake a checkpoint with %s for the pending named save',
    async (mismatch) => {
      const document = checkpoint(
        createProjectDocument('Unrelated checkpoint', toUserId('owner'))
      );
      let fail!: (error: Error) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((_resolve, reject) => {
              fail = reject;
            })
        )
      );
      const hook = setup(document);
      const saving = hook.result.current
        .saveCheckpoint(document, 'Clicked model', hook.options)
        .catch((error: unknown) => error);
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const echo =
        mismatch === 'old identity'
          ? { ...document, version: document.version + 1 }
          : checkpoint(
              mismatch === 'other body'
                ? addPrimitiveFeature(document, {
                    name: 'Other box',
                    primitiveKind: 'box',
                    dimensions: { width: 2, depth: 2, height: 2 }
                  })
                : document
            );
      act(() => {
        hook.socket.receive({
          type: 'document',
          clientId:
            mismatch === 'other client'
              ? 'other-device'
              : sessionStorage.getItem('openzcad-collaboration-client')!,
          document: echo
        });
        hook.edit(echo);
      });
      await act(async () => {
        fail(new Error('No confirmed save.'));
        await saving;
      });
      const echoIds = new Set(
        echo.checkpoints.map((point) => point.checkpointId)
      );
      const fallback = hook
        .read()
        .checkpoints.filter((point) => !echoIds.has(point.checkpointId));
      expect(fallback).toHaveLength(1);
      const local = fallback[0]!;
      expect(local.reason).toBe('Clicked model');
      expect(
        (await loadLocalSaveState(document.projectId, local.checkpointId))
          ?.nodes
      ).toEqual(document.nodes);
      hook.unmount();
    }
  );

  it.each([
    'unreadable',
    'rejection',
    'conflict',
    'fetch failure',
    'body failure',
    'unsuccessful ACK'
  ] as const)(
    'promptly refuses a named save when its outstanding oversized edit ends in %s',
    async (failure) => {
      const base = createProjectDocument(
        'Oversized pending edit',
        toUserId('owner')
      );
      const document = oversizedDocument(base);
      let answer!: (response: Response) => void;
      let fail!: (error: Error) => void;
      const first = new Promise<Response>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      });
      const fetch = vi
        .fn((_request: RequestInfo | URL, _options?: RequestInit) => first)
        .mockImplementationOnce(() => first)
        .mockImplementation(() => new Promise<Response>(() => undefined));
      vi.stubGlobal('fetch', fetch);
      const hook = setup(document, base);
      expect(fetch).toHaveBeenCalledOnce();
      let outcome = 'pending';
      let primary: unknown;
      let settled!: Promise<void>;
      act(() => {
        settled = hook.result.current
          .saveCheckpoint(document, 'Named after pending edit', hook.options)
          .then(
            () => {
              outcome = 'resolved';
            },
            (error: unknown) => {
              outcome = 'rejected';
              primary = error;
            }
          );
      });
      try {
        await act(async () => {
          await vi.dynamicImportSettled();
        });
        expect(fetch).toHaveBeenCalledOnce();
        await act(async () => {
          if (failure === 'fetch failure')
            fail(new Error('Connection interrupted.'));
          else if (failure === 'body failure') {
            const response = new Response('');
            vi.spyOn(response, 'text').mockRejectedValue(
              new Error('Response body interrupted.')
            );
            answer(response);
          } else if (failure === 'unreadable')
            answer(new Response('not a room frame'));
          else if (failure === 'rejection')
            answer(
              new Response(
                JSON.stringify({
                  type: 'error',
                  code: 'document-too-large',
                  message: 'Pending edit exceeds the room limit.'
                }),
                { status: 413 }
              )
            );
          else if (failure === 'conflict')
            answer(
              new Response(
                JSON.stringify({
                  type: 'conflict',
                  document: {
                    ...base,
                    name: 'Other room branch',
                    version: document.version + 1
                  }
                }),
                { status: 409 }
              )
            );
          else
            answer(
              new Response(
                JSON.stringify({ type: 'ack', version: document.version }),
                { status: 503 }
              )
            );
        });
        await waitFor(() => expect(outcome).toBe('rejected'), {
          timeout: 1_000
        });
        expect(primary).toBeInstanceOf(Error);
        expect((primary as Error).message).toContain(
          'The named save is stored on this device.'
        );
        if (failure === 'fetch failure')
          expect((primary as Error).message).toContain(
            'Connection interrupted.'
          );
        if (failure === 'body failure')
          expect((primary as Error).message).toContain(
            'Response body interrupted.'
          );
        if (failure === 'rejection')
          expect((primary as Error).message).toContain(
            'Pending edit exceeds the room limit.'
          );
        expect(
          fetch.mock.calls.some(
            ([, options]) =>
              (
                JSON.parse(options!.body as string) as {
                  checkpointReason?: string;
                }
              ).checkpointReason
          )
        ).toBe(false);
        const local = hook.read().checkpoints.at(-1)!;
        expect(local.reason).toBe('Named after pending edit');
        expect(
          await loadLocalSaveState(document.projectId, local.checkpointId)
        ).not.toBeNull();
      } finally {
        hook.unmount();
        await settled;
      }
    }
  );

  it('continues a named save after its outstanding oversized edit succeeds', async () => {
    const base = createProjectDocument(
      'Confirmed pending edit',
      toUserId('owner')
    );
    const document = oversizedDocument(base);
    const saved = checkpoint(document, 'After confirmed edit');
    let answer!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const fetch = vi
      .fn((_request: RequestInfo | URL, _options?: RequestInit) => first)
      .mockImplementationOnce(() => first)
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              type: 'ack',
              version: saved.version,
              document: saved
            })
          )
      );
    vi.stubGlobal('fetch', fetch);
    const hook = setup(document, base);
    let saving!: Promise<ProjectDocument>;
    act(() => {
      saving = hook.result.current.saveCheckpoint(
        document,
        'After confirmed edit',
        hook.options
      );
    });
    try {
      await act(async () => {
        await vi.dynamicImportSettled();
      });
      expect(fetch).toHaveBeenCalledOnce();
      await act(async () => {
        answer(
          new Response(
            JSON.stringify({ type: 'ack', version: document.version, document })
          )
        );
        await saving;
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      const namedRequest = JSON.parse(
        fetch.mock.calls[1]![1]!.body as string
      ) as { checkpointReason: string; baseVersion: number };
      expect(namedRequest.checkpointReason).toBe('After confirmed edit');
      expect(namedRequest.baseVersion).toBe(document.version);
      expect(hook.read().version).toBe(saved.version);
      expect(hook.result.current.roomVersion).toBe(saved.version);
      expect(
        await loadLocalSaveState(
          document.projectId,
          saved.checkpoints.at(-1)!.checkpointId
        )
      ).not.toBeNull();
    } finally {
      hook.unmount();
    }
  });

  it('reuses a checkpoint broadcast adopted before its HTTP acknowledgement without another room write', async () => {
    const document = createProjectDocument(
      'Early save echo',
      toUserId('owner')
    );
    let answer!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
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
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const saved = checkpoint(document);
    act(() => {
      hook.socket.receive({
        type: 'document',
        clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
        document: saved
      });
      // App adopts the broadcast through onRemoteDocument before fetch resolves.
      hook.edit(saved);
    });
    const sentBeforeAck = hook.socket.sent.filter(
      (frame) => frame.type === 'document'
    ).length;
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
    expect(hook.read().version).toBe(saved.version);
    expect(hook.read().checkpoints).toEqual(saved.checkpoints);
    expect(
      hook.socket.sent.filter((frame) => frame.type === 'document')
    ).toHaveLength(sentBeforeAck);
    expect(
      await loadLocalSaveState(
        document.projectId,
        saved.checkpoints.at(-1)!.checkpointId
      )
    ).not.toBeNull();
    hook.unmount();
  });

  it('preserves a new local named save at the echoed version while the HTTP acknowledgement is held', async () => {
    const document = createProjectDocument(
      'New save after echo',
      toUserId('owner')
    );
    let answer!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
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
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const saved = checkpoint(document);
    const later = createSavedRevision(saved, 'Local note after echo');
    expect(later.version).toBe(saved.version);
    act(() => {
      hook.socket.receive({
        type: 'document',
        clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
        document: saved
      });
      hook.edit(later);
    });
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
    expect(hook.read().version).toBeGreaterThan(saved.version);
    expect(hook.read().checkpoints).toEqual(later.checkpoints);
    expect(hook.read().revisions).toEqual(later.revisions);
    const frame = hook.socket.sent
      .filter((sent) => sent.type === 'document')
      .at(-1)!;
    expect(frame.baseVersion).toBe(saved.version);
    expect(frame.document?.version).toBeGreaterThan(saved.version);
    expect(frame.document?.checkpoints).toEqual(later.checkpoints);
    expect(frame.document?.revisions).toEqual(later.revisions);
    hook.unmount();
  });

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
    hook.rerender({ document: next, userId: toUserId('member') });
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
