import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type CollaborationServerMessage,
  type ProjectDocument
} from '@openzcad/shared';
import { useCollaboration } from './useCollaboration';

export class Socket extends EventTarget {
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
  globalThis.indexedDB = new IDBFactory();
  sessionStorage.clear();
  localStorage.clear();
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

export function setup(document: ProjectDocument) {
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

export function box(document: ProjectDocument, name: string) {
  return addPrimitiveFeature(document, {
    name,
    primitiveKind: 'box',
    dimensions: { width: 2, depth: 2, height: 2 }
  });
}

export async function rejectedSave(
  operation: Promise<ProjectDocument>
): Promise<Error> {
  let result: unknown;
  await act(async () => {
    result = await operation.catch((error: unknown) => error);
  });
  expect(result).toBeInstanceOf(Error);
  return result as Error;
}
