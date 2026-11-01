/**
 * `useCollaboration` in an end-to-end encrypted project's room (ADR-024
 * slice 4-9). The codec is replaced by one whose "envelopes" carry the
 * document in the clear, so these cases test the hook's wiring: what it
 * sends, how it merges, reseals and keeps its last good version. The real
 * codec runs against the real Worker and room in `test/e2ee-room.test.ts`.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type AuthSession,
  type CollaborationMember,
  type ProjectAccessRole,
  type ProjectDocument,
  type ProjectEditLease
} from '@openzcad/shared';
import { parseServerMessage } from './collaborationProtocol';
import type {
  EncryptedRoomCodec,
  EncryptedRoomDecoding
} from './e2ee/encryptedRoomCodec';
import { useCollaboration } from './useCollaboration';
import { encryptionStateChanged } from './e2ee/encryptionStateEvents';

const codec = {
  encode: vi.fn<EncryptedRoomCodec['encode']>(),
  decode: vi.fn<EncryptedRoomCodec['decode']>(),
  catchUp: vi.fn<EncryptedRoomCodec['catchUp']>(),
  restoreBlobs: vi.fn<EncryptedRoomCodec['restoreBlobs']>()
};
const loadEncryptedRoomCodec = vi.fn(async (_projectId: string) => codec);

/** A frame as the fake room and the hook exchange it. */
interface FakeHead {
  plain?: ProjectDocument;
  unopenable?: boolean;
}
interface FakeFrame {
  type: string;
  projectId?: string;
  clientId?: string;
  leaseId?: string;
  members?: CollaborationMember[];
  role?: ProjectAccessRole;
  lease?: ProjectEditLease | null;
  head?: FakeHead;
  latest?: FakeHead;
  base?: FakeHead;
  record?: { documentVersion: number };
  version?: { envelope: string; signerDeviceId: string };
}

vi.mock('./e2ee/encryptedRoomCodec', () => ({
  loadEncryptedRoomCodec: (projectId: string) =>
    loadEncryptedRoomCodec(projectId)
}));

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: { data?: string }) => void>
  >();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  receive(message: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify(message) });
  }

  frames() {
    return this.sent.map((frame) => JSON.parse(frame) as FakeFrame);
  }

  private emit(type: string, event: { data?: string }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/**
 * Frames as the fake room speaks them: an encrypted frame's head carries
 * the document it "decrypts" to under `plain`.
 */
function fakeDecode(raw: string): EncryptedRoomDecoding {
  const frame = JSON.parse(raw) as FakeFrame;
  switch (frame.type) {
    case 'e2ee-state':
      return {
        message: {
          type: 'state',
          members: frame.members!,
          role: frame.role!,
          lease: frame.lease ?? null,
          document: frame.head!.plain!
        }
      };
    case 'e2ee-document':
      return frame.head!.unopenable
        ? {
            message: {
              type: 'error',
              code: 'document-invalid',
              message: 'The room holds a version this browser cannot open.'
            }
          }
        : {
            message: {
              type: 'document',
              clientId: frame.clientId!,
              document: frame.head!.plain!
            }
          };
    case 'e2ee-ack':
      return {
        message: { type: 'ack', version: frame.record!.documentVersion }
      };
    case 'e2ee-conflict':
      return {
        message: {
          type: 'conflict',
          document: frame.latest!.plain!,
          ...(frame.base ? { base: frame.base.plain! } : {})
        }
      };
    case 'e2ee-epoch':
      return { message: null, epochMoved: true };
    default:
      return { message: parseServerMessage(raw, frame.projectId ?? PROJECT) };
  }
}

let PROJECT = '';

const session = (userId: string): AuthSession => ({
  userId: toUserId(userId),
  displayName: userId,
  mode: 'development'
});

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

const withBox = (document: ProjectDocument, name: string) =>
  addPrimitiveFeature(document, {
    name,
    primitiveKind: 'box',
    dimensions: { width: 1, height: 1, depth: 1 }
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  codec.encode.mockImplementation(async (document, baseVersion) => ({
    kind: 'sealed',
    version: Math.max(document.version, (baseVersion ?? 0) + 1),
    submission: {
      envelope: 'ZW52ZWxvcGU',
      signature: 'c2ln',
      wrappedVersionKey: 'd3JhcA',
      signerDeviceId: 'device_laptop'
    }
  }));
  codec.decode.mockImplementation(async (raw) => fakeDecode(raw));
  codec.catchUp.mockResolvedValue(undefined);
  codec.restoreBlobs.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  FakeWebSocket.instances = [];
  sessionStorage.clear();
  localStorage.clear();
});

async function connectedOwner(base: ProjectDocument, encrypted = true) {
  PROJECT = base.projectId;
  const onRemoteDocument = vi.fn();
  const onConflict = vi.fn();
  const onAccountVersion = vi.fn();
  const hook = renderHook(
    ({ document }: { document: ProjectDocument }) =>
      useCollaboration({
        enabled: true,
        document,
        session: session(base.ownerUserId),
        onRemoteDocument,
        onConflict,
        encrypted,
        onAccountVersion
      }),
    { initialProps: { document: base } }
  );
  const socket = FakeWebSocket.instances[0]!;
  act(() => socket.open());
  const clientId = socket.frames()[0]!.clientId!;
  socket.receive(
    encrypted
      ? {
          type: 'e2ee-state',
          members: [],
          role: 'owner',
          lease: null,
          keyEpoch: 0,
          head: { plain: base }
        }
      : {
          type: 'state',
          members: [],
          role: 'owner',
          lease: null,
          document: base
        }
  );
  await flush();
  socket.receive({
    type: 'lease-granted',
    lease: {
      leaseId: 'lease_local',
      projectId: base.projectId,
      clientId,
      userId: base.ownerUserId,
      expiresAt: Date.now() + 30_000
    }
  });
  await flush();
  return { ...hook, socket, onRemoteDocument, onConflict, onAccountVersion };
}

async function edit(
  rerender: (props: { document: ProjectDocument }) => void,
  document: ProjectDocument
) {
  rerender({ document });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

describe('useCollaboration in an encrypted room (ADR-024 slice 4-9)', () => {
  it.each([true, false])(
    'refreshes only encrypted codecs after account key-state changes (encrypted=%s)',
    async (encrypted) => {
      const base = createProjectDocument('Recheck keys', toUserId('owner'));
      const hook = await connectedOwner(base, encrypted);
      const local = withBox(base, 'Unsent work');
      hook.rerender({ document: local });
      act(() => encryptionStateChanged('another_account'));
      await flush();
      expect(FakeWebSocket.instances).toHaveLength(1);
      act(() => encryptionStateChanged(base.ownerUserId));
      await flush();
      expect(FakeWebSocket.instances).toHaveLength(encrypted ? 2 : 1);
      if (!encrypted) {
        expect(hook.socket.readyState).toBe(FakeWebSocket.OPEN);
        expect(loadEncryptedRoomCodec).not.toHaveBeenCalled();
        hook.unmount();
        return;
      }
      expect(hook.socket.readyState).toBe(FakeWebSocket.CLOSED);
      expect(loadEncryptedRoomCodec).toHaveBeenCalledTimes(2);
      const fresh = FakeWebSocket.instances[1]!;
      act(() => fresh.open());
      fresh.receive({
        type: 'e2ee-state',
        members: [],
        role: 'owner',
        lease: null,
        keyEpoch: 1,
        head: { plain: base }
      });
      await flush();
      fresh.receive({
        type: 'lease-granted',
        lease: {
          leaseId: 'fresh_lease',
          projectId: base.projectId,
          clientId: fresh.frames()[0]!.clientId!,
          userId: base.ownerUserId,
          expiresAt: Date.now() + 30_000
        }
      });
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(codec.encode).toHaveBeenLastCalledWith(
        expect.objectContaining({
          nodes: local.nodes,
          featureOrder: local.featureOrder
        }),
        // A new codec uses its freshly verified head as the base.
        null
      );
      expect(
        fresh.frames().some((frame) => frame.type === 'e2ee-document')
      ).toBe(true);
      expect(hook.onRemoteDocument).not.toHaveBeenCalled();
      expect(hook.result.current.status).toBe('live');
      hook.unmount();
    }
  );

  it('does not decode after a codec download completes for a disposed room', async () => {
    const base = createProjectDocument(
      'Downloading codec',
      toUserId('user_codec_download')
    );
    let release!: () => void;
    loadEncryptedRoomCodec.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(codec);
        })
    );
    const { rerender, onRemoteDocument, unmount } = await connectedOwner(base);
    expect(codec.decode).not.toHaveBeenCalled();
    rerender({
      document: createProjectDocument('Different room', base.ownerUserId)
    });
    await flush();
    act(() => release());
    await flush();
    expect(codec.decode).not.toHaveBeenCalled();
    expect(onRemoteDocument).not.toHaveBeenCalled();
    unmount();
  });

  it('does not start a queued decode after its room is disposed by navigation', async () => {
    const base = createProjectDocument(
      'Old room',
      toUserId('user_queued_decode')
    );
    const { socket, rerender, onRemoteDocument, unmount } =
      await connectedOwner(base);
    codec.decode.mockClear();
    onRemoteDocument.mockClear();
    let release!: () => void;
    codec.decode.mockImplementationOnce(
      (raw) =>
        new Promise((resolve) => {
          release = () => resolve(fakeDecode(raw));
        })
    );
    socket.receive({
      type: 'e2ee-document',
      clientId: 'remote_first',
      head: { plain: withBox(base, 'First') }
    });
    socket.receive({
      type: 'e2ee-document',
      clientId: 'remote_second',
      head: { plain: withBox(base, 'Second') }
    });
    await flush();
    expect(codec.decode).toHaveBeenCalledTimes(1);
    rerender({ document: createProjectDocument('New room', base.ownerUserId) });
    await flush();
    act(() => release());
    await flush();
    expect(codec.decode).toHaveBeenCalledTimes(1);
    expect(onRemoteDocument).not.toHaveBeenCalled();
    unmount();
  });

  it('sends sealed envelopes, never a plaintext document, and reports the account version', async () => {
    const base = createProjectDocument('Sealed', toUserId('user_sealed'));
    const { socket, rerender, result, onAccountVersion, unmount } =
      await connectedOwner(base);
    expect(loadEncryptedRoomCodec).toHaveBeenCalledWith(base.projectId);
    const next = withBox(base, 'Box');
    await edit(rerender, next);
    expect(codec.encode).toHaveBeenCalledWith(
      expect.objectContaining({ version: next.version }),
      base.version
    );
    const sent = socket
      .frames()
      .filter((frame) => !['hello', 'lease-acquire'].includes(frame.type));
    expect(sent.map((frame) => frame.type)).toEqual(['e2ee-document']);
    expect(sent[0]).toMatchObject({
      leaseId: 'lease_local',
      version: { envelope: 'ZW52ZWxvcGU', signerDeviceId: 'device_laptop' }
    });
    expect(JSON.stringify(socket.sent)).not.toContain('"nodes"');

    socket.receive({
      type: 'e2ee-ack',
      record: { documentVersion: next.version }
    });
    await flush();
    expect(result.current.roomVersion).toBe(next.version);
    expect(result.current.status).toBe('live');
    expect(onAccountVersion).toHaveBeenCalledWith(base.projectId, next.version);
    unmount();
  });

  it('merges a stale edit with the base and latest an encrypted conflict carries', async () => {
    const base = createProjectDocument('Merged', toUserId('user_merged'));
    const { socket, rerender, onRemoteDocument, onConflict, unmount } =
      await connectedOwner(base);
    const local = withBox(base, 'Local box');
    const remote = withBox(base, 'Remote box');
    await edit(rerender, local);
    socket.receive({
      type: 'e2ee-conflict',
      latest: { plain: remote },
      base: { plain: base }
    });
    await flush();
    expect(onConflict).not.toHaveBeenCalled();
    expect(onRemoteDocument).toHaveBeenCalledTimes(1);
    const merged = onRemoteDocument.mock.calls[0]![0] as ProjectDocument;
    expect(merged.featureOrder).toEqual([
      ...remote.featureOrder,
      ...local.featureOrder
    ]);
    // Not the account's until the room acknowledges it: the account still
    // holds the latest version (#886 review).
    expect(onRemoteDocument.mock.calls[0]![1]).toEqual({
      adopted: true,
      accountVersion: remote.version
    });
    // Resealed on the latest version, as an envelope.
    expect(codec.encode).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: merged.version }),
      remote.version
    );
    expect(
      socket.frames().filter((frame) => frame.type === 'e2ee-document')
    ).toHaveLength(2);
    unmount();
  });

  it('reseals under the new key epoch when the room refuses an old one', async () => {
    const base = createProjectDocument('Epoch', toUserId('user_epoch'));
    const { socket, rerender, result, unmount } = await connectedOwner(base);
    await edit(rerender, withBox(base, 'Box'));
    socket.receive({ type: 'e2ee-epoch', keyEpoch: 1 });
    socket.receive({
      type: 'error',
      code: 'epoch-stale',
      message: 'The project’s keys moved to epoch 1.'
    });
    await flush();
    expect(codec.catchUp).toHaveBeenCalled();
    expect(codec.encode).toHaveBeenCalledTimes(2);
    expect(
      socket.frames().filter((frame) => frame.type === 'e2ee-document')
    ).toHaveLength(2);
    expect(result.current.status).toBe('live');
    unmount();
  });

  it('keeps the last good version when the room relays one it cannot open', async () => {
    const base = createProjectDocument('Kept', toUserId('user_kept'));
    const { socket, result, onRemoteDocument, unmount } =
      await connectedOwner(base);
    socket.receive({
      type: 'e2ee-document',
      clientId: 'other',
      head: { unopenable: true }
    });
    await flush();
    expect(onRemoteDocument).not.toHaveBeenCalled();
    expect(result.current.status).toBe('rejected');
    expect(result.current.roomVersion).toBe(base.version);
    unmount();
  });

  it('refuses to publish when sealing fails, keeping the edit local', async () => {
    const base = createProjectDocument('Locked', toUserId('user_locked'));
    const { socket, rerender, result, unmount } = await connectedOwner(base);
    codec.encode.mockRejectedValueOnce(new Error('Keys are locked.'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await edit(rerender, withBox(base, 'Box'));
    error.mockRestore();
    expect(result.current.status).toBe('rejected');
    expect(socket.frames().some((frame) => frame.type === 'document')).toBe(
      false
    );
    unmount();
  });

  it.each([false, true])(
    'resumes an unacknowledged edit after lease loss (encrypted=%s)',
    async (encrypted) => {
      const base = createProjectDocument(
        'Lease resume',
        toUserId('owner_lease_resume')
      );
      const hook = await connectedOwner(base, encrypted);
      const local = withBox(base, 'Pending box');
      await edit(hook.rerender, local);
      const frameType = encrypted ? 'e2ee-document' : 'document';
      expect(
        hook.socket.frames().filter((frame) => frame.type === frameType)
      ).toHaveLength(1);
      hook.socket.receive({ type: 'lease-lost', reason: 'expired' });
      await flush();
      const replacement = FakeWebSocket.instances.at(-1)!;
      const latest = withBox(local, 'Newer local box');
      await edit(hook.rerender, latest);
      if (replacement !== hook.socket) act(() => replacement.open());
      replacement.receive(
        encrypted
          ? {
              type: 'e2ee-state',
              members: [],
              role: 'owner',
              lease: null,
              keyEpoch: 0,
              head: { plain: base }
            }
          : {
              type: 'state',
              members: [],
              role: 'owner',
              lease: null,
              document: base
            }
      );
      await flush();
      expect(
        replacement
          .frames()
          .filter(
            (frame) =>
              frame.type === frameType && frame.leaseId === 'lease_resumed'
          )
      ).toHaveLength(0);
      replacement.receive({
        type: 'lease-granted',
        lease: {
          leaseId: 'lease_resumed',
          projectId: base.projectId,
          clientId: replacement.frames()[0]!.clientId!,
          userId: base.ownerUserId,
          expiresAt: Date.now() + 30_000
        }
      });
      await flush();
      const publications = replacement
        .frames()
        .filter(
          (frame) =>
            frame.type === frameType && frame.leaseId === 'lease_resumed'
        );
      expect(publications).toHaveLength(1);
      expect(publications[0]!.leaseId).toBe('lease_resumed');
      if (encrypted)
        expect(codec.encode.mock.calls.at(-1)![0].nodes).toEqual(latest.nodes);
      else
        expect(
          (publications[0] as unknown as { document: ProjectDocument }).document
            .nodes
        ).toEqual(latest.nodes);
      hook.socket.receive({ type: 'ack', version: latest.version });
      await flush();
      expect(hook.result.current.roomVersion).toBe(base.version);
      replacement.receive({ type: 'ack', version: latest.version });
      await flush();
      expect(hook.result.current.roomVersion).toBe(latest.version);
      expect(hook.result.current.status).toBe('live');
      hook.unmount();
    }
  );

  it.each(
    [false, true].flatMap((encrypted) =>
      (['accepted', 'divergent', 'role-changed'] as const).map((outcome) => ({
        encrypted,
        outcome
      }))
    )
  )(
    'preserves $outcome room state after lease loss (encrypted=$encrypted)',
    async ({ encrypted, outcome }) => {
      const base = createProjectDocument(
        'Lease reconciliation',
        toUserId('owner_lease_reconcile')
      );
      const hook = await connectedOwner(base, encrypted);
      const local = withBox(base, 'Local box');
      await edit(hook.rerender, local);
      hook.socket.receive({
        type: 'lease-lost',
        reason: outcome === 'role-changed' ? 'role-changed' : 'invalid'
      });
      await flush();
      if (outcome === 'role-changed') {
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(hook.result.current.status).toBe('read-only');
        expect(hook.result.current.role).toBe('viewer');
      } else {
        const replacement = FakeWebSocket.instances.at(-1)!;
        expect(replacement).not.toBe(hook.socket);
        act(() => replacement.open());
        const head =
          outcome === 'accepted' ? local : withBox(base, 'Remote box');
        replacement.receive(
          encrypted
            ? {
                type: 'e2ee-state',
                members: [],
                role: 'owner',
                lease: null,
                keyEpoch: 0,
                head: { plain: head }
              }
            : {
                type: 'state',
                members: [],
                role: 'owner',
                lease: null,
                document: head
              }
        );
        await flush();
        replacement.receive({
          type: 'lease-granted',
          lease: {
            leaseId: 'lease_reconciled',
            projectId: base.projectId,
            clientId: replacement.frames()[0]!.clientId!,
            userId: base.ownerUserId,
            expiresAt: Date.now() + 30_000
          }
        });
        await flush();
        const sent = replacement
          .frames()
          .filter(
            (frame) =>
              frame.type === 'document' || frame.type === 'e2ee-document'
          );
        if (outcome === 'accepted') {
          expect(sent).toHaveLength(0);
          expect(hook.result.current.roomVersion).toBe(local.version);
          expect(hook.result.current.status).toBe('live');
        } else {
          // A divergent head is never silently adopted as our merge base.
          // Its fenced submission must still go through the room's reply.
          expect(sent).toHaveLength(1);
          if (encrypted) expect(codec.encode.mock.calls.at(-1)![1]).toBeNull();
          else
            expect(
              (sent[0] as unknown as { baseVersion: number | null }).baseVersion
            ).toBeNull();
          replacement.receive(
            encrypted
              ? { type: 'e2ee-conflict', latest: { plain: head } }
              : { type: 'conflict', document: head }
          );
          await flush();
          expect(hook.result.current.status).toBe('conflict');
          expect(hook.result.current.conflict?.localDocument.nodes).toEqual(
            local.nodes
          );
          expect(hook.result.current.conflict?.remoteDocument.nodes).toEqual(
            head.nodes
          );
        }
      }
      hook.unmount();
    }
  );

  it.each([false, true])(
    'keeps an unconfirmed local edit when rejoining as a viewer (encrypted=%s)',
    async (encrypted) => {
      const base = createProjectDocument(
        'Read-only recovery',
        toUserId('owner_viewer_recovery')
      );
      const hook = await connectedOwner(base, encrypted);
      const local = withBox(base, 'Unconfirmed box');
      await edit(hook.rerender, local);
      hook.socket.receive({ type: 'lease-lost', reason: 'expired' });
      await flush();
      const replacement = FakeWebSocket.instances.at(-1)!;
      act(() => replacement.open());
      replacement.receive(
        encrypted
          ? {
              type: 'e2ee-state',
              members: [],
              role: 'viewer',
              lease: null,
              keyEpoch: 0,
              head: { plain: base }
            }
          : {
              type: 'state',
              members: [],
              role: 'viewer',
              lease: null,
              document: base
            }
      );
      await flush();
      expect(hook.onRemoteDocument).not.toHaveBeenCalled();
      expect(hook.result.current.role).toBe('viewer');
      expect(hook.result.current.status).toBe('conflict');
      expect(hook.result.current.conflict?.localDocument.nodes).toEqual(
        local.nodes
      );
      expect(hook.result.current.conflict?.remoteDocument.nodes).toEqual(
        base.nodes
      );
      expect(
        replacement
          .frames()
          .filter(
            (frame) =>
              frame.type === 'document' || frame.type === 'e2ee-document'
          )
      ).toHaveLength(0);
      hook.unmount();
    }
  );

  it('drops a sealing result from the lease connection that was retired', async () => {
    const base = createProjectDocument(
      'Retired seal',
      toUserId('owner_retired_seal')
    );
    const hook = await connectedOwner(base);
    const local = withBox(base, 'Pending box');
    let finish!: (
      value: Awaited<ReturnType<EncryptedRoomCodec['encode']>>
    ) => void;
    codec.encode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await edit(hook.rerender, local);
    hook.socket.receive({ type: 'lease-lost', reason: 'expired' });
    await flush();
    const replacement = FakeWebSocket.instances.at(-1)!;
    expect(replacement).not.toBe(hook.socket);
    act(() => replacement.open());
    replacement.receive({
      type: 'e2ee-state',
      members: [],
      role: 'owner',
      lease: null,
      keyEpoch: 0,
      head: { plain: base }
    });
    await flush();
    replacement.receive({
      type: 'lease-granted',
      lease: {
        leaseId: 'lease_after_seal',
        projectId: base.projectId,
        clientId: replacement.frames()[0]!.clientId!,
        userId: base.ownerUserId,
        expiresAt: Date.now() + 30_000
      }
    });
    await flush();
    finish({
      kind: 'sealed',
      version: local.version,
      submission: {
        envelope: 'old-envelope',
        signature: 'old-signature',
        wrappedVersionKey: 'old-wrapped-key',
        signerDeviceId: 'device_laptop'
      }
    });
    await flush();
    expect(
      hook.socket.frames().filter((frame) => frame.type === 'e2ee-document')
    ).toHaveLength(0);
    const sent = replacement
      .frames()
      .filter((frame) => frame.type === 'e2ee-document');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.leaseId).toBe('lease_after_seal');
    expect(sent[0]!.version?.envelope).not.toBe('old-envelope');
    hook.unmount();
  });

  it('rejoins a rejected publication with the unsent edit and a fresh lease', async () => {
    const base = createProjectDocument(
      'Retry publication',
      toUserId('owner_retry')
    );
    const hook = await connectedOwner(base);
    const local = withBox(base, 'Unsent box');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    codec.encode.mockRejectedValueOnce(new Error('Keys are locked.'));
    await edit(hook.rerender, local);
    expect(hook.result.current.failureReason).toBe('Keys are locked.');
    expect(hook.result.current.status).toBe('rejected');
    act(() => hook.result.current.retryConnection());
    expect(hook.result.current.status).toBe('connecting');
    const retry = FakeWebSocket.instances.at(-1)!;
    expect(retry).not.toBe(hook.socket);
    expect(hook.socket.readyState).toBe(FakeWebSocket.CLOSED);
    act(() => retry.open());
    retry.receive({
      type: 'e2ee-state',
      members: [],
      role: 'owner',
      lease: null,
      keyEpoch: 0,
      head: { plain: base }
    });
    await flush();
    // No publication uses the retired lease or runs before a new grant.
    expect(
      retry.frames().filter((frame) => frame.type === 'e2ee-document')
    ).toHaveLength(0);
    retry.receive({
      type: 'lease-granted',
      lease: {
        leaseId: 'retry_lease',
        projectId: base.projectId,
        clientId: retry.frames()[0]!.clientId!,
        userId: base.ownerUserId,
        expiresAt: Date.now() + 30_000
      }
    });
    await flush();
    const sent = retry
      .frames()
      .filter((frame) => frame.type === 'e2ee-document');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ leaseId: 'retry_lease' });
    expect(codec.encode.mock.calls.at(-1)![0].nodes).toEqual(local.nodes);
    // A stale reply from the old room cannot acknowledge the retry.
    hook.socket.receive({ type: 'ack', version: local.version });
    await flush();
    expect(hook.result.current.roomVersion).toBe(base.version);
    retry.receive({ type: 'ack', version: local.version });
    await flush();
    expect(hook.result.current.roomVersion).toBe(local.version);
    expect(hook.result.current.status).toBe('live');
    act(() => hook.result.current.retryConnection());
    expect(FakeWebSocket.instances.at(-1)).toBe(retry);
    error.mockRestore();
    hook.unmount();
  });

  it('keeps this device’s version by sealing it on the room’s', async () => {
    const base = createProjectDocument('Keep', toUserId('user_keep'));
    const { socket, rerender, result, unmount } = await connectedOwner(base);
    const local = withBox(base, 'Local box');
    const remote = { ...withBox(base, 'Remote box'), version: 5 };
    await edit(rerender, local);
    // No base the browser holds: the choice is the user's.
    socket.receive({ type: 'e2ee-conflict', latest: { plain: remote } });
    await flush();
    expect(result.current.status).toBe('conflict');
    let kept!: Promise<void>;
    act(() => {
      kept = result.current.keepLocalVersion(remote.version);
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await flush();
    expect(codec.encode).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: remote.version + 1 }),
      remote.version,
      { echo: true }
    );
    const sealed = codec.encode.mock.calls.at(-1)![0];
    expect(sealed.revisions.at(-1)?.reason).toBe('Kept this device’s version');
    expect(socket.frames().at(-1)).toMatchObject({
      type: 'e2ee-document',
      leaseId: 'lease_local'
    });
    socket.receive({
      type: 'e2ee-ack',
      record: { documentVersion: remote.version + 1 }
    });
    await flush();
    await kept;
    expect(result.current.conflict).toBeNull();
    unmount();
  });

  it('sends named saves to the account, not the room', async () => {
    const base = createProjectDocument('Named', toUserId('user_named'));
    const { result, unmount } = await connectedOwner(base);
    await expect(
      result.current.saveCheckpoint(base, 'Named', {
        isCurrent: () => true,
        readDocument: () => base,
        applyDocument: () => {}
      })
    ).rejects.toThrow('account');
    unmount();
  });

  it('turns read-only when this account’s own MLS role refuses to seal (slice 5-6)', async () => {
    const base = createProjectDocument('Demoted', toUserId('user_demoted'));
    const { socket, rerender, result, unmount } = await connectedOwner(base);
    // What the codec throws for its own role refusal
    // (`EncryptedRoomCodecError` with `readOnly`).
    codec.encode.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Viewers can read this encrypted project but cannot change it.'
        ),
        { readOnly: true }
      )
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await edit(rerender, withBox(base, 'Box'));
    error.mockRestore();
    expect(result.current.status).toBe('read-only');
    expect(result.current.role).toBe('viewer');
    expect(result.current.lease).toBeNull();
    // Nothing more is sealed or sent.
    await edit(rerender, withBox(withBox(base, 'Box'), 'Another'));
    expect(codec.encode).toHaveBeenCalledTimes(1);
    expect(
      socket.frames().filter((frame) => frame.type === 'e2ee-document')
    ).toHaveLength(0);
    unmount();
  });

  it('stops submitting when the room’s role notice says the role changed (slice 5-6)', async () => {
    const base = createProjectDocument('Notice', toUserId('user_notice'));
    const { socket, rerender, result, unmount } = await connectedOwner(base);
    socket.receive({ type: 'lease-lost', reason: 'role-changed' });
    await flush();
    expect(result.current.status).toBe('read-only');
    await edit(rerender, withBox(base, 'Box'));
    expect(codec.encode).not.toHaveBeenCalled();
    unmount();
  });

  it('stores a lost blob again and resubmits once when the room says blob-unknown (slice 5-6)', async () => {
    const base = createProjectDocument('Lost', toUserId('user_lost'));
    const { socket, rerender, result, unmount } = await connectedOwner(base);
    const next = withBox(base, 'Box');
    await edit(rerender, next);
    const refusal = {
      type: 'error',
      code: 'blob-unknown',
      message: 'This version names files the account does not hold.',
      blobIds: ['a'.repeat(32)]
    };
    socket.receive(refusal);
    await flush();
    expect(codec.restoreBlobs).toHaveBeenCalledWith(['a'.repeat(32)]);
    expect(codec.encode).toHaveBeenCalledTimes(2);
    expect(
      socket.frames().filter((frame) => frame.type === 'e2ee-document')
    ).toHaveLength(2);
    // A second refusal of the same edit is not repaired again.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    socket.receive(refusal);
    await flush();
    error.mockRestore();
    expect(codec.restoreBlobs).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('rejected');
    unmount();
  });

  it('reports a lost blob it cannot store again as refused', async () => {
    const base = createProjectDocument('Gone', toUserId('user_gone'));
    const { socket, rerender, result, unmount } = await connectedOwner(base);
    await edit(rerender, withBox(base, 'Box'));
    codec.restoreBlobs.mockRejectedValueOnce(new Error('No copy here.'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    socket.receive({
      type: 'error',
      code: 'blob-unknown',
      message: 'This version names files the account does not hold.'
    });
    await flush();
    error.mockRestore();
    expect(codec.restoreBlobs).toHaveBeenCalledWith([]);
    expect(codec.encode).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('rejected');
    unmount();
  });

  it('keeps a plaintext room plaintext and never loads the codec', async () => {
    const base = createProjectDocument('Plain', toUserId('user_plain'));
    const { socket, rerender, onAccountVersion, unmount } =
      await connectedOwner(base, false);
    await edit(rerender, withBox(base, 'Box'));
    expect(loadEncryptedRoomCodec).not.toHaveBeenCalled();
    expect(codec.encode).not.toHaveBeenCalled();
    expect(
      socket
        .frames()
        .filter((frame) => !['hello', 'lease-acquire'].includes(frame.type))
    ).toEqual([expect.objectContaining({ type: 'document' })]);
    socket.receive({ type: 'ack', version: base.version + 1 });
    await flush();
    expect(onAccountVersion).not.toHaveBeenCalled();
    unmount();
  });
});
