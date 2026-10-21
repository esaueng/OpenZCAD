/** Opt-in browser qualification only. Normal and matched timing builds omit this. */
export * from '../../packages/kernel-adapter/src/exact';
import {
  createExactKernelAdapter as create,
  type ExactKernelAdapter,
  type RebuildCacheEvent,
  type ExactKernelAdapterOptions
} from '../../packages/kernel-adapter/src/exact';
import type { ExactBuildResult } from '../../packages/kernel-adapter/src/exact-types';
import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import type { BodyId, DerivedState, ProjectDocument } from '@openzcad/shared';

interface ArenaState {
  historyKernel: RemusKernel | null;
  historyCheckpoints: { checkpointId: number }[];
  historyCheckpointOwners: Map<number, unknown>;
  measuredShapeCache: Map<string, { bytes: number }>;
  measuredShapeCacheBytes: number;
  buildWithHistoryCache: (...args: unknown[]) => Promise<{
    kernel: RemusKernel;
    build: ExactBuildResult;
  }>;
}

type SyncArgs = Parameters<ExactKernelAdapter['syncDocument']>;
type CapturedBody = { consumed: boolean; solids: number; bytes: Uint8Array };

// Match the existing private oracle's cross-arena publication boundary exactly.
// Raw B-rep bytes below are compared separately with no normalization.
function publication({ updatedAt: _time, ...derived }: DerivedState) {
  const result = structuredClone(derived);
  for (const body of Object.values(result.bodyRepresentations)) {
    const opening = body.topology?.recognizedOpening;
    if (opening?.status === 'recognized') {
      for (const key of ['faceA', 'faceB'] as const) {
        const value = opening.evidence.candidate[key];
        if (!Number.isSafeInteger(value) || value < 0)
          throw new Error('Invalid arena-local diagnostic index.');
        opening.evidence.candidate[key] = 0;
      }
    }
  }
  return {
    ...result,
    bodyRepresentations: Object.fromEntries(
      Object.entries(result.bodyRepresentations).map(([id, body]) => [
        id,
        {
          ...body,
          mesh: {
            kind: body.mesh.kind,
            triangles: body.mesh.indices.length / 3
          }
        }
      ])
    )
  };
}

export function sameStructure(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (
    !actual ||
    !expected ||
    typeof actual !== 'object' ||
    typeof expected !== 'object'
  )
    return false;
  if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected))
    return false;
  if (actual instanceof ArrayBuffer && expected instanceof ArrayBuffer)
    return (
      actual.byteLength === expected.byteLength &&
      new Uint8Array(actual).every(
        (byte, index) => byte === new Uint8Array(expected)[index]
      )
    );
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected))
    return (
      actual.byteLength === expected.byteLength &&
      new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength).every(
        (byte, index) =>
          byte ===
          new Uint8Array(
            expected.buffer,
            expected.byteOffset,
            expected.byteLength
          )[index]
      )
    );
  if (
    !Array.isArray(actual) &&
    Object.getPrototypeOf(actual) !== Object.prototype &&
    Object.getPrototypeOf(actual) !== null
  )
    throw new Error('Unsupported publication value; comparison fails closed.');
  if (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length !== expected.length
  )
    return false;
  const a = Reflect.ownKeys(actual),
    b = Reflect.ownKeys(expected);
  return (
    a.length === b.length &&
    a.every(
      (key) =>
        b.includes(key) &&
        sameStructure(
          (actual as Record<PropertyKey, unknown>)[key],
          (expected as Record<PropertyKey, unknown>)[key]
        )
    )
  );
}

function differingPaths(
  actual: unknown,
  expected: unknown,
  path = ''
): string[] {
  if (sameStructure(actual, expected)) return [];
  if (
    actual &&
    expected &&
    typeof actual === 'object' &&
    typeof expected === 'object'
  ) {
    const a = actual as Record<string, unknown>,
      b = expected as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      differingPaths(a[key], b[key], `${path}.${key}`)
    );
  }
  return [path];
}

function publicationDifferences(
  actual: DerivedState,
  expected: DerivedState,
  document: ProjectDocument
) {
  const { bodyRepresentations: actualBodies, ...actualRoot } =
    publication(actual);
  const { bodyRepresentations: expectedBodies, ...expectedRoot } =
    publication(expected);
  return {
    root: differingPaths(actualRoot, expectedRoot).slice(0, 100),
    bodies: document.bodyOrder
      .map((id, bodyIndex) => {
        const paths = differingPaths(actualBodies[id], expectedBodies[id]);
        return { bodyIndex, count: paths.length, paths: paths.slice(0, 100) };
      })
      .filter((body) => body.count > 0)
  };
}

async function capture(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  args: SyncArgs
) {
  const state = adapter as unknown as ArenaState;
  const original = state.buildWithHistoryCache;
  let bodies: CapturedBody[] | undefined;
  state.buildWithHistoryCache = async (...buildArgs) => {
    const built = await original.apply(adapter, buildArgs);
    bodies = document.bodyOrder.map((id) => {
      const solids = built.build.shapes.get(id)?.solids ?? [];
      return {
        consumed: built.build.consumed.has(id),
        solids: solids.length,
        bytes: solids.length
          ? built.kernel.serializeSolids(Uint32Array.from(solids)).slice()
          : new Uint8Array()
      };
    });
    return built;
  };
  try {
    const result = await adapter.syncDocument(...args);
    if (!bodies) throw new Error('No exact build captured.');
    return { result, bodies };
  } finally {
    state.buildWithHistoryCache = original;
  }
}

export async function createExactKernelAdapter(
  options: ExactKernelAdapterOptions = {}
) {
  const adapter = await create({
    ...options,
    measurementCacheDiagnostics: true
  });
  const state = adapter as unknown as ArenaState;
  const original = adapter.syncDocument.bind(adapter);
  let lastDocument: ProjectDocument | undefined;
  let lastAnalysis: SyncArgs[3];
  let lastDemand: readonly BodyId[] | undefined;
  let previousKernel: WeakRef<RemusKernel> | undefined;
  let previousIds: number[] = [];
  let retiredIds: number[] = [];
  let retiredCount = 0;
  let arenas = 0;
  let syncs = 0;
  adapter.syncDocument = async (...args) => {
    const result = await original(...args);
    lastDocument = args[0];
    lastAnalysis = args[3];
    const demand = args[4]?.lineageDemand;
    lastDemand = demand === undefined ? undefined : [...demand];
    const kernel = state.historyKernel;
    const ids = state.historyCheckpoints.map((entry) => entry.checkpointId);
    if (kernel && previousKernel?.deref() === kernel) {
      const retired = previousIds.filter((id) => !ids.includes(id));
      retiredCount += retired.length;
      retiredIds = [...retiredIds, ...retired].slice(-32);
    } else {
      arenas++;
      retiredIds = [];
    }
    previousKernel = kernel ? new WeakRef(kernel) : undefined;
    previousIds = ids;
    syncs++;
    return result;
  };
  const snapshot = () => ({
    syncs,
    arenas,
    retiredCheckpoints: retiredCount,
    checkpoints: state.historyCheckpoints.length,
    ownerCount: state.historyCheckpointOwners.size,
    ownersAgree: state.historyCheckpoints.every(
      (entry) => state.historyCheckpointOwners.get(entry.checkpointId) === entry
    ),
    measuredEntries: state.measuredShapeCache.size,
    memo:
      (globalThis as unknown as { __h02Memo?: () => unknown }).__h02Memo?.() ??
      null,
    accountedMeasurementBytes: state.measuredShapeCacheBytes,
    summedMeasurementBytes: [...state.measuredShapeCache.values()].reduce(
      (sum, entry) => sum + entry.bytes,
      0
    )
  });
  const probe = {
    snapshot,
    async compareFresh() {
      const document = lastDocument;
      if (!document) throw new Error('No live private document available.');
      const args: SyncArgs = [
        document,
        undefined,
        undefined,
        lastAnalysis,
        { lineageDemand: lastDemand }
      ];
      const fresh = await create({
        ...options,
        onRebuildCacheEvent: undefined,
        historyCheckpointLimit: 0,
        importedStepCacheBytes: 0,
        measuredShapeCacheBytes: 0
      });
      try {
        const actual = await capture(adapter, document, args);
        const expected = await capture(fresh, document, args);
        const rawEquivalent =
          actual.bodies.length === expected.bodies.length &&
          actual.bodies.every((body, index) => {
            const other = expected.bodies[index];
            return (
              other &&
              body.solids > 0 &&
              other.solids === body.solids &&
              other.consumed === body.consumed &&
              body.bytes.length === other.bytes.length &&
              body.bytes.every((byte, offset) => byte === other.bytes[offset])
            );
          });
        return {
          rawEquivalent,
          publicationEquivalent: sameStructure(
            publication(actual.result),
            publication(expected.result)
          ),
          publicationDifferences: publicationDifferences(
            actual.result,
            expected.result,
            document
          ),
          bodies: actual.bodies.length,
          serializedBytes: actual.bodies.reduce(
            (sum, body) => sum + body.bytes.length,
            0
          ),
          faces: Object.values(actual.result.bodyRepresentations).reduce(
            (sum, body) => sum + body.faceCount,
            0
          ),
          warnings: actual.result.warnings.length,
          ...snapshot()
        };
      } finally {
        fresh.dispose();
        lastDocument = undefined;
      }
    },
    async exerciseEviction() {
      const document = lastDocument;
      if (!document) throw new Error('No live private document available.');
      const sizes = [...state.measuredShapeCache.values()].map(
        (entry) => entry.bytes
      );
      const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
      const budget = total - Math.ceil(Math.min(...sizes) / 2);
      if (sizes.length < 2 || budget <= Math.max(...sizes))
        throw new Error('Private entries cannot calibrate live eviction.');
      const events: RebuildCacheEvent[] = [];
      const pressure = await create({
        ...options,
        measuredShapeCacheBytes: budget,
        measurementCacheDiagnostics: true,
        onRebuildCacheEvent: (event) => events.push(event)
      });
      const fresh = await create({
        ...options,
        onRebuildCacheEvent: undefined,
        historyCheckpointLimit: 0,
        importedStepCacheBytes: 0,
        measuredShapeCacheBytes: 0
      });
      try {
        await pressure.syncDocument(
          document,
          undefined,
          undefined,
          lastAnalysis,
          { lineageDemand: lastDemand }
        );
        const retained = pressure as unknown as ArenaState;
        const passes = [];
        for (let pass = 0; pass < 4; pass++) {
          const retainedIds = [...retained.measuredShapeCache.keys()];
          const evictedIds = document.bodyOrder.filter(
            (id) => !retained.measuredShapeCache.has(id)
          );
          if (!evictedIds.length)
            throw new Error('No live private measurement was evicted.');
          const reordered = {
            ...document,
            bodyOrder: [
              ...retainedIds,
              ...evictedIds
            ] as typeof document.bodyOrder
          };
          const args: SyncArgs = [
            reordered,
            undefined,
            undefined,
            lastAnalysis,
            { lineageDemand: lastDemand }
          ];
          const actual = await capture(pressure, reordered, args);
          const expected = await capture(fresh, reordered, args);
          const rawEquivalent =
            actual.bodies.length === expected.bodies.length &&
            actual.bodies.every((body, index) => {
              const other = expected.bodies[index];
              return (
                other &&
                body.solids > 0 &&
                other.solids === body.solids &&
                other.consumed === body.consumed &&
                body.bytes.length === other.bytes.length &&
                body.bytes.every((byte, offset) => byte === other.bytes[offset])
              );
            });
          const event = events.at(-1)!;
          passes.push({
            evictedBodies: evictedIds.length,
            rawEquivalent,
            publicationEquivalent: sameStructure(
              publication(actual.result),
              publication(expected.result)
            ),
            publicationDifferences: publicationDifferences(
              actual.result,
              expected.result,
              reordered
            ),
            retainedBytes: retained.measuredShapeCacheBytes,
            summedBytes: [...retained.measuredShapeCache.values()].reduce(
              (sum, entry) => sum + entry.bytes,
              0
            ),
            event
          });
        }
        return { budget, productionBudgetUnchanged: true, passes };
      } finally {
        pressure.dispose();
        fresh.dispose();
      }
    },
    probeRetiredCheckpoint() {
      const id = retiredIds.at(-1);
      const kernel = state.historyKernel;
      if (id === undefined || !kernel)
        return { available: false, rejected: false };
      let rejected = false;
      try {
        kernel.restore(id);
      } catch {
        rejected = true;
      }
      return { available: true, rejected };
    }
  };
  // Retired kernels are weak. Oracle snapshots and the latest document are
  // released before each post-GC memory observation.
  (globalThis as unknown as { __h02Session: typeof probe }).__h02Session =
    probe;
  return adapter;
}
