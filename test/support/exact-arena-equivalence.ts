import { vi } from 'vitest';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
import type { ExactBuildResult } from '../../packages/kernel-adapter/src/exact-types';
import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';

interface SerializedBody {
  readonly consumed: boolean;
  readonly solids: number;
  readonly bytes: Uint8Array;
}

interface HistoryBuild {
  kernel: RemusKernel;
  build: ExactBuildResult;
}

/**
 * Capture the actual operands built by a sync, before measurement probes run.
 * An export would build again, so use the same test-only private-method seam
 * as the cache safety suites. No handles or model identifiers leave this helper.
 */
export async function captureExactArenas<T>(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  sync: () => Promise<T>
): Promise<{ result: T; bodies: readonly SerializedBody[] }> {
  const history = adapter as unknown as {
    buildWithHistoryCache: (...args: unknown[]) => Promise<HistoryBuild>;
  };
  const original = history.buildWithHistoryCache;
  let bodies: SerializedBody[] | undefined;
  const spy = vi
    .spyOn(history, 'buildWithHistoryCache')
    .mockImplementation(async (...args) => {
      const built = await original.apply(adapter, args);
      bodies = document.bodyOrder.map((id) => {
        const solids = built.build.shapes.get(id)?.solids ?? [];
        return {
          consumed: built.build.consumed.has(id),
          solids: solids.length,
          bytes:
            solids.length === 0
              ? new Uint8Array()
              : built.kernel.serializeSolids(Uint32Array.from(solids)).slice()
        };
      });
      return built;
    });
  try {
    const result = await sync();
    if (!bodies) throw new Error('No exact history build was observed.');
    return { result, bodies };
  } finally {
    spy.mockRestore();
  }
}

/** Compare every raw byte; diagnostics contain counts and booleans only. */
export function compareExactArenas(
  actual: readonly SerializedBody[],
  expected: readonly SerializedBody[]
) {
  const bodies = Array.from(
    { length: Math.max(actual.length, expected.length) },
    (_, bodyIndex) => {
      const a = actual[bodyIndex],
        b = expected[bodyIndex];
      const equivalent = Boolean(
        a &&
        b &&
        a.consumed === b.consumed &&
        a.solids === b.solids &&
        a.bytes.byteLength === b.bytes.byteLength &&
        a.bytes.every((value, index) => value === b.bytes[index])
      );
      return {
        bodyIndex,
        equivalent,
        actualSolids: a?.solids ?? 0,
        expectedSolids: b?.solids ?? 0,
        actualBytes: a?.bytes.byteLength ?? 0,
        expectedBytes: b?.bytes.byteLength ?? 0
      };
    }
  );
  return {
    equivalent:
      actual.length === expected.length && bodies.every((b) => b.equivalent),
    actualBodies: actual.length,
    expectedBodies: expected.length,
    bodies
  };
}
