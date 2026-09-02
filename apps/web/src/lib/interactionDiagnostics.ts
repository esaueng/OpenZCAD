import { listFeaturesInOrder } from '@openzcad/document-core';
import { toBodyId } from '@openzcad/shared';
import type {
  DerivedState,
  EdgeTopology,
  FaceTopology,
  ProjectDocument,
  Vector3
} from '@openzcad/shared';
import {
  DIRECT_EDIT_FIXTURE_FORMAT,
  DIRECT_EDIT_FIXTURE_FORMAT_VERSION
} from './directEditFixture';
import type {
  DirectEditFixture,
  DirectEditFixtureEdge,
  DirectEditFixtureEdit,
  DirectEditFixtureFace,
  DirectEditFixtureObservation,
  DirectEditFixtureOp,
  DirectEditFixtureOutcome
} from './directEditFixture';
import { createProjectDiagnosticBundle } from './projectDiagnostics';

export const INTERACTION_DIAGNOSTIC_FORMAT =
  'openzcad-interaction-diagnostic' as const;
export const INTERACTION_DIAGNOSTIC_FORMAT_VERSION = 1 as const;
export const INTERACTION_DIAGNOSTICS_MAX_ENTRIES = 40;
export const INTERACTION_DIAGNOSTICS_MAX_BYTES = 8 * 1024 * 1024;

const DATABASE_NAME = 'openzcad-interaction-diagnostics';
const DATABASE_VERSION = 1;
const ENTRY_STORE = 'entries';

/** A topology pick as the gesture saw it, before the fixture resolves it. */
export interface InteractionDiagnosticPick {
  topologyId?: string;
  hash?: number;
  hasReference: boolean;
}

export interface BuildDirectEditFixtureInput {
  /** The document the edit was attempted against (pre-edit). */
  document: ProjectDocument;
  /** Derived state the pick was made on (usually document.derived). */
  derived: DerivedState;
  op: DirectEditFixtureOp;
  targetBodyId: string;
  /** Face pick, when the op targets a face. */
  face?: InteractionDiagnosticPick;
  /** Edge picks, when the op targets edges. */
  edges?: InteractionDiagnosticPick[];
  value: number;
  outcome: DirectEditFixtureOutcome;
  message?: string;
  detail?: string;
  timings?: DirectEditFixtureObservation['timings'];
  kernel: { adapter: 'remus'; packageVersion: string; sourceCommit: string };
  capturedAt?: string;
}

export interface InteractionDiagnosticEntry {
  entryId: number;
  fixture: DirectEditFixture;
  bytes: number;
}

export interface InteractionDiagnosticBundle {
  format: typeof INTERACTION_DIAGNOSTIC_FORMAT;
  formatVersion: typeof INTERACTION_DIAGNOSTIC_FORMAT_VERSION;
  capturedAt: string;
  kernel: { adapter: 'remus'; packageVersion: string; sourceCommit: string };
  summary: {
    total: number;
    byOutcome: Record<DirectEditFixtureOutcome, number>;
    byOp: Record<string, number>;
    byLineage: { semantic: number; 'hash-only': number };
  };
  fixtures: DirectEditFixture[];
}

interface StoredEntry {
  entryId: number;
  fixture: DirectEditFixture;
  bytes: number;
}

const ORIGIN_UNKNOWN: Vector3 = { x: 0, y: 0, z: 0 };

/** `2026-09-01T12:34:56.789Z` -> `20260901123456789`; kebab-safe and unique to the ms. */
function timestampSlug(capturedAt: string): string {
  const digits = capturedAt.replace(/\D/g, '');
  return digits.length > 0 ? digits : String(Date.now());
}

function findFace(
  faces: readonly FaceTopology[],
  pick: InteractionDiagnosticPick
): FaceTopology | undefined {
  // topologyId is the rebuild-local identity the pick was made against; the
  // hash is the weaker fallback precisely because it may have stopped matching.
  const byId =
    pick.topologyId === undefined
      ? undefined
      : faces.find((face) => face.topologyId === pick.topologyId);
  if (byId) {
    return byId;
  }
  return pick.hash === undefined
    ? undefined
    : faces.find((face) => face.hash === pick.hash);
}

function findEdge(
  edges: readonly EdgeTopology[],
  pick: InteractionDiagnosticPick
): EdgeTopology | undefined {
  const byId =
    pick.topologyId === undefined
      ? undefined
      : edges.find((edge) => edge.topologyId === pick.topologyId);
  if (byId) {
    return byId;
  }
  return pick.hash === undefined
    ? undefined
    : edges.find((edge) => edge.hash === pick.hash);
}

/** Mean of a flat xyz triple array; the origin when there is nothing to average. */
function meanPoint(points: readonly number[] | undefined): Vector3 {
  if (!points || points.length < 3) {
    return { ...ORIGIN_UNKNOWN };
  }
  const count = Math.floor(points.length / 3);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index < count; index += 1) {
    x += points[index * 3] ?? 0;
    y += points[index * 3 + 1] ?? 0;
    z += points[index * 3 + 2] ?? 0;
  }
  return { x: x / count, y: y / count, z: z / count };
}

function fixtureFace(
  face: FaceTopology | undefined,
  pick: InteractionDiagnosticPick
): DirectEditFixtureFace {
  const geometry = face?.geometry;
  if (!geometry) {
    // A pick that no longer resolves is the interesting capture, not an error.
    return {
      surfaceType: 'unknown',
      center: { ...ORIGIN_UNKNOWN },
      hash: face?.hash ?? pick.hash,
      hasReference: pick.hasReference
    };
  }
  return {
    surfaceType: geometry.surfaceType,
    center: { ...geometry.center },
    normal: geometry.normal ? { ...geometry.normal } : undefined,
    area: geometry.area,
    hash: face?.hash ?? pick.hash,
    hasReference: pick.hasReference
  };
}

function fixtureEdge(
  edge: EdgeTopology | undefined,
  pick: InteractionDiagnosticPick
): DirectEditFixtureEdge {
  return {
    center: meanPoint(edge?.points),
    length: edge?.length,
    hash: edge?.hash ?? pick.hash,
    hasReference: pick.hasReference
  };
}

function sanitizedDocument(input: BuildDirectEditFixtureInput): {
  document: ProjectDocument | null;
  documentOmitted?: 'imported-source';
} {
  try {
    const bundle = createProjectDiagnosticBundle(input.document, {
      remusVersion: input.kernel.packageVersion,
      remusCommit: input.kernel.sourceCommit
    });
    return { document: bundle.document };
  } catch {
    // The sanitizer refuses imported STEP/mesh documents because their source
    // metadata is not redacted here. Drop the document rather than the capture.
    return { document: null, documentOmitted: 'imported-source' };
  }
}

function upstreamFeatureKinds(document: ProjectDocument): string[] {
  try {
    return listFeaturesInOrder(document).map(
      (feature) => feature.data.featureKind
    );
  } catch {
    return [];
  }
}

/**
 * Pure. Never throws: a diagnostics builder must not break the gesture it
 * observes, so every unresolved pick degrades to a recorded unknown.
 */
export function buildDirectEditFixture(
  input: BuildDirectEditFixtureInput
): DirectEditFixture {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const representation =
    input.derived.bodyRepresentations[toBodyId(input.targetBodyId)];
  const topology = representation?.topology;

  const face = input.face
    ? fixtureFace(findFace(topology?.faces ?? [], input.face), input.face)
    : undefined;
  const edges = input.edges?.map((pick) =>
    fixtureEdge(findEdge(topology?.edges ?? [], pick), pick)
  );

  const semantic =
    face?.hasReference === true ||
    (edges !== undefined &&
      edges.length > 0 &&
      edges.every((edge) => edge.hasReference));

  const edit: DirectEditFixtureEdit = {
    op: input.op,
    targetBodyId: input.targetBodyId,
    face,
    edges,
    value: input.value
  };

  const observed: DirectEditFixtureObservation = {
    outcome: input.outcome,
    message: input.message,
    detail: input.detail,
    lineage: semantic ? 'semantic' : 'hash-only',
    producingFeatureKind: representation?.source,
    upstreamFeatureKinds: upstreamFeatureKinds(input.document),
    documentVersion: input.document.version,
    timings: input.timings
  };

  return {
    format: DIRECT_EDIT_FIXTURE_FORMAT,
    formatVersion: DIRECT_EDIT_FIXTURE_FORMAT_VERSION,
    name: `${input.op}-${input.outcome}-${timestampSlug(capturedAt)}`,
    capturedAt,
    origin: 'captured',
    kernel: { ...input.kernel },
    ...sanitizedDocument(input),
    edit,
    observed
  };
}

function resolveFactory(factory?: IDBFactory): IDBFactory | null {
  if (factory) {
    return factory;
  }
  const ambient: IDBFactory | undefined = globalThis.indexedDB;
  return ambient ?? null;
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Interaction diagnostics failed.'));
  });
}

/** This module owns the schema, so it is the one that creates the store. */
function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ENTRY_STORE)) {
        database.createObjectStore(ENTRY_STORE, {
          keyPath: 'entryId',
          autoIncrement: true
        });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB unavailable.'));
  });
}

function withStore<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  return openDatabase(factory).then(async (database) => {
    const transaction = database.transaction(ENTRY_STORE, mode);
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      const fail = () =>
        reject(
          transaction.error ?? new Error('Interaction diagnostics failed.')
        );
      transaction.onerror = fail;
      transaction.onabort = fail;
    });
    committed.catch(() => undefined);
    try {
      const value = await action(transaction.objectStore(ENTRY_STORE));
      await committed;
      return value;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Already settled; the original error remains the report.
      }
      throw error;
    } finally {
      database.close();
    }
  });
}

/** Walks the store in ascending key order inside the caller's transaction. */
function readEntries(store: IDBObjectStore): Promise<StoredEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: StoredEntry[] = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(entries);
        return;
      }
      entries.push(cursor.value as StoredEntry);
      cursor.continue();
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Interaction diagnostics failed.'));
  });
}

function fixtureBytes(fixture: DirectEditFixture): number {
  return new TextEncoder().encode(JSON.stringify(fixture)).length;
}

/**
 * Drops the lowest entryIds until the log fits both bounds. The last remaining
 * entry is never evicted, so a single fixture larger than the byte cap is kept
 * alone rather than discarded — it just costs every older entry.
 */
async function evictOverflow(store: IDBObjectStore): Promise<void> {
  const entries = await readEntries(store);
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let index = 0;
  while (
    entries.length - index > 1 &&
    (entries.length - index > INTERACTION_DIAGNOSTICS_MAX_ENTRIES ||
      total > INTERACTION_DIAGNOSTICS_MAX_BYTES)
  ) {
    const oldest = entries[index];
    if (!oldest) {
      break;
    }
    await settled(store.delete(oldest.entryId));
    total -= oldest.bytes;
    index += 1;
  }
}

/**
 * Appends one capture, then evicts the oldest entries until the log is within
 * both bounds. Resolves false rather than rejecting: diagnostics storage is
 * never allowed to surface as a failure of the interaction it recorded.
 */
export async function recordInteractionDiagnostic(
  fixture: DirectEditFixture,
  factory?: IDBFactory
): Promise<boolean> {
  const resolved = resolveFactory(factory);
  if (!resolved) {
    return false;
  }
  try {
    const bytes = fixtureBytes(fixture);
    await withStore(resolved, 'readwrite', async (store) => {
      await settled(store.add({ fixture, bytes }));
      await evictOverflow(store);
    });
    return true;
  } catch {
    return false;
  }
}

/** Oldest first; an empty list when storage is unavailable. */
export async function listInteractionDiagnostics(
  factory?: IDBFactory
): Promise<InteractionDiagnosticEntry[]> {
  const resolved = resolveFactory(factory);
  if (!resolved) {
    return [];
  }
  try {
    const entries = await withStore(resolved, 'readonly', (store) =>
      readEntries(store)
    );
    return entries.map((entry) => ({
      entryId: entry.entryId,
      fixture: entry.fixture,
      bytes: entry.bytes
    }));
  } catch {
    return [];
  }
}

export async function clearInteractionDiagnostics(
  factory?: IDBFactory
): Promise<boolean> {
  const resolved = resolveFactory(factory);
  if (!resolved) {
    return false;
  }
  try {
    await withStore(resolved, 'readwrite', (store) => settled(store.clear()));
    return true;
  } catch {
    return false;
  }
}

export function createInteractionDiagnosticBundle(
  entries: InteractionDiagnosticEntry[],
  kernel: { adapter: 'remus'; packageVersion: string; sourceCommit: string },
  capturedAt = new Date().toISOString()
): InteractionDiagnosticBundle {
  const ordered = [...entries].sort((a, b) => a.entryId - b.entryId);
  const byOutcome: Record<DirectEditFixtureOutcome, number> = {
    committed: 0,
    refused: 0,
    'preview-failed': 0,
    'preview-degraded': 0
  };
  const byOp: Record<string, number> = {};
  const byLineage: { semantic: number; 'hash-only': number } = {
    semantic: 0,
    'hash-only': 0
  };
  for (const entry of ordered) {
    byOutcome[entry.fixture.observed.outcome] += 1;
    byOp[entry.fixture.edit.op] = (byOp[entry.fixture.edit.op] ?? 0) + 1;
    byLineage[entry.fixture.observed.lineage] += 1;
  }
  return {
    format: INTERACTION_DIAGNOSTIC_FORMAT,
    formatVersion: INTERACTION_DIAGNOSTIC_FORMAT_VERSION,
    capturedAt,
    kernel: { ...kernel },
    summary: { total: ordered.length, byOutcome, byOp, byLineage },
    fixtures: ordered.map((entry) => entry.fixture)
  };
}
