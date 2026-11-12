import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectDocument,
  addPrimitiveFeature,
  booleanBodies
} from '@openzcad/document-core';
import { toBodyId, toUserId } from '@openzcad/shared';
import type { CommandManager } from '@openzcad/command-system';
import type { GeometryWorkerResult } from '../worker/geometryWorker';
import { useGeometryWorker } from './useGeometryWorker';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<GeometryWorkerResult>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  emit(message: GeometryWorkerResult) {
    this.onmessage?.({ data: message } as MessageEvent<GeometryWorkerResult>);
  }
}

function installWorker() {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useGeometryWorker lineage demand', () => {
  it('posts demand on broadcast syncs and dedupes per version+demand', () => {
    installWorker();
    let document = createProjectDocument('Demand sync', toUserId('user'));
    for (const name of ['A', 'B'])
      document = addPrimitiveFeature(document, {
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 8, depth: 6 }
      });
    const union = booleanBodies(document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [...document.bodyOrder]
    });
    document = union.document;
    const host = { manager: () => null, onDerived: vi.fn(), onError: vi.fn() };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const bodyId = union.bodyId;

    result.current.sync(document);
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'sync' })
    );

    result.current.sync(document, [bodyId]);
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'sync', lineageDemand: [bodyId] })
    );

    // Same version+demand does not re-post.
    const calls = worker.postMessage.mock.calls.length;
    result.current.sync(document, [bodyId]);
    expect(worker.postMessage.mock.calls.length).toBe(calls);
  });

  it('gives one-off syncs full lineage unless they ask for a demand', async () => {
    installWorker();
    const document = createProjectDocument('Demand once', toUserId('user'));
    const host = { manager: () => null, onDerived: vi.fn(), onError: vi.fn() };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const bodyId = toBodyId('body_demanded');

    result.current.sync(document, [bodyId]);
    // A preview, preflight or demo seed reads lineage from the result, so it
    // must not opt into the idle skip just because the viewport demanded.
    const pending = result.current.syncOnce(document);
    const request = worker.postMessage.mock.calls.at(-1)![0] as {
      requestId: string;
      lineageDemand?: unknown;
    };
    expect(request.lineageDemand).toBeUndefined();
    // Left unanswered; it rejects when the hook unmounts.
    result.current
      .syncOnce(document, undefined, [bodyId])
      .catch(() => undefined);
    const explicit = worker.postMessage.mock.calls.at(-1)![0] as {
      lineageDemand?: unknown;
    };
    expect(explicit.lineageDemand).toEqual([bodyId]);
    act(() => {
      worker.emit({
        type: 'sync',
        ok: true,
        requestId: request.requestId,
        projectId: document.projectId,
        version: document.version,
        derived: document.derived
      });
    });
    await expect(pending).resolves.toEqual(document.derived);
  });
});

describe('useGeometryWorker persisted kernel sessions', () => {
  const persistOf = (worker: FakeWorker) =>
    (worker.postMessage.mock.calls.at(-1)![0] as { persistSession?: unknown })
      .persistSession;

  const broadcasts = (worker: FakeWorker) =>
    worker.postMessage.mock.calls.filter(
      ([message]) =>
        (message as { type?: string; requestId?: string }).type === 'sync' &&
        !(message as { requestId?: string }).requestId
    ).length;

  it('marks only the broadcasts the app says to persist', () => {
    installWorker();
    const document = createProjectDocument('Own project', toUserId('user'));
    const host = { manager: () => null, onDerived: vi.fn(), onError: vi.fn() };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;

    // Unset is false: a shared link's model or someone else's project.
    result.current.sync(document, []);
    expect(persistOf(worker)).toBeUndefined();
    expect(broadcasts(worker)).toBe(1);
    // A change of the policy alone rebuilds nothing: the worker is told on
    // its own, once.
    result.current.sync(document, [], { persistSession: true });
    expect(broadcasts(worker)).toBe(1);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'session-policy',
      projectId: document.projectId,
      persistSession: true
    });
    const calls = worker.postMessage.mock.calls.length;
    result.current.sync(document, [], { persistSession: true });
    expect(worker.postMessage.mock.calls.length).toBe(calls);
    result.current.sync(document, [], { persistSession: false });
    expect(broadcasts(worker)).toBe(1);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'session-policy',
      projectId: document.projectId,
      persistSession: false
    });

    // A new revision carries the flag on its broadcast.
    const edited = { ...document, version: document.version + 1 };
    result.current.sync(edited, [], { persistSession: true });
    expect(broadcasts(worker)).toBe(2);
    expect(persistOf(worker)).toBe(true);

    // A one-off rebuild never persists.
    result.current.syncOnce(edited).catch(() => undefined);
    expect(persistOf(worker)).toBeUndefined();
  });

  it('posts no broadcast for a save echo it retains', () => {
    // Regression: the retained echo's sync key lacked the persisted flag,
    // so the app's next sync of the same geometry re-posted a full rebuild.
    installWorker();
    const document = createProjectDocument('Saved', toUserId('user'));
    const manager = { document } as CommandManager;
    const host = {
      manager: () => manager,
      onDerived: vi.fn(),
      onError: vi.fn()
    };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    act(() => {
      result.current.sync(document, [], { persistSession: true });
      worker.emit({
        type: 'sync',
        ok: true,
        projectId: document.projectId,
        version: document.version,
        derived: document.derived
      });
      worker.emit({
        type: 'state',
        phase: 'ready',
        projectId: document.projectId,
        version: document.version,
        stale: false
      });
    });
    const calls = worker.postMessage.mock.calls.length;
    const echo = { ...document, version: document.version + 1 };
    act(() => {
      expect(result.current.retainReadyGeometry(echo)).toBe(true);
      manager.document = echo;
    });
    act(() => result.current.sync(echo, [], { persistSession: true }));
    expect(worker.postMessage.mock.calls.length).toBe(calls);
    expect(result.current.isReadyFor(echo)).toBe(true);
  });

  it('keeps the flag for the rebuild a respawned worker owes', async () => {
    installWorker();
    const document = createProjectDocument('Respawned', toUserId('user'));
    const host = {
      manager: () => ({ document }) as never,
      onDerived: vi.fn(),
      onError: vi.fn()
    };
    const { result } = renderHook(() => useGeometryWorker(host));
    result.current.sync(document, [], { persistSession: true });
    await act(async () => {
      FakeWorker.instances[0]!.onerror?.({} as ErrorEvent);
    });
    const replacement = FakeWorker.instances[1]!;
    expect(replacement.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sync', persistSession: true })
    );
  });
});
