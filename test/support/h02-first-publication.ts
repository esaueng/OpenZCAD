import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type ExactKernelAdapterOptions
} from '@openzcad/kernel-adapter/exact';
import type { DerivedState, ProjectDocument } from '@openzcad/shared';
import { sameStructure } from '../perf/h02-session-exact';
import {
  captureExactArenas,
  compareExactArenas
} from './exact-arena-equivalence';

type SyncArgs = Parameters<ExactKernelAdapter['syncDocument']>;
type CapturedFirst = {
  result: DerivedState;
  bodies: Parameters<typeof compareExactArenas>[0];
};

/** Own every first-result value before any subsequent subject sync can run. */
export async function captureFirstPublication(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  sync: () => Promise<DerivedState>
): Promise<CapturedFirst> {
  const first = await captureExactArenas(adapter, document, sync);
  return {
    result: structuredClone(first.result),
    bodies: first.bodies.map((body) => ({ ...body, bytes: body.bytes.slice() }))
  };
}

/** Exact copy of the existing H02 cross-arena publication boundary. */
export function h02Publication({ updatedAt: _time, ...derived }: DerivedState) {
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

/**
 * Compare the already captured FIRST result directly with a different production
 * adapter. This helper never receives the subject adapter and cannot resync it.
 * The fresh build disables the same three caches as the unchanged H02 oracle.
 */
export async function compareCapturedFirstWithFresh(
  first: CapturedFirst,
  document: ProjectDocument,
  options: {
    adapterOptions?: ExactKernelAdapterOptions;
    analysis?: SyncArgs[3];
    syncOptions?: SyncArgs[4];
  } = {}
) {
  // Own the publication snapshot before creating or executing the fresh kernel.
  const actual = h02Publication(first.result);
  const fresh = await createExactKernelAdapter({
    ...options.adapterOptions,
    onRebuildCacheEvent: undefined,
    historyCheckpointLimit: 0,
    importedStepCacheBytes: 0,
    measuredShapeCacheBytes: 0
  });
  try {
    const expected = await captureExactArenas(fresh, document, () =>
      fresh.syncDocument(
        document,
        undefined,
        undefined,
        options.analysis,
        options.syncOptions
      )
    );
    const normalizedExpected = h02Publication(expected.result);
    const { bodyRepresentations: actualBodies, ...actualRoot } = actual;
    const { bodyRepresentations: expectedBodies, ...expectedRoot } =
      normalizedExpected;
    return {
      rawEquivalent:
        compareExactArenas(first.bodies, expected.bodies).equivalent &&
        first.bodies.every((body) => body.solids > 0),
      publicationEquivalent: sameStructure(actual, normalizedExpected),
      publicationDifferences: {
        root: differingPaths(actualRoot, expectedRoot).slice(0, 100),
        bodies: document.bodyOrder
          .map((id, bodyIndex) => {
            const paths = differingPaths(actualBodies[id], expectedBodies[id]);
            return {
              bodyIndex,
              count: paths.length,
              paths: paths.slice(0, 100)
            };
          })
          .filter((body) => body.count > 0)
      },
      bodies: first.bodies.length,
      serializedBytes: first.bodies.reduce(
        (sum, body) => sum + body.bytes.byteLength,
        0
      ),
      faces: Object.values(first.result.bodyRepresentations).reduce(
        (sum, body) => sum + body.faceCount,
        0
      ),
      warnings: first.result.warnings.length
    };
  } finally {
    fresh.dispose();
  }
}
