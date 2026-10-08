import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  importMeshBody,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type AuthSession,
  type CollaborationServerMessage,
  type ProjectDocument,
  type ProjectEditLease
} from '@openzcad/shared';
import {
  readUnresolvedConflict,
  rememberUnresolvedConflict
} from './conflictRecovery';
import { useCollaboration } from './useCollaboration';
import { parseServerMessage } from './useCollaboration';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  return { ...actual, useEffect: vi.fn(actual.useEffect) };
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: { data?: string }) => void>
  >();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: { data?: string }) => void
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  receive(message: CollaborationServerMessage): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  receiveRaw(data: string): void {
    this.emit('message', { data });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map(
      (frame) => JSON.parse(frame) as Record<string, unknown>
    );
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function session(userId: string): AuthSession {
  return {
    userId: toUserId(userId),
    displayName: userId,
    mode: 'development'
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  sessionStorage.clear();
  localStorage.clear();
});

function largeMeshDocument(base: ProjectDocument): ProjectDocument {
  const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  return importMeshBody(base, {
    name: 'Large mesh',
    artifactId: 'artifact_large',
    sourceName: 'large.stl',
    triangleCount: 30_000,
    vertices: Array.from(
      { length: 270_000 },
      (_, index) => triangle[index % 9]!
    ),
    indices: Array.from({ length: 90_000 }, (_, index) => index)
  }).document;
}

function grantLease(socket: FakeWebSocket, document: ProjectDocument) {
  socket.open();
  socket.receive({
    type: 'state',
    members: [],
    document,
    role: 'owner',
    lease: null
  });
  socket.receive({
    type: 'lease-granted',
    lease: {
      leaseId: `lease_${FakeWebSocket.instances.length}`,
      projectId: document.projectId,
      clientId: socket.frames()[0]!.clientId as string,
      userId: document.ownerUserId,
      expiresAt: Date.now() + 30_000
    }
  });
}

describe('HTTP collaboration response ownership', () => {
  it.each(
    (['enabled', 'account', 'display-name'] as const).flatMap((change) =>
      (['keep-mine', 'automatic-save'] as const).map((mode) => ({
        change,
        mode
      }))
    )
  )(
    'invalidates $mode after a committed $change change before passive room effects run',
    async ({ change, mode }) => {
      vi.useFakeTimers();
      vi.stubGlobal('WebSocket', FakeWebSocket);
      let defer = false;
      const pendingEffects: Array<() => void | (() => void)> = [];
      const { useEffect: actualEffect } =
        await vi.importActual<typeof React>('react');
      const effectSpy = vi
        .mocked(React.useEffect)
        .mockImplementation((effect, deps) =>
          actualEffect(() => {
            if (defer) {
              pendingEffects.push(effect);
              return;
            }
            const cleanup = effect();
            return () => {
              if (defer && cleanup) {
                pendingEffects.push(() => {
                  cleanup();
                });
              } else cleanup?.();
            };
          }, deps)
        );
      const base = createProjectDocument(
        'Committed room',
        toUserId('user_commit')
      );
      const local = largeMeshDocument(base);
      const remote = { ...base, name: 'Room copy', version: 8 };
      let resolve!: (response: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((done) => {
              resolve = done;
            })
        )
      );
      const onRemoteDocument = vi.fn();
      const onConflict = vi.fn();
      const auth = session(base.ownerUserId);
      const hook = renderHook(
        ({ enabled, auth }: { enabled: boolean; auth: AuthSession }) =>
          useCollaboration({
            enabled,
            session: auth,
            document: local,
            onRemoteDocument,
            onConflict
          }),
        { initialProps: { enabled: true, auth } }
      );
      try {
        const socket = FakeWebSocket.instances[0]!;
        const room = mode === 'keep-mine' ? remote : base;
        act(() => {
          if (mode === 'keep-mine') {
            socket.open();
            socket.receive({ type: 'conflict', document: remote });
          }
          grantLease(socket, room);
        });
        let settled: Promise<unknown> | undefined;
        if (mode === 'keep-mine') {
          act(() => {
            settled = hook.result.current
              .keepLocalVersion(remote.version)
              .catch((error: unknown) => error);
          });
        }
        expect(fetch).toHaveBeenCalledTimes(1);
        onRemoteDocument.mockClear();
        onConflict.mockClear();
        defer = true;
        hook.rerender({
          enabled: change !== 'enabled',
          auth:
            change === 'account'
              ? session('user_next')
              : change === 'display-name'
                ? { ...auth, displayName: 'Changed name' }
                : auth
        });
        // Neither the old socket cleanup nor the replacement room setup has
        // run; only the new props and layout effects have committed.
        expect(FakeWebSocket.instances).toHaveLength(1);
        await act(async () => {
          resolve(
            new Response(JSON.stringify({ type: 'ack', version: 12345 }))
          );
          await settled;
        });
        if (settled) expect(await settled).toBeInstanceOf(Error);
        expect(hook.result.current.roomVersion).toBe(room.version);
        if (mode === 'keep-mine') {
          expect(hook.result.current.conflict).not.toBeNull();
        } else {
          expect(hook.result.current.conflict).toBeNull();
        }
        expect(onRemoteDocument).not.toHaveBeenCalled();
        expect(onConflict).not.toHaveBeenCalled();
      } finally {
        defer = false;
        effectSpy.mockImplementation(actualEffect);
        const cleanups: Array<() => void> = [];
        act(() => {
          for (const run of pendingEffects) {
            const cleanup = run();
            if (cleanup) cleanups.push(cleanup);
          }
        });
        hook.unmount();
        for (const cleanup of cleanups) cleanup();
      }
    }
  );

  it.each(['ack', 'rejection', 'body'] as const)(
    'ignores an old automatic save %s after changing projects',
    async (outcome) => {
      vi.useFakeTimers();
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const base = createProjectDocument('First room', toUserId('user_http'));
      const large = largeMeshDocument(base);
      const next = createProjectDocument('Next room', base.ownerUserId);
      let resolve!: (response: Response) => void;
      let reject!: (error: Error) => void;
      let resolveBody!: (text: string) => void;
      const fetch = vi.fn(
        () =>
          new Promise<Response>((yes, no) => {
            resolve = yes;
            reject = no;
          })
      );
      vi.stubGlobal('fetch', fetch);
      const onRemoteDocument = vi.fn();
      const onConflict = vi.fn();
      const { result, rerender, unmount } = renderHook(
        ({ document }: { document: ProjectDocument }) =>
          useCollaboration({
            enabled: true,
            document,
            session: session(base.ownerUserId),
            onRemoteDocument,
            onConflict
          }),
        { initialProps: { document: large } }
      );
      act(() => grantLease(FakeWebSocket.instances[0]!, base));
      expect(fetch).toHaveBeenCalledOnce();
      if (outcome === 'body') {
        await act(async () =>
          resolve({
            ok: true,
            text: () =>
              new Promise<string>((yes) => {
                resolveBody = yes;
              })
          } as Response)
        );
      }
      rerender({ document: next });
      const nextSocket = FakeWebSocket.instances.at(-1)!;
      act(() => {
        grantLease(nextSocket, next);
        nextSocket.receive({ type: 'ack', version: next.version });
      });
      await act(async () => {
        const ack = JSON.stringify({ type: 'ack', version: 12345 });
        if (outcome === 'rejection') reject(new Error('Offline'));
        else if (outcome === 'body') resolveBody(ack);
        else resolve(new Response(ack));
      });
      expect(result.current.status).toBe('live');
      expect(result.current.roomVersion).toBe(next.version);
      expect(onRemoteDocument).not.toHaveBeenCalled();
      expect(onConflict).not.toHaveBeenCalled();
      rerender({
        document: addPrimitiveFeature(next, {
          name: 'Next edit',
          primitiveKind: 'sphere',
          dimensions: { radius: 1 }
        })
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(nextSocket.frames().at(-1)).toMatchObject({
        type: 'document',
        baseVersion: next.version
      });
      unmount();
    }
  );

  it.each(['ack', 'rejection', 'body'] as const)(
    'ignores an old Keep my version %s after rejoining the same project',
    async (outcome) => {
      vi.useFakeTimers();
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const base = createProjectDocument(
        'Reopened room',
        toUserId('user_keep_http')
      );
      const local = largeMeshDocument(base);
      const remote = { ...base, name: 'Room copy', version: 8 };
      let resolve!: (response: Response) => void;
      let reject!: (error: Error) => void;
      let resolveBody!: (text: string) => void;
      const fetch = vi.fn(
        () =>
          new Promise<Response>((yes, no) => {
            resolve = yes;
            reject = no;
          })
      );
      vi.stubGlobal('fetch', fetch);
      const onRemoteDocument = vi.fn();
      const onConflict = vi.fn();
      const { result, rerender, unmount } = renderHook(
        ({
          enabled,
          document
        }: {
          enabled: boolean;
          document: ProjectDocument;
        }) =>
          useCollaboration({
            enabled,
            document,
            session: session(base.ownerUserId),
            onRemoteDocument,
            onConflict
          }),
        { initialProps: { enabled: true, document: local } }
      );
      const socket = FakeWebSocket.instances[0]!;
      act(() => {
        // Retain the conflict before granting the lease, so only the explicit
        // Keep my version decision sends the large HTTP submission.
        socket.open();
        socket.receive({ type: 'conflict', document: remote });
        grantLease(socket, remote);
      });
      let confirmation!: Promise<void>;
      act(() => {
        confirmation = result.current.keepLocalVersion(remote.version);
      });
      const settled = confirmation.then(
        () => null,
        (error: unknown) => error
      );
      expect(fetch).toHaveBeenCalledOnce();
      if (outcome === 'body') {
        await act(async () =>
          resolve({
            ok: true,
            text: () =>
              new Promise<string>((yes) => {
                resolveBody = yes;
              })
          } as Response)
        );
      }
      rerender({ enabled: false, document: base });
      // A new visit has a separate unresolved decision for the same project.
      localStorage.clear();
      rerender({ enabled: true, document: base });
      const newSocket = FakeWebSocket.instances.at(-1)!;
      act(() => {
        grantLease(newSocket, base);
        newSocket.receive({ type: 'ack', version: base.version });
        newSocket.receive({ type: 'conflict', document: remote });
      });
      onRemoteDocument.mockClear();
      onConflict.mockClear();
      let newConfirmation!: Promise<void>;
      act(() => {
        newConfirmation = result.current.keepLocalVersion(remote.version);
      });
      const newSettled = newConfirmation.then(
        () => null,
        (error: unknown) => error
      );
      await act(async () => {
        const ack = JSON.stringify({ type: 'ack', version: 12345 });
        if (outcome === 'rejection') reject(new Error('Offline'));
        else if (outcome === 'body') resolveBody(ack);
        else resolve(new Response(ack));
        await settled;
      });
      expect(await settled).toBeInstanceOf(Error);
      expect(result.current.status).toBe('connecting');
      expect(result.current.roomVersion).toBe(remote.version);
      expect(result.current.conflict).not.toBeNull();
      expect(onRemoteDocument).not.toHaveBeenCalled();
      expect(onConflict).not.toHaveBeenCalled();
      await expect(
        result.current.keepLocalVersion(remote.version)
      ).rejects.toThrow(/already waiting/);
      await act(async () => {
        newSocket.receive({ type: 'ack', version: remote.version + 1 });
        expect(await newSettled).toBeNull();
      });
      expect(result.current.conflict).toBeNull();
      unmount();
    }
  );
});

describe('useCollaboration lease ordering', () => {
  function connectedOwner(base: ProjectDocument) {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onRemoteDocument = vi.fn();
    const onConflict = vi.fn();
    const hook = renderHook(
      ({ document }: { document: ProjectDocument }) =>
        useCollaboration({
          enabled: true,
          document,
          session: session(base.ownerUserId),
          onRemoteDocument,
          onConflict
        }),
      { initialProps: { document: base } }
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() =>
      socket.receive({
        type: 'state',
        members: [],
        document: base,
        role: 'owner',
        lease: null
      })
    );
    const lease: ProjectEditLease = {
      leaseId: 'lease_local',
      projectId: base.projectId,
      clientId: socket.frames()[0]!.clientId as string,
      userId: base.ownerUserId,
      expiresAt: Date.now() + 30_000
    };
    act(() => socket.receive({ type: 'lease-granted', lease }));
    act(() => socket.receive({ type: 'ack', version: base.version }));
    return { ...hook, socket, lease, onRemoteDocument, onConflict };
  }

  it('waits for an acknowledgement before sending subsequent edits against the accepted base', () => {
    const base = createProjectDocument('Queued edits', toUserId('user_queued'));
    const { socket, rerender, unmount } = connectedOwner(base);
    const first = addPrimitiveFeature(base, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const second = addPrimitiveFeature(first, {
      name: 'Sphere',
      primitiveKind: 'sphere',
      dimensions: { radius: 2 }
    });
    rerender({ document: first });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender({ document: second });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(
      socket.frames().filter((frame) => frame.type === 'document')
    ).toHaveLength(2);
    act(() => socket.receive({ type: 'ack', version: first.version }));
    expect(socket.frames().at(-1)).toMatchObject({
      type: 'document',
      baseVersion: first.version,
      document: { version: second.version }
    });
    unmount();
  });

  it.each([false, true])(
    'adopts a merged acknowledgement only if it cannot discard newer local edits: %s',
    (editedAgain) => {
      const base = createProjectDocument(
        'Merged edits',
        toUserId('user_merged')
      );
      const {
        result,
        socket,
        rerender,
        unmount,
        onRemoteDocument,
        onConflict
      } = connectedOwner(base);
      const first = addPrimitiveFeature(base, {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      });
      const merged = addPrimitiveFeature(first, {
        name: 'Remote sphere',
        primitiveKind: 'sphere',
        dimensions: { radius: 2 }
      });
      const newerLocal = addPrimitiveFeature(first, {
        name: 'Local cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 1, height: 2 }
      });
      rerender({ document: first });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      if (editedAgain) rerender({ document: newerLocal });
      act(() =>
        socket.receive({
          type: 'ack',
          version: merged.version,
          document: merged
        })
      );
      if (editedAgain) {
        expect(onRemoteDocument).not.toHaveBeenCalled();
        expect(onConflict).toHaveBeenCalledWith(merged);
        expect(result.current.conflict?.localDocument.featureOrder).toEqual(
          newerLocal.featureOrder
        );
      } else {
        expect(onRemoteDocument).toHaveBeenCalledWith(merged, {
          adopted: true
        });
        expect(onConflict).not.toHaveBeenCalled();
      }
      unmount();
    }
  );

  it('adopts save-history acknowledgements even when the model version is unchanged', () => {
    const base = createProjectDocument(
      'Acknowledged save',
      toUserId('user_ack')
    );
    const { socket, onRemoteDocument, unmount } = connectedOwner(base);
    const saved = {
      ...base,
      checkpoints: [
        ...base.checkpoints,
        {
          checkpointId: 'cp_room',
          revisionId: base.revisions.at(-1)!.revisionId,
          documentVersion: base.version,
          reason: 'Before drilling',
          createdAt: '2026-10-05T05:00:00Z'
        }
      ]
    } as ProjectDocument;
    act(() =>
      socket.receive({ type: 'ack', version: base.version, document: saved })
    );
    expect(onRemoteDocument).toHaveBeenCalledWith(saved, { adopted: true });
    unmount();
  });

  it('does not adopt a late acknowledgement over edits that have not been submitted', () => {
    const base = createProjectDocument(
      'Late acknowledgement',
      toUserId('user_ack')
    );
    const { socket, rerender, unmount, onRemoteDocument, onConflict } =
      connectedOwner(base);
    const edited = addPrimitiveFeature(base, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    rerender({ document: edited });
    // The previous submission was already acknowledged; this edit is still
    // inside the send debounce when a duplicate acknowledgement arrives.
    act(() =>
      socket.receive({ type: 'ack', version: base.version, document: base })
    );
    expect(onRemoteDocument).not.toHaveBeenCalled();
    expect(onConflict).toHaveBeenCalledWith(base);
    unmount();
  });

  it('resubmits its unchanged local document after reconnecting with a fresh lease', () => {
    const base = createProjectDocument(
      'Reconnected',
      toUserId('user_reconnected')
    );
    const { socket, unmount, lease } = connectedOwner(base);
    act(() => socket.close());
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    const replacement = FakeWebSocket.instances.at(-1)!;
    expect(replacement).not.toBe(socket);
    act(() => replacement.open());
    act(() =>
      replacement.receive({
        type: 'state',
        members: [],
        document: base,
        role: 'owner',
        lease: null
      })
    );
    act(() => replacement.receive({ type: 'lease-granted', lease }));
    expect(replacement.frames().at(-1)).toMatchObject({
      type: 'document',
      document: { version: base.version }
    });
    unmount();
  });

  it.each([false, true])(
    'keeps concurrent edits based on the acknowledged room version (in flight: %s)',
    (inFlight) => {
      vi.useFakeTimers();
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const owner = toUserId('user_concurrent');
      const base = createProjectDocument('Two browsers', owner);
      const local = addPrimitiveFeature(base, {
        name: 'Local box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      });
      const remote = addPrimitiveFeature(base, {
        name: 'Remote sphere',
        primitiveKind: 'sphere',
        dimensions: { radius: 2 }
      });
      const onRemoteDocument = vi.fn();
      const onConflict = vi.fn();
      const { result, rerender, unmount } = renderHook(
        ({ document }: { document: ProjectDocument }) =>
          useCollaboration({
            enabled: true,
            document,
            session: session(owner),
            onRemoteDocument,
            onConflict
          }),
        { initialProps: { document: base } }
      );
      const socket = FakeWebSocket.instances[0]!;
      act(() => socket.open());
      act(() =>
        socket.receive({
          type: 'state',
          members: [],
          document: base,
          role: 'owner',
          lease: null
        })
      );
      act(() =>
        socket.receive({
          type: 'lease-granted',
          lease: {
            leaseId: 'lease_local',
            projectId: base.projectId,
            clientId: socket.frames()[0]!.clientId as string,
            userId: owner,
            expiresAt: Date.now() + 30_000
          }
        })
      );
      act(() => socket.receive({ type: 'ack', version: base.version }));
      rerender({ document: local });
      if (inFlight)
        act(() => {
          vi.advanceTimersByTime(500);
        });
      act(() =>
        socket.receive({
          type: 'document',
          clientId: 'other-browser',
          document: remote
        })
      );
      expect(onRemoteDocument).not.toHaveBeenCalled();
      expect(onConflict).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const submissions = socket
        .frames()
        .filter(
          (frame) =>
            frame.type === 'document' &&
            (frame.document as ProjectDocument).version === local.version
        );
      expect(submissions).toHaveLength(1);
      expect(submissions[0]).toMatchObject({
        baseVersion: base.version,
        document: { featureOrder: local.featureOrder }
      });
      expect(result.current.lease).not.toBeNull();
      unmount();
    }
  );

  it.each([true, false])(
    'preserves named checkpoint history when the remote contains it: %s',
    (remoteHasCheckpoint) => {
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const owner = toUserId('user_checkpoint_owner');
      const base = createProjectDocument('QA checkpoint', owner);
      const saved = structuredClone(base);
      saved.checkpoints.push({
        ...base.checkpoints[0]!,
        reason: 'QA named save'
      });
      const local = remoteHasCheckpoint ? base : saved;
      const remote = remoteHasCheckpoint ? saved : base;
      const onRemoteDocument = vi.fn();
      const { result, unmount } = renderHook(() =>
        useCollaboration({
          enabled: true,
          document: local,
          session: session(owner),
          onRemoteDocument,
          onConflict: vi.fn()
        })
      );
      act(() => {
        FakeWebSocket.instances[0]!.open();
        FakeWebSocket.instances[0]!.receive({
          type: 'conflict',
          document: remote
        });
      });
      if (remoteHasCheckpoint) {
        expect(result.current.conflict).toBeNull();
        expect(onRemoteDocument).toHaveBeenCalledWith(remote, {
          adopted: true
        });
      } else {
        expect(result.current.conflict).not.toBeNull();
        expect(onRemoteDocument).not.toHaveBeenCalled();
      }
      unmount();
      localStorage.clear();
    }
  );
  it.each(['state', 'conflict', 'document'] as const)(
    'reconciles a matching %s frame and clears only the room marker',
    (type) => {
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const owner = toUserId('user_matching_owner');
      const local = createProjectDocument('QA Matching', owner);
      const remote = structuredClone(local);
      remote.version += 2;
      remote.derived.updatedAt += 100;
      for (const source of ['room', 'account'] as const) {
        rememberUnresolvedConflict({
          projectId: local.projectId,
          source,
          localVersion: local.version,
          remoteVersion: remote.version,
          detectedAt: Date.now()
        });
      }
      const onRemoteDocument = vi.fn();
      const onConflict = vi.fn();
      const { result, unmount } = renderHook(() =>
        useCollaboration({
          enabled: true,
          document: local,
          session: session(owner),
          onRemoteDocument,
          onConflict
        })
      );
      const socket = FakeWebSocket.instances[0]!;
      act(() => {
        socket.open();
        socket.receive({
          type: 'state',
          document: null,
          members: [],
          role: 'viewer',
          lease: null
        });
        socket.receive(
          type === 'state'
            ? {
                type,
                document: remote,
                members: [],
                role: 'viewer',
                lease: null
              }
            : type === 'document'
              ? { type, document: remote, clientId: 'other' }
              : { type, document: remote }
        );
      });
      expect(result.current.conflict).toBeNull();
      expect(result.current.status).toBe('read-only');
      expect(onConflict).not.toHaveBeenCalled();
      expect(onRemoteDocument).toHaveBeenCalledWith(remote, { adopted: true });
      expect(readUnresolvedConflict(local.projectId, 'room')).toBeNull();
      expect(readUnresolvedConflict(local.projectId, 'account')).not.toBeNull();
      unmount();
      localStorage.clear();
    }
  );

  it('does not treat an equal version with different model content as matching', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const owner = toUserId('user_equal_version');
    const local = createProjectDocument('Local name', owner);
    const remote = { ...local, name: 'Remote name' };
    const onRemoteDocument = vi.fn();
    const { result, unmount } = renderHook(() =>
      useCollaboration({
        enabled: true,
        document: local,
        session: session(owner),
        onRemoteDocument,
        onConflict: vi.fn()
      })
    );
    act(() => {
      FakeWebSocket.instances[0]!.open();
      FakeWebSocket.instances[0]!.receive({
        type: 'conflict',
        document: remote
      });
    });
    expect(result.current.conflict?.remoteDocument.name).toBe('Remote name');
    expect(onRemoteDocument).not.toHaveBeenCalled();
    unmount();
    localStorage.clear();
  });
  it('reports the room as joining from the first render, never offline first', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const owner = toUserId('user_first_frame_owner');
    const first = createProjectDocument('First part', owner);
    const second = createProjectDocument('Second part', owner);
    const onRemoteDocument = vi.fn();
    const onConflict = vi.fn();
    const statuses: string[] = [];

    const { result, rerender } = renderHook(
      ({
        document,
        enabled
      }: {
        document: ProjectDocument;
        enabled: boolean;
      }) => {
        const state = useCollaboration({
          enabled,
          document,
          session: session(owner),
          onRemoteDocument,
          onConflict
        });
        statuses.push(state.status);
        return state;
      },
      { initialProps: { document: first, enabled: true } }
    );
    // The very first frame already says "connecting": the effect that opens
    // the socket has not run yet, and "offline" would be a state the room was
    // never in.
    expect(statuses[0]).toBe('connecting');
    act(() => FakeWebSocket.instances[0]!.open());
    act(() =>
      FakeWebSocket.instances[0]!.receive({
        type: 'state',
        members: [],
        document: first,
        role: 'owner',
        lease: null
      })
    );
    expect(result.current.status).not.toBe('offline');

    // Switching projects re-joins; the previous room's status must not show
    // against the new project for the frame before its effect runs.
    statuses.length = 0;
    rerender({ document: second, enabled: true });
    expect(statuses[0]).toBe('connecting');
    expect(statuses).not.toContain('offline');

    // Without a room wanted, the status is plainly offline.
    rerender({ document: second, enabled: false });
    expect(result.current.status).toBe('offline');
  });

  it('does not open a room while cloud functions are disabled', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const owner = toUserId('user_offline_owner');
    const document = createProjectDocument('Offline work', owner);
    const onRemoteDocument = vi.fn();
    const onConflict = vi.fn();

    renderHook(() =>
      useCollaboration({
        enabled: false,
        document,
        session: session(owner),
        onRemoteDocument,
        onConflict
      })
    );

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('submits a divergent local editor document only after the lease grant', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const owner = toUserId('user_offline_owner');
    const base = createProjectDocument('Offline work', owner);
    const local = addPrimitiveFeature(base, {
      name: 'Local box',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 3, depth: 4 }
    });
    const remote = addPrimitiveFeature(base, {
      name: 'Remote sphere',
      primitiveKind: 'sphere',
      dimensions: { radius: 5 }
    });
    const onRemoteDocument = vi.fn();
    const onConflict = vi.fn();
    const { unmount } = renderHook(() =>
      useCollaboration({
        enabled: true,
        document: local,
        session: session(owner),
        onRemoteDocument,
        onConflict
      })
    );
    const socket = FakeWebSocket.instances[0]!;

    act(() => socket.open());
    expect(socket.frames()[0]).toMatchObject({
      type: 'hello',
      document: null
    });

    act(() =>
      socket.receive({
        type: 'state',
        members: [],
        document: remote,
        role: 'owner',
        lease: null
      })
    );
    expect(onRemoteDocument).not.toHaveBeenCalled();
    expect(socket.frames().at(-1)).toMatchObject({
      type: 'lease-acquire'
    });

    const lease: ProjectEditLease = {
      leaseId: 'lease_local',
      projectId: local.projectId,
      clientId: socket.frames()[0]!.clientId as string,
      userId: owner,
      expiresAt: Date.now() + 30_000
    };
    act(() => socket.receive({ type: 'lease-granted', lease }));

    const submitted = socket.frames().at(-1) as {
      type: string;
      baseVersion: number;
      leaseId: string;
      document: typeof local;
    };
    expect(submitted.type).toBe('document');
    // Not `remote.version`, which is what this asserted while the room could
    // still be overwritten by a stale submission. `local` descends from `base`;
    // `remote` is its sibling, and this client refused to adopt it two frames
    // ago. Naming it as the merge base claims an ancestry this document does
    // not have, and the room then accepts it on version ordering alone. Having
    // adopted nothing this session, the honest answer is "no base".
    expect(submitted.baseVersion).toBeNull();
    expect(submitted.leaseId).toBe(lease.leaseId);
    expect(submitted.document.featureOrder).toEqual(local.featureOrder);
    expect(submitted.document.featureOrder).not.toEqual(remote.featureOrder);
    expect(onRemoteDocument).not.toHaveBeenCalled();
    expect(onConflict).not.toHaveBeenCalled();
    unmount();
  });

  it('raises a conflict rather than adopting a broadcast over unsubmitted work', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const owner = toUserId('user_unsent_owner');
    const base = createProjectDocument('Unsent work', owner);
    const local = addPrimitiveFeature(base, {
      name: 'Local box',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 3, depth: 4 }
    });
    const roomOne = addPrimitiveFeature(base, {
      name: 'Room sphere',
      primitiveKind: 'sphere',
      dimensions: { radius: 5 }
    });
    // The room has to end up ahead of the local version to reach adoption at
    // all; anything at or behind it is already ignored downstream.
    const roomTwo = addPrimitiveFeature(roomOne, {
      name: 'Room cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 1, height: 2 }
    });
    const onRemoteDocument = vi.fn();
    const onConflict = vi.fn();
    const { result, unmount } = renderHook(() =>
      useCollaboration({
        enabled: true,
        document: local,
        session: session(owner),
        onRemoteDocument,
        onConflict
      })
    );
    const socket = FakeWebSocket.instances[0]!;

    act(() => socket.open());
    act(() =>
      socket.receive({
        type: 'state',
        members: [],
        document: roomOne,
        role: 'editor',
        lease: null
      })
    );
    // No lease was granted, so this client never submitted its box and is
    // still holding it when the room moves on without it.
    act(() =>
      socket.receive({
        type: 'document',
        clientId: 'other-client',
        document: roomTwo
      })
    );

    expect(onRemoteDocument).not.toHaveBeenCalled();
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(result.current.conflict).not.toBeNull();
    expect(result.current.roomVersion).toBe(roomTwo.version);
    unmount();
  });

  it('lets a viewer adopt room state without requesting a lease', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const owner = toUserId('user_viewer_owner');
    const base = createProjectDocument('Viewer state', owner);
    const local = addPrimitiveFeature(base, {
      name: 'Stale local',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const remote = addPrimitiveFeature(base, {
      name: 'Room state',
      primitiveKind: 'sphere',
      dimensions: { radius: 2 }
    });
    const onRemoteDocument = vi.fn();
    const { unmount } = renderHook(() =>
      useCollaboration({
        enabled: true,
        document: local,
        session: session('user_read_only'),
        onRemoteDocument,
        onConflict: vi.fn()
      })
    );
    const socket = FakeWebSocket.instances[0]!;

    act(() => {
      socket.open();
      socket.receive({
        type: 'state',
        members: [],
        document: remote,
        role: 'viewer',
        lease: null
      });
    });

    expect(onRemoteDocument).toHaveBeenCalledOnce();
    expect(onRemoteDocument).toHaveBeenCalledWith(remote);
    expect(
      socket.frames().some((frame) => frame.type === 'lease-acquire')
    ).toBe(false);
    unmount();
  });

  it('retains a reloaded divergent viewer document without requesting a lease', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const owner = toUserId('user_reload_owner');
    const base = createProjectDocument('Reload conflict', owner);
    const local = addPrimitiveFeature(base, {
      name: 'Local box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const remote = addPrimitiveFeature(base, {
      name: 'Room sphere',
      primitiveKind: 'sphere',
      dimensions: { radius: 2 }
    });
    rememberUnresolvedConflict({
      projectId: base.projectId,
      source: 'room',
      localVersion: local.version,
      remoteVersion: remote.version,
      detectedAt: Date.now()
    });
    const onRemoteDocument = vi.fn();
    const onConflict = vi.fn();
    const { result, unmount } = renderHook(() =>
      useCollaboration({
        enabled: true,
        document: local,
        session: session('user_reload_viewer'),
        onRemoteDocument,
        onConflict
      })
    );
    const socket = FakeWebSocket.instances[0]!;

    act(() => {
      socket.open();
      socket.receive({
        type: 'state',
        members: [],
        document: remote,
        role: 'viewer',
        lease: null
      });
    });

    expect(result.current.status).toBe('conflict');
    expect(result.current.role).toBe('viewer');
    expect(result.current.conflict?.localDocument.featureOrder).toEqual(
      local.featureOrder
    );
    expect(onRemoteDocument).not.toHaveBeenCalled();
    expect(onConflict).toHaveBeenCalledWith(remote);
    expect(
      socket.frames().some((frame) => frame.type === 'lease-acquire')
    ).toBe(false);
    unmount();
  });

  it('keeps mine only with its active lease and exact expected room version', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const owner = toUserId('user_keep_owner');
    const base = createProjectDocument('Keep mine', owner);
    const local = addPrimitiveFeature(base, {
      name: 'Local box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 2, depth: 3 }
    });
    const remote = addPrimitiveFeature(base, {
      name: 'Room sphere',
      primitiveKind: 'sphere',
      dimensions: { radius: 4 }
    });
    const { result, unmount } = renderHook(() =>
      useCollaboration({
        enabled: true,
        document: local,
        session: session(owner),
        onRemoteDocument: vi.fn(),
        onConflict: vi.fn()
      })
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({
        type: 'state',
        members: [],
        document: remote,
        role: 'owner',
        lease: null
      });
    });
    const lease: ProjectEditLease = {
      projectId: base.projectId,
      leaseId: 'lease_keep',
      clientId: socket.frames()[0]!.clientId as string,
      userId: owner,
      expiresAt: Date.now() + 30_000
    };
    act(() => socket.receive({ type: 'lease-granted', lease }));
    act(() =>
      socket.receive({
        type: 'conflict',
        document: remote
      })
    );

    await expect(
      result.current.keepLocalVersion(remote.version + 1)
    ).rejects.toThrow(/room version changed/i);
    let confirmation!: Promise<void>;
    const confirmed = vi.fn();
    act(() => {
      confirmation = result.current.keepLocalVersion(remote.version);
      void confirmation.then(confirmed);
    });

    expect(result.current.lease).toEqual(lease);
    expect(socket.frames().at(-1)).toMatchObject({
      type: 'document',
      baseVersion: remote.version,
      leaseId: lease.leaseId,
      conflictResolution: 'keep-local',
      document: { featureOrder: local.featureOrder }
    });
    expect(confirmed).not.toHaveBeenCalled();
    expect(result.current.conflict).not.toBeNull();
    await act(async () => {
      socket.receive({ type: 'ack', version: remote.version + 1 });
      await confirmation;
    });
    expect(confirmed).toHaveBeenCalledOnce();
    expect(result.current.conflict).toBeNull();
    expect(readUnresolvedConflict(base.projectId, 'room')).toBeNull();
    unmount();
  });
});

describe('Keep my version confirmation failures', () => {
  function conflictWithLease() {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const base = createProjectDocument('Recovery', toUserId('user_recovery'));
    const local = addPrimitiveFeature(base, {
      name: 'Local box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 2, depth: 3 }
    });
    const remote = addPrimitiveFeature(base, {
      name: 'Remote sphere',
      primitiveKind: 'sphere',
      dimensions: { radius: 4 }
    });
    const onRemoteDocument = vi.fn();
    const hook = renderHook(
      ({ document }: { document: ProjectDocument }) =>
        useCollaboration({
          enabled: true,
          document,
          session: session(base.ownerUserId),
          onRemoteDocument,
          onConflict: vi.fn()
        }),
      { initialProps: { document: local } }
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({
        type: 'state',
        members: [],
        document: remote,
        role: 'owner',
        lease: null
      });
      socket.receive({
        type: 'lease-granted',
        lease: {
          projectId: base.projectId,
          leaseId: 'lease_recovery',
          clientId: socket.frames()[0]!.clientId as string,
          userId: base.ownerUserId,
          expiresAt: Date.now() + 30_000
        }
      });
      socket.receive({ type: 'conflict', document: remote });
    });
    return { ...hook, socket, local, remote, onRemoteDocument };
  }

  it.each([
    'rejection',
    'disconnect',
    'timeout',
    'conflict',
    'lease-lost',
    'unmount'
  ] as const)(
    'rejects on %s and retains the recovery decision',
    async (failure) => {
      const { result, socket, remote, unmount, onRemoteDocument } =
        conflictWithLease();
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      let confirmation!: Promise<void>;
      act(() => {
        confirmation = result.current.keepLocalVersion(remote.version);
      });
      const rejected = expect(confirmation).rejects.toThrow();
      await act(async () => {
        if (failure === 'rejection')
          socket.receive({
            type: 'error',
            code: 'permission-denied',
            message: 'Write refused'
          });
        if (failure === 'disconnect') socket.close();
        if (failure === 'timeout') vi.advanceTimersByTime(15_000);
        if (failure === 'conflict')
          socket.receive({ type: 'conflict', document: remote });
        if (failure === 'lease-lost')
          socket.receive({ type: 'lease-lost', reason: 'expired' });
        if (failure === 'unmount') unmount();
        await rejected;
      });
      expect(readUnresolvedConflict(remote.projectId, 'room')).not.toBeNull();
      expect(onRemoteDocument).not.toHaveBeenCalled();
      if (failure !== 'unmount') {
        expect(result.current.conflict).not.toBeNull();
        unmount();
      }
      consoleError.mockRestore();
    }
  );

  it('lets a rejected submission retry and only completes on its ack', async () => {
    const { result, socket, remote, unmount } = conflictWithLease();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    let first!: Promise<void>;
    act(() => {
      first = result.current.keepLocalVersion(remote.version);
    });
    const rejected = expect(first).rejects.toThrow('Write refused');
    await act(async () => {
      socket.receive({
        type: 'error',
        code: 'permission-denied',
        message: 'Write refused'
      });
      await rejected;
    });
    let retry!: Promise<void>;
    act(() => {
      retry = result.current.keepLocalVersion(remote.version);
    });
    await expect(
      result.current.keepLocalVersion(remote.version)
    ).rejects.toThrow(/already waiting/);
    await act(async () => {
      socket.receive({ type: 'ack', version: remote.version + 1 });
      await retry;
    });
    expect(result.current.conflict).toBeNull();
    unmount();
    consoleError.mockRestore();
  });

  it('does not overwrite edits made while Keep my version is in flight', async () => {
    const {
      result,
      socket,
      local,
      remote,
      rerender,
      unmount,
      onRemoteDocument
    } = conflictWithLease();
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = result.current.keepLocalVersion(remote.version);
    });
    const newer = addPrimitiveFeature(local, {
      name: 'New cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 1, height: 2 }
    });
    rerender({ document: newer });
    const rejected = expect(confirmation).rejects.toThrow(/Newer local edits/);
    await act(async () => {
      socket.receive({
        type: 'ack',
        version: remote.version + 1,
        document: { ...local, version: remote.version + 1 }
      });
      await rejected;
    });
    expect(result.current.conflict?.localDocument.featureOrder).toEqual(
      newer.featureOrder
    );
    expect(onRemoteDocument).not.toHaveBeenCalled();
    unmount();
  });
});

describe('inbound frame validation', () => {
  it('drops oversized, malformed, and foreign-project frames', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const owner = toUserId('user_guard_owner');
    const local = createProjectDocument('Guarded', owner);
    const foreign = createProjectDocument('Foreign', toUserId('user_other'));
    const onRemoteDocument = vi.fn();
    const onConflict = vi.fn();
    const { result, unmount } = renderHook(() =>
      useCollaboration({
        enabled: true,
        document: local,
        session: session(owner),
        onRemoteDocument,
        onConflict
      })
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    act(() => socket.receiveRaw('x'.repeat(2_000_001)));
    act(() => socket.receiveRaw('{not json'));
    act(() => socket.receiveRaw(JSON.stringify({ type: 'state' })));
    act(() =>
      socket.receiveRaw(
        JSON.stringify({
          type: 'document',
          clientId: 'peer',
          document: foreign
        })
      )
    );
    expect(onRemoteDocument).not.toHaveBeenCalled();
    expect(onConflict).not.toHaveBeenCalled();

    // The handler survived: a valid frame for this project is still adopted.
    act(() =>
      socket.receive({
        type: 'state',
        members: [],
        document: local,
        role: 'owner',
        lease: null
      })
    );
    expect(result.current.role).toBe('owner');
    unmount();
  });
});

describe('parseServerMessage', () => {
  const owner = toUserId('user_parse_owner');
  const document = createProjectDocument('Parsed', owner);

  it('accepts well-formed frames for the project', () => {
    expect(
      parseServerMessage(
        JSON.stringify({ type: 'document', clientId: 'p', document }),
        document.projectId
      )
    ).toMatchObject({ type: 'document' });
    expect(
      parseServerMessage(
        JSON.stringify({ type: 'ack', version: document.version }),
        document.projectId
      )
    ).toMatchObject({ type: 'ack' });
  });

  it('rejects frames with invalid roles, members, and lease targets', () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: 'state',
          members: [],
          document: null,
          role: 'superuser'
        }),
        document.projectId
      )
    ).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({ type: 'presence', members: [{ nope: 1 }] }),
        document.projectId
      )
    ).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({
          type: 'lease-granted',
          lease: {
            leaseId: 'l',
            projectId: 'project_other',
            clientId: 'c',
            userId: owner,
            expiresAt: Date.now() + 1000
          }
        }),
        document.projectId
      )
    ).toBeNull();
  });

  it('rejects documents from another project and oversize frames', () => {
    expect(
      parseServerMessage(
        JSON.stringify({ type: 'conflict', document }),
        'project_other'
      )
    ).toBeNull();
    expect(
      parseServerMessage(' '.repeat(2_000_001), document.projectId)
    ).toBeNull();
  });
});
