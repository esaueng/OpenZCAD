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
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { reconcileCopiedImportSources } from '@openzcad/persistence';
import {
  toArtifactId,
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

function setup(
  document: ProjectDocument,
  room = document,
  replaceRemoteManager = false
) {
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
        onRemoteDocument: vi.fn((next: ProjectDocument) => {
          if (
            replaceRemoteManager &&
            !localStore.projectsHaveSameRebuildInputs(live, next)
          )
            current = false;
        }),
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
  it.each([
    ['before action loads', 'success'],
    ['before debounce', 'success'],
    ['before debounce', 'lost response'],
    ['before debounce', 'buffered changes'],
    ['before debounce', 'buffered before ACK'],
    ['before debounce', 'buffered before ACK lost response'],
    ['before debounce history', 'success'],
    ['before debounce history', 'lost response'],
    ['while draining', 'success'],
    ['while draining', 'lost response'],
    ['while draining', 'buffered changes'],
    ['while draining', 'buffered before ACK'],
    ['while draining', 'buffered before ACK lost response'],
    ['while draining', 'foreign artifact'],
    ['while draining', 'unrelated content'],
    ['while draining', 'foreign owner'],
    ['while draining', 'foreign project']
  ] as const)(
    'validates source aliases acknowledged %s with %s',
    async (timing, scenario) => {
      const buffersBeforeAck =
        scenario === 'buffered before ACK' ||
        scenario === 'buffered before ACK lost response';
      const rejected = [
        'foreign artifact',
        'unrelated content',
        'foreign owner',
        'foreign project'
      ].includes(scenario);
      const base = createProjectDocument(
        'Canonical import checkpoint',
        toUserId('owner')
      );
      const manager = new CommandManager(base);
      manager.execute(
        commandFactories.importMesh({
          name: 'Copied mesh',
          sourceName: 'copy.stl',
          artifactId: 'artifact_local_copied_mesh',
          triangleCount: 1,
          meshPayloadRef: {
            marker: 'openzcad-source-ref',
            version: 1,
            hashAlgorithm: 'sha256',
            checksumSha256: 'a'.repeat(64),
            logicalBytes: 100
          }
        })
      );
      if (timing === 'before debounce history') manager.undo();
      const clicked = manager.document;
      const archives = [
        {
          projectId: clicked.projectId,
          artifactId: toArtifactId('artifact_owned_copied_mesh'),
          kind: 'mesh-payload' as const,
          checksumSha256: 'a'.repeat(64),
          logicalBytes: 100
        }
      ];
      const canonical = {
        ...reconcileCopiedImportSources(clicked, archives),
        version: clicked.version + 1
      };
      let saved!: ProjectDocument;
      let expectedLive: ProjectDocument | undefined;
      const fetch = vi.fn(
        async (_url: RequestInfo | URL, options?: RequestInit) => {
          const { document } = JSON.parse(options!.body as string) as {
            document: ProjectDocument;
          };
          saved = checkpoint({
            ...reconcileCopiedImportSources(document, archives),
            version: canonical.version
          });
          if (scenario.includes('lost response')) {
            act(() => {
              hook.socket.receive({
                type: 'document',
                clientId: sessionStorage.getItem(
                  'openzcad-collaboration-client'
                )!,
                document: saved
              });
              if (!buffersBeforeAck) hook.edit(saved);
            });
            throw new Error('Checkpoint response lost.');
          }
          if (scenario === 'buffered changes') {
            expectedLive = createSavedRevision(
              addPrimitiveFeature(canonical, {
                name: 'Buffered cylinder',
                primitiveKind: 'cylinder',
                dimensions: { radius: 2, height: 10 }
              }),
              'Buffered name'
            );
            hook.edit(expectedLive);
          }
          let responseDocument = saved;
          if (scenario === 'foreign artifact')
            responseDocument = JSON.parse(
              JSON.stringify(saved).replaceAll(
                'artifact_owned_copied_mesh',
                'artifact_foreign_untrusted'
              )
            ) as ProjectDocument;
          if (scenario === 'unrelated content')
            responseDocument = {
              ...addPrimitiveFeature(saved, {
                name: 'Unrelated box',
                primitiveKind: 'box',
                dimensions: { width: 2, depth: 2, height: 2 }
              }),
              version: saved.version
            };
          if (scenario === 'foreign owner')
            responseDocument = {
              ...saved,
              ownerUserId: toUserId('foreign-owner')
            };
          if (scenario === 'foreign project')
            responseDocument = {
              ...saved,
              projectId: createProjectDocument(
                'Foreign project',
                toUserId('owner')
              ).projectId
            };
          return new Response(
            JSON.stringify({
              type: 'ack',
              version: responseDocument.version,
              document: responseDocument
            })
          );
        }
      );
      vi.stubGlobal('fetch', fetch);
      const hook = timing.startsWith('before debounce')
        ? setup(base, base, !rejected)
        : setup(clicked, base, !rejected);
      if (timing.startsWith('before debounce')) hook.edit(clicked);
      const saving = hook.result.current
        .saveCheckpoint(clicked, 'Clicked model', hook.options)
        .catch((error: unknown) => error);
      if (buffersBeforeAck) {
        expectedLive = createSavedRevision(
          addPrimitiveFeature(clicked, {
            name: 'Buffered cylinder',
            primitiveKind: 'cylinder',
            dimensions: { radius: 2, height: 10 }
          }),
          'Buffered name'
        );
        hook.edit(expectedLive);
      }
      if (timing === 'while draining' || timing.startsWith('before debounce'))
        await act(async () => {
          await vi.dynamicImportSettled();
        });
      expect(fetch).not.toHaveBeenCalled();
      if (timing.startsWith('before debounce')) {
        const writes = hook.socket.sent.filter(
          (frame) => frame.type === 'document'
        );
        expect(writes).toHaveLength(1);
        expect(writes[0]?.document?.nodes).toEqual(clicked.nodes);
        expect(writes[0]?.document?.version).toBe(clicked.version);
      }
      act(() => {
        hook.socket.receive({
          type: 'ack',
          version: canonical.version,
          document: canonical
        });
        hook.edit(buffersBeforeAck ? hook.read() : canonical);
      });
      if (buffersBeforeAck)
        expectedLive = reconcileCopiedImportSources(expectedLive!, archives);
      let outcome: unknown;
      await act(async () => {
        outcome = await saving;
      });
      if (rejected) {
        expect(outcome).toBeInstanceOf(Error);
        expect(hook.read().ownerUserId).toBe(clicked.ownerUserId);
        expect(hook.read().projectId).toBe(clicked.projectId);
        expect(hook.read().nodes).toEqual(canonical.nodes);
        expect(hook.read().checkpoints).not.toEqual(saved.checkpoints);
        hook.unmount();
        return;
      }
      if (scenario.includes('lost response'))
        expect(outcome).toBeInstanceOf(Error);
      else expect(outcome).not.toBeInstanceOf(Error);
      const submitted = JSON.parse(fetch.mock.calls[0]![1]!.body as string) as {
        document: ProjectDocument;
      };
      expect(JSON.stringify(submitted.document)).not.toContain(
        'artifact_local_copied_mesh'
      );
      if (scenario === 'buffered changes' || buffersBeforeAck) {
        expect(hook.read().nodes).toEqual(expectedLive!.nodes);
        expect(
          hook
            .read()
            .checkpoints.some((point) => point.reason === 'Buffered name')
        ).toBe(true);
        expect(
          hook
            .read()
            .checkpoints.some(
              (point) =>
                point.checkpointId === saved.checkpoints.at(-1)!.checkpointId
            )
        ).toBe(true);
        expect(hook.read().version).toBeGreaterThan(saved.version);
      } else {
        expect(hook.read().checkpoints).toEqual(saved.checkpoints);
        expect(hook.read().version).toBe(saved.version);
      }
      expect(
        (
          await loadLocalSaveState(
            clicked.projectId,
            saved.checkpoints.at(-1)!.checkpointId
          )
        )?.nodes
      ).toEqual(canonical.nodes);
      hook.unmount();
    }
  );

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

  it.each(['lost response', 'deadline'] as const)(
    'preserves buffered edits and the unadopted server checkpoint after a %s',
    async (failure) => {
      const document = clickedModel('Buffered before checkpoint echo');
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
      const saving = hook.result.current
        .saveCheckpoint(document, 'Clicked model', hook.options)
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const later = addPrimitiveFeature(document, {
        name: 'Buffered cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 10 }
      });
      hook.edit(later);
      const saved = checkpoint(document);
      act(() => {
        hook.socket.receive({
          type: 'document',
          clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
          document: saved
        });
      });
      // Observing the named save must not replace the edited live model.
      expect(hook.read()).toBe(later);
      expect(hook.apply).not.toHaveBeenCalled();
      await act(async () => {
        if (failure === 'deadline') await vi.advanceTimersByTimeAsync(15_000);
        else fail(new Error('Checkpoint response lost.'));
        expect(await saving).toBeInstanceOf(Error);
      });
      expect(hook.read().nodes).toEqual(later.nodes);
      expect(hook.read().featureOrder).toEqual(later.featureOrder);
      expect(hook.read().checkpoints).toEqual(saved.checkpoints);
      expect(hook.read().revisions).toEqual(saved.revisions);
      expect(hook.read().version).toBeGreaterThan(saved.version);
      const frame = hook.socket.sent
        .filter((sent) => sent.type === 'document')
        .at(-1)!;
      expect(frame.baseVersion).toBe(saved.version);
      expect(frame.document?.version).toBeGreaterThan(saved.version);
      expect(frame.document?.nodes).toEqual(later.nodes);
      expect(frame.document?.checkpoints).toEqual(saved.checkpoints);
      expect(frame.document?.revisions).toEqual(saved.revisions);
      const local = await loadLocalSaveState(
        document.projectId,
        saved.checkpoints.at(-1)!.checkpointId
      );
      expect(local?.nodes).toEqual(saved.nodes);
      expect(local?.revisions).toEqual(saved.revisions);
      expect(
        await localStore.listLocalSaveStateIds(document.projectId)
      ).toHaveProperty('size', 1);
      hook.unmount();
    }
  );

  it.each([
    'other client',
    'other body',
    'other owner',
    'departed manager',
    'changed account'
  ] as const)(
    'does not trust an unadopted checkpoint echo from %s',
    async (mismatch) => {
      const document = clickedModel('Untrusted buffered checkpoint echo');
      let fail!: (error: Error) => void;
      const fetch = vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            fail = reject;
          })
      );
      vi.stubGlobal('fetch', fetch);
      const hook = setup(document);
      const saving = hook.result.current
        .saveCheckpoint(document, 'Clicked model', hook.options)
        .catch((error: unknown) => error);
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const later = addPrimitiveFeature(document, {
        name: 'Buffered cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 10 }
      });
      hook.edit(later);
      const echo = checkpoint(
        mismatch === 'other body'
          ? { ...document, name: 'Unrelated named model' }
          : mismatch === 'other owner'
            ? { ...document, ownerUserId: toUserId('another-owner') }
            : document
      );
      if (mismatch === 'departed manager') hook.leave();
      if (mismatch === 'changed account') hook.changeAccount();
      act(() => {
        hook.socket.receive({
          type: 'document',
          clientId:
            mismatch === 'other client'
              ? 'another-device'
              : sessionStorage.getItem('openzcad-collaboration-client')!,
          document: echo
        });
      });
      await act(async () => {
        fail(new Error('Checkpoint response lost.'));
        expect(await saving).toBeInstanceOf(Error);
      });
      expect(hook.read().nodes).toEqual(later.nodes);
      expect(
        await loadLocalSaveState(
          document.projectId,
          echo.checkpoints.at(-1)!.checkpointId
        )
      ).toBeNull();
      if (mismatch === 'departed manager' || mismatch === 'changed account') {
        expect(hook.apply).not.toHaveBeenCalled();
        expect(hook.read()).toBe(later);
        expect(
          hook.socket.sent.filter((sent) => sent.type === 'document')
        ).toHaveLength(0);
      } else {
        expect(hook.read().checkpoints.at(-1)?.checkpointId).not.toBe(
          echo.checkpoints.at(-1)!.checkpointId
        );
        const frame = hook.socket.sent
          .filter((sent) => sent.type === 'document')
          .at(-1)!;
        expect(frame.baseVersion).toBe(document.version);
      }
      hook.unmount();
    }
  );

  it.each(['role-changed', 'expired'] as const)(
    'keeps the lease-loss status after an observed checkpoint and %s lease',
    async (reason) => {
      const document = clickedModel('Checkpoint before lease loss');
      const fetch = vi.fn(() => new Promise<Response>(() => {}));
      vi.stubGlobal('fetch', fetch);
      const hook = setup(document);
      const saving = hook.result.current
        .saveCheckpoint(document, 'Clicked model', hook.options)
        .catch((error: unknown) => error);
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const later = addPrimitiveFeature(document, {
        name: 'Buffered cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 10 }
      });
      hook.edit(later);
      const saved = checkpoint(document);
      let failure: unknown;
      await act(async () => {
        hook.socket.receive({
          type: 'document',
          clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
          document: saved
        });
        hook.socket.receive({ type: 'lease-lost', reason });
        failure = await saving;
      });
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        'The revision is stored in the room.'
      );
      expect(hook.result.current.status).toBe(
        reason === 'role-changed' ? 'read-only' : 'connecting'
      );
      expect(hook.result.current.lease).toBeNull();
      expect(hook.read().nodes).toEqual(later.nodes);
      expect(hook.read().checkpoints).toContainEqual(saved.checkpoints.at(-1));
      expect(hook.read().revisions).toContainEqual(saved.revisions.at(-1));
      expect(
        hook.socket.sent.filter((sent) => sent.type === 'document')
      ).toHaveLength(0);
      expect(
        (
          await loadLocalSaveState(
            document.projectId,
            saved.checkpoints.at(-1)!.checkpointId
          )
        )?.revisions
      ).toEqual(saved.revisions);
      hook.unmount();
    }
  );

  it.each(
    (['checkpoint_lease', 'renewed_checkpoint_lease'] as const).flatMap(
      (leaseId) =>
        (['before settlement', 'after settlement'] as const).map((timing) => ({
          leaseId,
          timing
        }))
    )
  )(
    'publishes buffered descendants of the observed checkpoint after $leaseId returns $timing',
    async ({ leaseId, timing }) => {
      const document = clickedModel('Checkpoint lease renewal');
      const fetch = vi.fn(() => new Promise<Response>(() => {}));
      vi.stubGlobal('fetch', fetch);
      const hook = setup(document);
      const saving = hook.result.current
        .saveCheckpoint(document, 'Clicked model', hook.options)
        .catch((error: unknown) => error);
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const later = createSavedRevision(
        addPrimitiveFeature(document, {
          name: 'Buffered cylinder',
          primitiveKind: 'cylinder',
          dimensions: { radius: 2, height: 10 }
        }),
        'Buffered local note'
      );
      hook.edit(later);
      const saved = checkpoint(document);
      const grantLease = () =>
        hook.socket.receive({
          type: 'lease-granted',
          lease: {
            projectId: document.projectId,
            leaseId,
            clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
            userId: toUserId('member'),
            expiresAt: Date.now() + 60_000
          }
        });
      let failure: unknown;
      await act(async () => {
        hook.socket.receive({
          type: 'document',
          clientId: sessionStorage.getItem('openzcad-collaboration-client')!,
          document: saved
        });
        hook.socket.receive({ type: 'lease-lost', reason: 'expired' });
        if (timing === 'before settlement') grantLease();
        failure = await saving;
      });
      if (timing === 'after settlement') {
        // App's applyDocument publishes the merged manager document to React.
        hook.edit(hook.read());
        expect(hook.result.current.status).toBe('connecting');
        expect(
          hook.socket.sent.filter((frame) => frame.type === 'document')
        ).toHaveLength(0);
        act(grantLease);
      }
      const frame = hook.socket.sent
        .filter((sent) => sent.type === 'document')
        .at(-1)!;
      expect(frame.baseVersion).toBe(saved.version);
      expect(frame.document?.version).toBeGreaterThan(saved.version);
      expect((failure as Error).message).toContain(
        'The revision is stored in the room.'
      );
      expect(frame.document?.nodes).toEqual(later.nodes);
      expect(frame.document?.commandLog).toEqual(later.commandLog);
      expect(frame.document?.editHistory).toEqual(later.editHistory);
      expect(
        new Set(frame.document?.checkpoints.map((point) => point.checkpointId))
      ).toEqual(
        new Set(
          [...saved.checkpoints, ...later.checkpoints].map(
            (point) => point.checkpointId
          )
        )
      );
      expect(
        new Set(
          frame.document?.revisions.map((revision) => revision.revisionId)
        )
      ).toEqual(
        new Set(
          [...saved.revisions, ...later.revisions].map(
            (revision) => revision.revisionId
          )
        )
      );
      expect(hook.result.current.conflict).toBeNull();
      expect(hook.result.current.status).toBe('live');
      expect(fetch).toHaveBeenCalledOnce();
      expect(
        (
          await loadLocalSaveState(
            document.projectId,
            saved.checkpoints.at(-1)!.checkpointId
          )
        )?.revisions
      ).toEqual(saved.revisions);
      hook.unmount();
    }
  );

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
      const fallback = (
        await localStore.listLocalSaveStateCheckpoints(document.projectId)
      ).filter((point) => !echoIds.has(point.checkpointId));
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
        const local = (
          await localStore.listLocalSaveStateCheckpoints(document.projectId)
        ).find((point) => point.reason === 'Named after pending edit')!;
        expect(hook.read().checkpoints).not.toContainEqual(local);
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
    const typedFailure = expect(saving).rejects.toMatchObject({
      roomStored: true,
      deviceStored: false
    });
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
      await typedFailure;
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
    const saved = (
      await localStore.listLocalSaveStateCheckpoints(document.projectId)
    ).find((point) => point.reason === 'Retried locally')!;
    expect(hook.read()).toBe(document);
    expect(hook.apply).not.toHaveBeenCalled();
    expect(saved.reason).toBe('Retried locally');
    expect(
      (await loadLocalSaveState(document.projectId, saved.checkpointId))?.nodes
    ).toEqual(document.nodes);
    expect(hook.result.current.roomVersion).toBe(document.version);
    hook.unmount();
  });

  it.each([
    'plain model',
    'archived import',
    'local import',
    'local import compact ACK'
  ] as const)(
    'names an immediate %s while preserving edits buffered before its HTTP ACK',
    async (kind) => {
      const base = createProjectDocument(
        'Plain immediate named save',
        toUserId('owner')
      );
      let clicked = addPrimitiveFeature(base, {
        name: 'Clicked box',
        primitiveKind: 'box',
        dimensions: { width: 10, depth: 10, height: 10 }
      });
      if (kind !== 'plain model') {
        const manager = new CommandManager(base);
        manager.execute(
          commandFactories.importMesh({
            name: 'Archived mesh',
            sourceName: 'owned.stl',
            artifactId: kind.startsWith('local import')
              ? 'artifact_local_unarchived_mesh'
              : 'artifact_owned_mesh',
            triangleCount: 1,
            meshPayloadRef: {
              marker: 'openzcad-source-ref',
              version: 1,
              hashAlgorithm: 'sha256',
              checksumSha256: 'b'.repeat(64),
              logicalBytes: 100
            }
          })
        );
        clicked = manager.document;
      }
      const later = addPrimitiveFeature(clicked, {
        name: 'Buffered cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 10 }
      });
      let answer!: (response: Response) => void;
      const fetch = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          })
      );
      vi.stubGlobal('fetch', fetch);
      const hook = setup(base);
      vi.useFakeTimers();
      try {
        hook.edit(clicked);
        const saving = hook.result.current
          .saveCheckpoint(clicked, 'Clicked model', hook.options)
          .catch((error: unknown) => error);
        hook.edit(later);
        await act(async () => {
          await vi.dynamicImportSettled();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(501);
        });
        const writes = hook.socket.sent.filter(
          (frame) => frame.type === 'document'
        );
        if (kind.startsWith('local import') && writes.length > 0) {
          act(() => {
            hook.socket.receive({
              type: 'ack',
              version: clicked.version,
              ...(kind === 'local import compact ACK'
                ? {}
                : { document: clicked })
            });
          });
          await act(async () => {
            await vi.dynamicImportSettled();
          });
        } else expect(writes).toHaveLength(0);
        expect(fetch).toHaveBeenCalledOnce();
        vi.useRealTimers();
        const saved = checkpoint(clicked);
        let outcome: unknown;
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
          outcome = await saving;
        });
        expect(outcome).not.toBeInstanceOf(Error);
        expect(hook.read().nodes).toEqual(later.nodes);
        expect(hook.read().editHistory).toEqual(later.editHistory);
        expect(hook.read().checkpoints).toEqual(saved.checkpoints);
        expect(hook.read().version).toBeGreaterThan(saved.version);
        const latest = hook.socket.sent
          .filter((frame) => frame.type === 'document')
          .at(-1)!;
        expect(latest.baseVersion).toBe(saved.version);
        expect(latest.document?.nodes).toEqual(later.nodes);
        expect(
          (
            await loadLocalSaveState(
              clicked.projectId,
              saved.checkpoints.at(-1)!.checkpointId
            )
          )?.nodes
        ).toEqual(clicked.nodes);
      } finally {
        vi.useRealTimers();
        hook.unmount();
      }
    }
  );

  it.each(['owner', 'history', 'envelope'] as const)(
    'refuses an owned source flush ACK with changed %s before issuing a checkpoint',
    async (difference) => {
      const base = createProjectDocument('Strict flush ACK', toUserId('owner'));
      const manager = new CommandManager(base);
      manager.execute(
        commandFactories.importMesh({
          name: 'Local mesh',
          sourceName: 'local.stl',
          artifactId: 'artifact_local_mesh',
          triangleCount: 1,
          meshPayloadRef: {
            marker: 'openzcad-source-ref',
            version: 1,
            hashAlgorithm: 'sha256',
            checksumSha256: 'c'.repeat(64),
            logicalBytes: 100
          }
        })
      );
      const clicked = manager.document;
      const later = createSavedRevision(
        addPrimitiveFeature(clicked, {
          name: 'Buffered cylinder',
          primitiveKind: 'cylinder',
          dimensions: { radius: 2, height: 10 }
        }),
        'Buffered note'
      );
      const canonical = {
        ...reconcileCopiedImportSources(clicked, [
          {
            projectId: clicked.projectId,
            artifactId: toArtifactId('artifact_owned_mesh'),
            kind: 'mesh-payload',
            checksumSha256: 'c'.repeat(64),
            logicalBytes: 100
          }
        ]),
        version: clicked.version + 1
      };
      let acknowledged = canonical;
      if (difference === 'owner')
        acknowledged = { ...canonical, ownerUserId: toUserId('other-owner') };
      if (difference === 'history')
        acknowledged = createSavedRevision(canonical, 'Unexpected note');
      vi.stubGlobal('fetch', vi.fn());
      const hook = setup(base);
      hook.edit(clicked);
      const saving = hook.result.current
        .saveCheckpoint(clicked, 'Clicked model', hook.options)
        .catch((error: unknown) => error);
      hook.edit(later);
      await act(async () => {
        await vi.dynamicImportSettled();
      });
      act(() => {
        hook.socket.receive({
          type: 'ack',
          version: acknowledged.version + (difference === 'envelope' ? 1 : 0),
          document: acknowledged
        });
      });
      let outcome: unknown;
      await act(async () => {
        outcome = await saving;
      });
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(
        'did not confirm the clicked edit'
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(hook.apply).not.toHaveBeenCalled();
      expect(hook.read().nodes).toEqual(later.nodes);
      expect(hook.read().editHistory).toEqual(later.editHistory);
      expect(hook.read().checkpoints).toEqual(later.checkpoints);
      hook.unmount();
    }
  );

  it.each(['role-changed', 'expired'] as const)(
    'records a late owned flush without announcing live after lease %s',
    async (reason) => {
      const base = createProjectDocument('Late owned flush', toUserId('owner'));
      const manager = new CommandManager(base);
      manager.execute(
        commandFactories.importMesh({
          name: 'Local mesh',
          sourceName: 'local.stl',
          artifactId: 'artifact_local_mesh',
          triangleCount: 1,
          meshPayloadRef: {
            marker: 'openzcad-source-ref',
            version: 1,
            hashAlgorithm: 'sha256',
            checksumSha256: 'c'.repeat(64),
            logicalBytes: 100
          }
        })
      );
      const clicked = manager.document;
      const later = addPrimitiveFeature(clicked, {
        name: 'Buffered box',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 2, depth: 2 }
      });
      const canonical = {
        ...reconcileCopiedImportSources(clicked, [
          {
            projectId: clicked.projectId,
            artifactId: toArtifactId('artifact_owned_mesh'),
            kind: 'mesh-payload',
            checksumSha256: 'c'.repeat(64),
            logicalBytes: 100
          }
        ]),
        version: clicked.version + 1
      };
      let release!: () => void;
      const storage = vi
        .spyOn(localStore, 'saveLocalSaveStates')
        .mockReturnValue(
          new Promise<void>((resolve) => {
            release = resolve;
          })
        );
      vi.stubGlobal('fetch', vi.fn());
      const hook = setup(base);
      hook.edit(clicked);
      const saving = hook.result.current
        .saveCheckpoint(clicked, 'Clicked model', hook.options)
        .catch((error: unknown) => error);
      hook.edit(later);
      await act(async () => {
        await vi.dynamicImportSettled();
      });
      act(() => {
        hook.socket.receive({ type: 'lease-lost', reason });
      });
      await waitFor(() => expect(storage).toHaveBeenCalledOnce());
      const expectedStatus =
        reason === 'role-changed' ? 'read-only' : 'connecting';
      expect(hook.result.current.status).toBe(expectedStatus);
      try {
        act(() => {
          hook.socket.receive({
            type: 'ack',
            version: canonical.version,
            document: canonical
          });
        });
        expect(hook.result.current.status).toBe(expectedStatus);
        expect(hook.result.current.lease).toBeNull();
        expect(hook.result.current.roomVersion).toBe(canonical.version);
        expect(hook.read().bodyOrder).toHaveLength(2);
        expect(JSON.stringify(hook.read().nodes)).not.toContain(
          'artifact_local_mesh'
        );
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          release();
          await saving;
        });
        hook.unmount();
      }
    }
  );

  it('refuses to name a newer clicked model after an older pending edit is acknowledged', async () => {
    const base = createProjectDocument('Older pending edit', toUserId('owner'));
    const pending = addPrimitiveFeature(base, {
      name: 'Pending box',
      primitiveKind: 'box',
      dimensions: { width: 10, depth: 10, height: 10 }
    });
    const clicked = addPrimitiveFeature(pending, {
      name: 'Clicked cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 2, height: 10 }
    });
    vi.stubGlobal('fetch', vi.fn());
    const hook = setup(pending, base);
    hook.edit(clicked);
    const saving = hook.result.current
      .saveCheckpoint(clicked, 'Newer clicked model', hook.options)
      .catch((error: unknown) => error);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(fetch).not.toHaveBeenCalled();
    const writes = hook.socket.sent.filter(
      (frame) => frame.type === 'document'
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.document?.nodes).toEqual(pending.nodes);
    act(() => {
      hook.socket.receive({
        type: 'ack',
        version: pending.version,
        document: pending
      });
    });
    let outcome: unknown;
    await act(async () => {
      outcome = await saving;
    });
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('Newer local edits');
    expect(hook.read().nodes).toEqual(clicked.nodes);
    expect(hook.read().editHistory).toEqual(clicked.editHistory);
    expect(hook.apply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const local = (
      await localStore.listLocalSaveStateCheckpoints(clicked.projectId)
    ).find((point) => point.reason === 'Newer clicked model')!;
    expect(
      (await loadLocalSaveState(clicked.projectId, local.checkpointId))?.nodes
    ).toEqual(clicked.nodes);
    hook.unmount();
  });

  it.each(['expired lease', 'stale manager'] as const)(
    'does not flush a debounced clicked edit with %s',
    async (refusal) => {
      const base = createProjectDocument('Guarded flush', toUserId('owner'));
      const clicked = addPrimitiveFeature(base, {
        name: 'Clicked box',
        primitiveKind: 'box',
        dimensions: { width: 10, depth: 10, height: 10 }
      });
      vi.stubGlobal('fetch', vi.fn());
      const hook = setup(base);
      if (refusal === 'expired lease') {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
      } else hook.leave();
      hook.edit(clicked);
      let outcome: unknown;
      const saving = hook.result.current
        .saveCheckpoint(clicked, 'Clicked model', hook.options)
        .catch((error: unknown) => error);
      await act(async () => {
        outcome = await saving;
      });
      expect(outcome).toBeInstanceOf(Error);
      expect(fetch).not.toHaveBeenCalled();
      expect(
        hook.socket.sent.filter((frame) => frame.type === 'document')
      ).toHaveLength(0);
      expect(hook.read()).toBe(clicked);
      expect(hook.apply).not.toHaveBeenCalled();
      hook.unmount();
    }
  );

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
    const local = (
      await localStore.listLocalSaveStateCheckpoints(document.projectId)
    ).find((point) => point.reason === 'Local milestone')!;
    expect(hook.read()).toBe(document);
    expect(hook.apply).not.toHaveBeenCalled();
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
