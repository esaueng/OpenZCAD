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

const codec = {
  encode: vi.fn<EncryptedRoomCodec['encode']>(),
  decode: vi.fn<EncryptedRoomCodec['decode']>(),
  catchUp: vi.fn<EncryptedRoomCodec['catchUp']>()
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
