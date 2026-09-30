/** Opt-in private H02 equivalence. Source and derived documents stay local. */
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { expect, it } from 'vitest';
import {
  createProjectDocument,
  importStepBody,
  listParameters,
  normalizeDocument,
  setParameter
} from '@openzcad/document-core';
import { createGrowingHolderProposal } from '@openzcad/ai-contracts';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type DerivedState } from '@openzcad/shared';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';

const sourcePath = process.env.OZ_PERF_HOLDER_STEP;

// Diagnostics contain field paths and counts only, never model values or IDs.
function differingPaths(
  actual: unknown,
  expected: unknown,
  path = ''
): string[] {
  if (isDeepStrictEqual(actual, expected)) return [];
  if (
    actual &&
    expected &&
    typeof actual === 'object' &&
    typeof expected === 'object'
  ) {
    const a = actual as Record<string, unknown>,
      b = expected as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((key) =>
      differingPaths(a[key], b[key], `${path}.${key}`)
    );
  }
  return [path];
}

function exactPublication({ updatedAt: _time, ...derived }: DerivedState) {
  const result = structuredClone(derived);
  for (const body of Object.values(result.bodyRepresentations)) {
    const opening = body.topology?.recognizedOpening;
    if (opening?.status === 'recognized') {
      // The two diagnostic indices address different arenas, as in the
      // public holder equivalence test. All exact witnesses stay compared.
      for (const key of ['faceA', 'faceB'] as const) {
        expect(Number.isSafeInteger(opening.evidence.candidate[key])).toBe(
          true
        );
        expect(opening.evidence.candidate[key]).toBeGreaterThanOrEqual(0);
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

it.skipIf(!sourcePath)(
  'private holder reload and first edit match a cache-disabled exact oracle',
  async () => {
    const events: RebuildCacheEvent[] = [];
    const warm = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event),
      measurementCacheDiagnostics: true
    });
    const cold = await createExactKernelAdapter({
      historyCheckpointLimit: 0,
      measuredShapeCacheBytes: 0
    });
    try {
      let imported = importStepBody(
        createProjectDocument('Private H02', toUserId('local')),
        {
          name: 'Source',
          artifactId: 'source',
          sourceName: 'source.step',
          stepText: readFileSync(sourcePath!, 'utf8')
        }
      ).document;
      imported = { ...imported, derived: await warm.syncDocument(imported) };
      const sourceHit = await warm.syncDocument(imported);
      // Compare the entire payload without dumping private geometry on failure.
      expect(
        isDeepStrictEqual(
          sourceHit.bodyRepresentations,
          imported.derived.bodyRepresentations
        ),
        'Unchanged private source must match byte/structure exactly'
      ).toBe(true);
      expect(events.at(-1)).toMatchObject({
        remeasured: 0,
        reusedMeasurements: 1
      });
      const proposal = createGrowingHolderProposal(imported, {
        bodyIds: []
      });
      expect(proposal).toBeDefined();
      const { candidate } = await preflightCadPatch(imported, proposal!, (d) =>
        warm.syncDocument(d)
      );
      expect(candidate.derived.warnings.length).toBe(0);
      const reopened = normalizeDocument(
        JSON.parse(JSON.stringify(candidate)) as typeof candidate
      );
      warm.dispose();
      await warm.syncDocument(reopened);
      const height = listParameters(reopened).find(
        (parameter) => parameter.name === 'holder_height'
      );
      expect(height).toBeDefined();
      const changed = setParameter(reopened, {
        name: 'holder_height',
        expression: String(Number(height!.expression) + 8)
      });
      const replayed: string[] = [];
      const actual = await warm.syncDocument(changed, (progress) => {
        if (progress.stage === 'feature' && progress.status === 'completed')
          replayed.push(progress.name);
      });
      expect(actual.warnings.length).toBe(0);
      expect(actual.featureWarnings?.length ?? 0).toBe(0);
      expect(replayed).not.toContain('Text');
      expect(replayed).toContain('Keep text together');
      expect(events.at(-1)!.reusedMeasurements).toBeGreaterThan(0);
      const expected = await cold.syncDocument(changed);
      const publishedActual = exactPublication(actual),
        publishedExpected = exactPublication(expected);
      if (process.env.OZ_PERF_PRIVATE_DIFF_OUT) {
        const { bodyRepresentations: actualBodies, ...actualRoot } =
          publishedActual;
        const { bodyRepresentations: expectedBodies, ...expectedRoot } =
          publishedExpected;
        writeFileSync(
          process.env.OZ_PERF_PRIVATE_DIFF_OUT,
          JSON.stringify(
            {
              root: differingPaths(actualRoot, expectedRoot),
              bodies: changed.bodyOrder.map((id, bodyIndex) => {
                const paths = differingPaths(
                  actualBodies[id],
                  expectedBodies[id]
                );
                return {
                  bodyIndex,
                  differenceCount: paths.length,
                  paths: paths.slice(0, 100)
                };
              }),
              summary: {
                documentBytes: new TextEncoder().encode(
                  JSON.stringify(reopened)
                ).byteLength,
                bodies: changed.bodyOrder.length,
                faces: Object.values(actual.bodyRepresentations).reduce(
                  (count, body) => count + body.faceCount,
                  0
                ),
                cache: events.at(-1)
              }
            },
            null,
            2
          )
        );
      }
      expect(
        isDeepStrictEqual(publishedActual, publishedExpected),
        'Private exact publication must match the uncached oracle'
      ).toBe(true);
      console.log(
        '[H02 private equivalence]',
        JSON.stringify({
          equivalent: true,
          documentBytes: new TextEncoder().encode(JSON.stringify(reopened))
            .byteLength,
          bodies: changed.bodyOrder.length,
          faces: Object.values(actual.bodyRepresentations).reduce(
            (count, body) => count + body.faceCount,
            0
          ),
          cache: events.at(-1)
        })
      );
    } finally {
      warm.dispose();
      cold.dispose();
    }
  },
  300_000
);
