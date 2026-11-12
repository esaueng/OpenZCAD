import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  updateFeature,
  listFeaturesInOrder
} from '@openzcad/document-core';
import type { PersistedHistorySession } from '@openzcad/kernel-adapter/exact';
import { toBodyId, toUserId, type ProjectDocument } from '@openzcad/shared';
import type { GeometryWorkerRequest } from './geometryWorker';
import {
  KERNEL_SESSION_IDLE_MS,
  KERNEL_SESSION_WARMUP_IDLE_MS
} from './kernelSessionPersistence';

/**
 * The geometry worker's persisted-session wiring: which syncs may offer a
 * stored kernel session and capture one (only the user's own local project,
 * marked `persistSession` by the app), and what drops a scheduled capture or
 * warm-up. The adapter and the store are fakes; the adapter's own matching
 * is covered by `test/kernel-session-snapshot.test.ts`.
 */

const SESSION = { stored: true } as unknown as PersistedHistorySession;

const store = vi.hoisted(() => ({
  load: vi.fn(async (): Promise<unknown> => null),
  save: vi.fn(async () => true),
  reject: vi.fn(async () => undefined),
  touch: vi.fn(async () => undefined)
}));
vi.mock('../lib/kernelSessionStore', () => ({
  kernelSessionIdentity: () => 'identity',
  loadKernelSession: store.load,
  saveKernelSession: store.save,
  rejectKernelSession: store.reject,
  touchKernelSession: store.touch
}));

/** A one-body result, drawn with a draft display mesh or at full quality. */
function derived(draft = false): ProjectDocument['derived'] {
  const bodyId = toBodyId('body_released');
  return {
    bodyRepresentations: {
      [bodyId]: {
        bodyId,
        name: 'Released',
        source: 'direct-edit' as const,
        mesh: {
          kind: 'mesh' as const,
          vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2])
        },
        faceCount: 1,
        color: '#ffffff',
        exportableStep: true,
        consumed: false,
        volume: 1,
        bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
        ...(draft ? { displayQuality: 'draft' as const } : {})
      }
    },
    exportableBodyIds: [],
    warnings: [],
    updatedAt: '2026-11-12T00:00:00.000Z'
  };
}

interface FakeWorkerScope {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent<GeometryWorkerRequest>) => void) | null;
}

async function installWorker(
  syncDocument: (
    ...args: unknown[]
  ) => Promise<ProjectDocument['derived']> = async () => derived()
) {
  const scope: FakeWorkerScope = { postMessage: vi.fn(), onmessage: null };
  const adapter = {
    syncDocument: vi.fn(syncDocument),
    currentMassPropertiesEpoch: vi.fn(() => 1),
    hasTransientFailures: vi.fn(() => false),
    prepareMassPropertiesForDocument: vi.fn(async () => 2),
    readCurrentMassProperties: vi.fn(() => ({
      status: 'unavailable',
      reason: 'No live solid is available.',
      epoch: 1
    })),
    hasHistoryFor: vi.fn(() => false),
    captureHistorySession: vi.fn(async () => SESSION),
    needsHistoryWarmup: vi.fn(() => true),
    warmHistory: vi.fn(async () => true),
    dispose: vi.fn()
  };
  vi.stubGlobal('self', scope);
  vi.doMock('@openzcad/kernel-adapter/exact', () => ({
    createExactKernelAdapter: vi.fn(async () => adapter),
    estimateStructuredBytes: () => 10,
    isPersistedHistorySession: (value: unknown) => value === SESSION,
    kernelSnapshotBuildId: () => 'kernel-build'
  }));
  await import('./geometryWorker');
  return { scope, adapter };
}

function post(scope: FakeWorkerScope, request: GeometryWorkerRequest): void {
  scope.onmessage?.({ data: request } as MessageEvent<GeometryWorkerRequest>);
}

function published(scope: FakeWorkerScope, version: number): boolean {
  return scope.postMessage.mock.calls.some(
    ([message]) =>
      (message as { type?: string; version?: number }).type ===
        'projection-delta' &&
      (message as { version?: number }).version === version
  );
}

/** Past every idle wait: the capture's and the warm-up's. */
const settle = () =>
  new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(KERNEL_SESSION_IDLE_MS, KERNEL_SESSION_WARMUP_IDLE_MS) + 400
    )
  );

const owner = toUserId('user_owner');
let document: ProjectDocument;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // Sessions are off in dev servers; the worker under test is a build.
  vi.stubEnv('DEV', false);
  store.load.mockResolvedValue(null);
  document = addPrimitiveFeature(createProjectDocument('Bracket', owner), {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 24, depth: 10 }
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('geometry worker persisted sessions', { timeout: 15_000 }, () => {
  it('offers and captures the own local project', async () => {
    // Stored for the reopened content only.
    store.load.mockResolvedValueOnce(SESSION);
    const { scope, adapter } = await installWorker();
    post(scope, {
      type: 'sync',
      document,
      lineageDemand: [],
      persistSession: true
    });
    await vi.waitFor(() =>
      expect(published(scope, document.version)).toBe(true)
    );
    expect(store.load).toHaveBeenCalledWith(
      document.projectId,
      expect.any(String),
      'identity'
    );
    expect(adapter.syncDocument.mock.calls[0]?.[4]).toEqual(
      expect.objectContaining({ persistedSession: SESSION })
    );
    await settle();
    // Offered content is known stored: the capture is not written again.
    expect(store.save).not.toHaveBeenCalled();
    // Another revision is captured once idle.
    adapter.hasHistoryFor.mockReturnValue(true);
    const edited = updateFeature(document, {
      featureId: listFeaturesInOrder(document)[0]!.featureId,
      data: { dimensions: { width: 41, height: 24, depth: 10 } }
    });
    post(scope, {
      type: 'sync',
      document: edited,
      lineageDemand: [],
      persistSession: true
    });
    await vi.waitFor(() => expect(published(scope, edited.version)).toBe(true));
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledOnce(), {
      timeout: KERNEL_SESSION_IDLE_MS + 2_000
    });
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: document.projectId,
        identity: 'identity',
        session: SESSION
      })
    );
  });

  it.each([
    ['a shared link’s model', {}],
    ['someone else’s project', { persistSession: false }]
  ])(
    'never offers, captures or warms %s',
    async (_case, flag: { persistSession?: boolean }) => {
      store.load.mockResolvedValue(SESSION);
      const { scope, adapter } = await installWorker();
      post(scope, { type: 'sync', document, lineageDemand: [], ...flag });
      await vi.waitFor(() =>
        expect(published(scope, document.version)).toBe(true)
      );
      await settle();
      expect(store.load).not.toHaveBeenCalled();
      expect(adapter.syncDocument.mock.calls[0]?.[4]).not.toHaveProperty(
        'persistedSession'
      );
      expect(adapter.captureHistorySession).not.toHaveBeenCalled();
      expect(adapter.warmHistory).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
    }
  );

  it('never offers to a one-off rebuild', async () => {
    store.load.mockResolvedValue(SESSION);
    const { scope, adapter } = await installWorker();
    post(scope, {
      type: 'sync',
      document,
      requestId: 'one-off',
      persistSession: true
    });
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state',
          phase: 'ready',
          requestId: 'one-off'
        })
      )
    );
    await settle();
    expect(store.load).not.toHaveBeenCalled();
    expect(adapter.captureHistorySession).not.toHaveBeenCalled();
  });

  it('drops the own project’s pending capture when a shared link opens', async () => {
    const { scope, adapter } = await installWorker();
    post(scope, {
      type: 'sync',
      document,
      lineageDemand: [],
      persistSession: true
    });
    await vi.waitFor(() =>
      expect(published(scope, document.version)).toBe(true)
    );
    const shared = addPrimitiveFeature(
      createProjectDocument('Shared', toUserId('user_other')),
      {
        name: 'Post',
        primitiveKind: 'box',
        dimensions: { width: 6, height: 6, depth: 12 }
      }
    );
    post(scope, { type: 'sync', document: shared, lineageDemand: [] });
    await vi.waitFor(() => expect(published(scope, shared.version)).toBe(true));
    await settle();
    expect(adapter.captureHistorySession).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('drops the pending capture and warm-up when the project closes', async () => {
    const { scope, adapter } = await installWorker();
    post(scope, {
      type: 'sync',
      document,
      lineageDemand: [],
      persistSession: true
    });
    await vi.waitFor(() =>
      expect(published(scope, document.version)).toBe(true)
    );
    post(scope, { type: 'cancel' });
    await settle();
    expect(adapter.captureHistorySession).not.toHaveBeenCalled();
    expect(adapter.warmHistory).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('applies a policy-only change to the live project without a rebuild', async () => {
    const { scope, adapter } = await installWorker();
    // Not known to be the user's own yet (the owner resolves later).
    post(scope, { type: 'sync', document, lineageDemand: [] });
    await vi.waitFor(() =>
      expect(published(scope, document.version)).toBe(true)
    );
    post(scope, {
      type: 'session-policy',
      projectId: document.projectId,
      persistSession: true
    });
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledOnce(), {
      timeout: KERNEL_SESSION_IDLE_MS + 2_000
    });
    // Told, not rebuilt.
    expect(adapter.syncDocument).toHaveBeenCalledOnce();
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: document.projectId })
    );
  });

  it('a policy turned off drops the scheduled capture and warm-up', async () => {
    const { scope, adapter } = await installWorker();
    post(scope, {
      type: 'sync',
      document,
      lineageDemand: [],
      persistSession: true
    });
    await vi.waitFor(() =>
      expect(published(scope, document.version)).toBe(true)
    );
    post(scope, {
      type: 'session-policy',
      projectId: document.projectId,
      persistSession: false
    });
    await settle();
    expect(adapter.syncDocument).toHaveBeenCalledOnce();
    expect(adapter.captureHistorySession).not.toHaveBeenCalled();
    expect(adapter.warmHistory).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('a policy turned off fences a capture already running', async () => {
    let finishCapture: (value: PersistedHistorySession) => void = () => {};
    const { scope, adapter } = await installWorker();
    adapter.captureHistorySession.mockImplementation(
      () =>
        new Promise<PersistedHistorySession>((resolve) => {
          finishCapture = resolve;
        })
    );
    post(scope, {
      type: 'sync',
      document,
      lineageDemand: [],
      persistSession: true
    });
    await vi.waitFor(
      () => expect(adapter.captureHistorySession).toHaveBeenCalled(),
      {
        timeout: KERNEL_SESSION_IDLE_MS + 2_000
      }
    );
    post(scope, {
      type: 'session-policy',
      projectId: document.projectId,
      persistSession: false
    });
    finishCapture(SESSION);
    await settle();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('never offers a stored session once the policy is off', async () => {
    store.load.mockResolvedValue(SESSION);
    const { scope } = await installWorker();
    // The policy flips before the queued broadcast starts.
    post(scope, {
      type: 'sync',
      document,
      lineageDemand: [],
      persistSession: true
    });
    post(scope, {
      type: 'session-policy',
      projectId: document.projectId,
      persistSession: false
    });
    await vi.waitFor(() =>
      expect(published(scope, document.version)).toBe(true)
    );
    expect(store.load).not.toHaveBeenCalled();
  });

  it('warms the refined release, never the reopen-time document', async () => {
    let draftNext = false;
    const { scope, adapter } = await installWorker(async (...args) => {
      const options = args[4] as { displayRefinement?: boolean } | undefined;
      return derived(draftNext && !options?.displayRefinement);
    });
    post(scope, {
      type: 'sync',
      document,
      lineageDemand: [],
      persistSession: true
    });
    await vi.waitFor(() =>
      expect(published(scope, document.version)).toBe(true)
    );
    // A released face offset publishes a draft display first (#1364).
    draftNext = true;
    const released = updateFeature(document, {
      featureId: listFeaturesInOrder(document)[0]!.featureId,
      data: { dimensions: { width: 44, height: 24, depth: 10 } }
    });
    post(scope, {
      type: 'sync',
      document: released,
      lineageDemand: [],
      persistSession: true
    });
    await vi.waitFor(() =>
      expect(published(scope, released.version)).toBe(true)
    );
    await vi.waitFor(() => expect(adapter.warmHistory).toHaveBeenCalled(), {
      timeout: KERNEL_SESSION_WARMUP_IDLE_MS + 2_000
    });
    // The refinement scheduled a capture of the release as well.
    await vi.waitFor(() => expect(store.save).toHaveBeenCalled(), {
      timeout: KERNEL_SESSION_IDLE_MS + 2_000
    });
    for (const [warmed] of adapter.warmHistory.mock.calls as unknown as [
      ProjectDocument
    ][])
      expect(warmed.version).toBe(released.version);
  });
});
