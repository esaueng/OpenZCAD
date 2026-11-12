import { afterEach, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  isPersistedHistorySession,
  type ExactKernelAdapter,
  type PersistedHistorySession,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import {
  kernelSnapshotSupport,
  projectionMatches,
  projectionSignature
} from '../packages/kernel-adapter/src/exact-session-snapshot';

/**
 * Persisted history sessions: a reopened project restores its whole kernel
 * session instead of replaying its history, and is indistinguishable from a
 * replay. Every way a stored session can be wrong falls back to the replay.
 */

const supported = kernelSnapshotSupport() !== null;
const IDLE = { lineageDemand: [] as BodyId[] };
const user = toUserId('user_kernel_session');

/** A pocketed, filleted plate with a second filleted body: booleans, a
 * transform, a referenced and a hash-only fillet. */
async function filletedPart(): Promise<ProjectDocument> {
  let document = addPrimitiveFeature(
    createProjectDocument('Session snapshot', user),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 24, depth: 10 }
    }
  );
  const plateId = document.bodyOrder[0]!;
  document = addPrimitiveFeature(document, {
    name: 'Pocket tool',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 6, depth: 8 }
  });
  const toolId = document.bodyOrder[1]!;
  document = transformBody(document, {
    name: 'Seat tool',
    targetBodyId: toolId,
    translation: { x: 15, y: 9, z: 6 }
  }).document;
  const pocket = booleanBodies(document, {
    name: 'Pocket',
    operation: 'subtract',
    targetBodyIds: [plateId, toolId]
  });
  document = pocket.document;
  document = addPrimitiveFeature(document, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 6, height: 6, depth: 12 }
  });
  const postId = document.bodyOrder.at(-1)!;
  const probe = await createExactKernelAdapter();
  try {
    const derived = await probe.syncDocument(
      document,
      undefined,
      undefined,
      undefined,
      IDLE
    );
    const plateEdges =
      derived.bodyRepresentations[pocket.bodyId]!.topology!.edges;
    const referenced =
      plateEdges.find((edge) => edge.reference?.kind === 'edge') ??
      plateEdges[0]!;
    document = filletEdges(document, {
      name: 'Round pocket edge',
      targetBodyId: pocket.bodyId,
      edgeHashes: [referenced.hash],
      ...(referenced.reference
        ? { edgeReferences: [referenced.reference] }
        : {}),
      size: 1
    }).document;
    const postEdge = derived.bodyRepresentations[postId]!.topology!.edges[0]!;
    // Hash-only: the selection memory records it for later carries.
    document = filletEdges(document, {
      name: 'Round post edge',
      targetBodyId: postId,
      edgeHashes: [postEdge.hash],
      size: 0.5
    }).document;
  } finally {
    probe.dispose();
  }
  return document;
}

/** Everything a projection says except its timestamp and session revision. */
function comparable(derived: DerivedState) {
  const { updatedAt: _updatedAt, ...rest } = derived;
  return {
    ...rest,
    bodyRepresentations: Object.fromEntries(
      Object.entries(derived.bodyRepresentations).map(([id, body]) => {
        const { projectionRevision: _revision, ...kept } = body;
        return [id, kept];
      })
    )
  };
}

const adapters: ExactKernelAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
});

async function adapter(events?: RebuildCacheEvent[]) {
  const created = await createExactKernelAdapter({
    onRebuildCacheEvent: (event) => events?.push(event)
  });
  adapters.push(created);
  return created;
}

async function freshReplay(document: ProjectDocument): Promise<DerivedState> {
  return (await adapter()).syncDocument(
    document,
    undefined,
    undefined,
    undefined,
    IDLE
  );
}

/** A session as IndexedDB would hand it back: a structured clone. */
async function capturedSession(
  document: ProjectDocument
): Promise<PersistedHistorySession> {
  const source = await adapter();
  await source.syncDocument(document, undefined, undefined, undefined, IDLE);
  const session = await source.captureHistorySession!(document);
  expect(session).not.toBeNull();
  const stored = structuredClone(session!);
  expect(isPersistedHistorySession(stored)).toBe(true);
  return stored;
}

async function reopen(
  document: ProjectDocument,
  persistedSession: PersistedHistorySession
) {
  const events: RebuildCacheEvent[] = [];
  const reopened = await adapter(events);
  const geometryReady: unknown[] = [];
  const derived = await reopened.syncDocument(
    document,
    undefined,
    undefined,
    undefined,
    {
      ...IDLE,
      persistedSession,
      onGeometryReady: (geometry) => geometryReady.push(geometry)
    }
  );
  return { reopened, derived, events, geometryReady };
}

describe('projectionMatches', () => {
  const projection = (volume: number, hash = 11, name = 'Plate') => ({
    bodyRepresentations: {
      body: {
        name: 'Display name',
        volume,
        mesh: { vertices: new Float32Array([volume]) },
        topology: {
          faces: [
            { hash, topologyId: name, triangleStart: volume, triangleCount: 3 }
          ]
        }
      }
    } as unknown as DerivedState['bodyRepresentations'],
    warnings: ['w'],
    featureWarnings: []
  });
  const signature = (...args: Parameters<typeof projection>) =>
    projectionSignature(projection(...args));

  it('accepts last-place measurement noise and ignores presentation', () => {
    expect(
      projectionMatches(
        signature(46453.13371217121),
        signature(46453.13371217123)
      )
    ).toBe(true);
  });

  it('refuses a different measurement, hash, name, warning or shape', () => {
    const stored = signature(46453.13371217121);
    expect(projectionMatches(stored, signature(46453.1338))).toBe(false);
    expect(projectionMatches(stored, signature(46453.13371217121, 12))).toBe(
      false
    );
    expect(
      projectionMatches(stored, signature(46453.13371217121, 11, 'Other'))
    ).toBe(false);
    expect(
      projectionMatches(
        stored,
        projectionSignature({ ...projection(46453.13371217121), warnings: [] })
      )
    ).toBe(false);
    expect(projectionMatches(stored, '{}')).toBe(false);
    expect(projectionMatches(stored, 'not json')).toBe(false);
  });
});

describe.skipIf(!supported)('persisted history sessions', () => {
  it('restores without replay and equals a fresh replay', async () => {
    const document = await filletedPart();
    const session = await capturedSession(document);
    const { reopened, derived, events } = await reopen(document, session);
    const features = listFeaturesInOrder(document).length;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'prefix-restore',
      sessionRestore: 'restored',
      restored: features,
      replayed: 0
    });
    const fresh = await freshReplay(document);
    expect(comparable(derived)).toEqual(comparable(fresh));
    // Names, lineage references and warnings, said explicitly.
    for (const [bodyId, body] of Object.entries(fresh.bodyRepresentations)) {
      const restored = derived.bodyRepresentations[bodyId as BodyId]!;
      expect(restored.topology?.faces.map((face) => face.reference)).toEqual(
        body.topology?.faces.map((face) => face.reference)
      );
      expect(restored.topology?.edges.map((edge) => edge.hash)).toEqual(
        body.topology?.edges.map((edge) => edge.hash)
      );
      expect(restored.volume).toBe(body.volume);
    }
    expect(derived.warnings).toEqual(fresh.warnings);
    expect(derived.featureWarnings).toEqual(fresh.featureWarnings);

    // An appended feature restores the session's checkpoint and replays
    // only itself, and still equals a replay.
    const appended = addPrimitiveFeature(document, {
      name: 'Spacer',
      primitiveKind: 'box',
      dimensions: { width: 3, height: 3, depth: 3 }
    });
    const appendedDerived = await reopened.syncDocument(
      appended,
      undefined,
      undefined,
      undefined,
      IDLE
    );
    expect(events[1]).toMatchObject({
      kind: 'prefix-restore',
      restored: features,
      replayed: 1
    });
    expect(comparable(appendedDerived)).toEqual(
      comparable(await freshReplay(appended))
    );
  });

  it('warms a restored kernel into the ordinary checkpoint table', async () => {
    const document = await filletedPart();
    const session = await capturedSession(document);
    const { reopened, events } = await reopen(document, session);
    expect(reopened.needsHistoryWarmup!(document.projectId)).toBe(true);

    // Cancelled: the restored kernel and its checkpoint stay as they were.
    expect(
      await reopened.warmHistory!(document, {
        ...IDLE,
        cancellation: { isCancelled: () => true }
      })
    ).toBe(false);
    expect(reopened.needsHistoryWarmup!(document.projectId)).toBe(true);
    await reopened.syncDocument(
      document,
      undefined,
      undefined,
      undefined,
      IDLE
    );
    const features = listFeaturesInOrder(document).length;
    expect(events[1]).toMatchObject({
      kind: 'prefix-restore',
      restored: features,
      replayed: 0
    });

    expect(await reopened.warmHistory!(document, IDLE)).toBe(true);
    expect(reopened.needsHistoryWarmup!(document.projectId)).toBe(false);
    // The warm table still holds the published state, so it is captured.
    expect(await reopened.captureHistorySession!(document)).not.toBeNull();

    // Editing the last feature now restores the checkpoint before it.
    const last = listFeaturesInOrder(document).at(-1)!;
    const edited = updateFeature(document, {
      featureId: last.featureId,
      data: { radius: 0.75 }
    });
    const editedDerived = await reopened.syncDocument(
      edited,
      undefined,
      undefined,
      undefined,
      IDLE
    );
    expect(events.at(-1)).toMatchObject({
      kind: 'prefix-restore',
      restored: features - 1,
      replayed: 1
    });
    expect(comparable(editedDerived)).toEqual(
      comparable(await freshReplay(edited))
    );
  });

  it('captures nothing but the complete state the last sync published', async () => {
    const document = await filletedPart();
    const source = await adapter();
    await source.syncDocument(document, undefined, undefined, undefined, IDLE);
    const last = listFeaturesInOrder(document).at(-1)!;
    const other = updateFeature(document, {
      featureId: last.featureId,
      data: { radius: 0.6 }
    });
    // Another document than the kernel's current state.
    expect(await source.captureHistorySession!(other)).toBeNull();
    // A drag preview moves the kernel away from the published state.
    await source.previewGeometry(other);
    expect(await source.captureHistorySession!(other)).toBeNull();
    expect(await source.captureHistorySession!(document)).toBeNull();
    // An edit's proposal is never persisted.
    await source.syncDocument(other, undefined, undefined, undefined, {
      ...IDLE,
      proposeCarry: true
    });
    expect(await source.captureHistorySession!(other)).toBeNull();
    await source.syncDocument(other, undefined, undefined, undefined, IDLE);
    expect(await source.captureHistorySession!(other)).not.toBeNull();
  });

  it.each([
    [
      'another document revision',
      (session: PersistedHistorySession) => session,
      true
    ],
    [
      'another kernel build',
      (session: PersistedHistorySession) => ({
        ...session,
        kernelBuildId: `${session.kernelBuildId}+other`
      }),
      false
    ],
    [
      'damaged kernel bytes',
      (session: PersistedHistorySession) => {
        const kernelBytes = session.kernelBytes.slice();
        kernelBytes[kernelBytes.length >> 1]! ^= 0x5a;
        return { ...session, kernelBytes };
      },
      false
    ],
    [
      'truncated kernel bytes',
      (session: PersistedHistorySession) => ({
        ...session,
        kernelBytes: session.kernelBytes.slice(0, 64)
      }),
      false
    ],
    [
      'another scope',
      (session: PersistedHistorySession) => ({
        ...session,
        scopeKey: `${session.scopeKey} `
      }),
      false
    ]
  ])('replays for %s', async (_case, damage, editDocument) => {
    let document = await filletedPart();
    const session = damage(await capturedSession(document));
    if (editDocument) {
      const last = listFeaturesInOrder(document).at(-1)!;
      document = updateFeature(document, {
        featureId: last.featureId,
        data: { radius: 0.6 }
      });
    }
    const { derived, events, geometryReady } = await reopen(document, session);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('full-rebuild');
    expect(events[0]!.sessionRestore).toBeUndefined();
    expect(geometryReady.length).toBe(1);
    expect(comparable(derived)).toEqual(
      comparable(await freshReplay(document))
    );
  });

  it.each([
    [
      'a projection it was not captured with',
      (session: PersistedHistorySession) => ({
        ...session,
        // One face or edge hash off by one.
        projectionSignature: session.projectionSignature.replace(
          /"hash":(\d+)/,
          (_match, hash: string) => `"hash":${Number(hash) + 1}`
        )
      })
    ],
    [
      'a build state that disagrees with its kernel',
      (session: PersistedHistorySession) => {
        const shapes = new Map(session.build.shapes);
        const [first] = shapes.keys();
        shapes.delete(first!);
        return { ...session, build: { ...session.build, shapes } };
      }
    ]
  ])('rejects %s before publishing and replays', async (_case, damage) => {
    const document = await filletedPart();
    const session = damage(await capturedSession(document));
    const { derived, events, geometryReady } = await reopen(document, session);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'full-rebuild',
      sessionRestore: 'rejected',
      restored: 0
    });
    // Only the replay's geometry was ever published.
    expect(geometryReady.length).toBe(1);
    expect(comparable(derived)).toEqual(
      comparable(await freshReplay(document))
    );
  });

  it('drops a restore cancelled before its projection was matched', async () => {
    const document = await filletedPart();
    const session = await capturedSession(document);
    const events: RebuildCacheEvent[] = [];
    const reopened = await adapter(events);
    let cancelled = false;
    await expect(
      reopened.syncDocument(document, undefined, undefined, undefined, {
        ...IDLE,
        persistedSession: session,
        // Superseded once the restored build has started measuring.
        cancellation: { isCancelled: () => cancelled },
        yieldControl: () => {
          cancelled = true;
        }
      })
    ).rejects.toMatchObject({ category: 'cancelled' });
    expect(reopened.hasHistoryFor!(document.projectId)).toBe(false);
    // The next sync replays; it never builds on the unmatched kernel.
    const derived = await reopened.syncDocument(
      document,
      undefined,
      undefined,
      undefined,
      IDLE
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('full-rebuild');
    expect(comparable(derived)).toEqual(
      comparable(await freshReplay(document))
    );
  });

  it('ignores a session for another project', async () => {
    const document = await filletedPart();
    const session = await capturedSession(document);
    const { events } = await reopen(document, {
      ...session,
      projectId: `${session.projectId}-other`
    });
    expect(events[0]!.kind).toBe('full-rebuild');
    expect(events[0]!.sessionRestore).toBeUndefined();
  });
});
