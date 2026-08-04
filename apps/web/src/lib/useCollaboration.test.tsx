import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type AuthSession,
  type CollaborationServerMessage,
  type ProjectEditLease
} from '@openzcad/shared';
import {
  readUnresolvedConflict,
  rememberUnresolvedConflict
} from './conflictRecovery';
import { useCollaboration } from './useCollaboration';
import { parseServerMessage } from './useCollaboration';

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
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  sessionStorage.clear();
});

describe('useCollaboration lease ordering', () => {
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
    expect(submitted.baseVersion).toBe(remote.version);
    expect(submitted.leaseId).toBe(lease.leaseId);
    expect(submitted.document.featureOrder).toEqual(local.featureOrder);
    expect(submitted.document.featureOrder).not.toEqual(remote.featureOrder);
    expect(onRemoteDocument).not.toHaveBeenCalled();
    expect(onConflict).not.toHaveBeenCalled();
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
      localVersion: local.version,
      remoteVersion: remote.version,
      detectedAt: Date.now()
    });
    const onRemoteDocument = vi.fn();
    const onConflict = vi.fn();
    const { result, unmount } = renderHook(() =>
      useCollaboration({
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
    await act(async () => {
      await result.current.keepLocalVersion(remote.version);
    });

    expect(result.current.lease).toEqual(lease);
    expect(socket.frames().at(-1)).toMatchObject({
      type: 'document',
      baseVersion: remote.version,
      leaseId: lease.leaseId,
      document: { featureOrder: local.featureOrder }
    });
    act(() => socket.receive({ type: 'ack', version: remote.version + 1 }));
    expect(result.current.conflict).toBeNull();
    expect(readUnresolvedConflict(base.projectId)).toBeNull();
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
