import { PatternOverlapWorkers } from '../packages/kernel-adapter/src/pattern-overlap-workers';
import { MEASUREMENT_DEFLECTION } from '../packages/kernel-adapter/src/exact-witnesses';
import {
  addPrimitiveFeature,
  createProjectDocument,
  patternBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { describe, expect, it, vi } from 'vitest';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import { sharedSolidVolume } from '../packages/kernel-adapter/src/exact-boolean-helpers';

describe('overlap measurements while editing a linear pattern', () => {
  it('reuses adjacent placed solids across count changes and remeasures after moving them', () => {
    const kernel = new RemusKernel();
    try {
      const stock = kernel.makeCylinder(5, 10);
      const build = (count: number, spacing: number) =>
        Array.from({ length: count }, (_, index) =>
          kernel.copyAndTransformSolid(
            stock,
            transformMatrix(
              { x: index * spacing, y: 0, z: 0 },
              { x: 0, y: 0, z: 0 }
            )
          )
        );
      const queries = vi.spyOn(kernel, 'booleanWithQuality');
      for (const [count, spacing, expectedQueries] of [
        [3, 6, 2],
        [5, 6, 2],
        [3, 6, 0],
        [3, 7, 2],
        [3, 11, 0]
      ] as const) {
        const solids = build(count, spacing);
        const reference = sharedSolidVolume(kernel, solids);
        queries.mockClear();
        expect(sharedSolidVolume(kernel, solids, undefined, true)).toBe(
          reference
        );
        expect(queries).toHaveBeenCalledTimes(expectedQueries);
      }
    } finally {
      kernel.free();
    }
  });

  it('does not serialize a complex source just to discover it exceeds the cache budget', () => {
    const kernel = new RemusKernel();
    try {
      const a = kernel.makeBox(10, 5, 2);
      const b = kernel.copyAndTransformSolid(
        a,
        transformMatrix({ x: 6, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
      );
      const reference = sharedSolidVolume(kernel, [a, b]);
      vi.spyOn(kernel, 'getSolidFaces').mockReturnValue(new Uint32Array(100));
      const serialize = vi.spyOn(kernel, 'serializeSolids');
      expect(sharedSolidVolume(kernel, [a, b], undefined, true)).toBe(
        reference
      );
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      kernel.free();
    }
  });

  it('keeps a checked pattern preview identical to a cold build after changing count or spacing', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Count edit', toUserId('maker')),
      {
        name: 'Stock',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 10 }
      }
    );
    const targetBodyId = base.bodyOrder[0]!;
    const adapter = await createExactKernelAdapter();
    const queries = vi.spyOn(RemusKernel.prototype, 'booleanWithQuality');
    try {
      const options = { proposeCarry: true, lineageDemand: [] };
      await adapter.syncDocument(base);
      for (const [count, spacing, expected] of [
        [3, 6, 2],
        [4, 6, 1],
        [4, 7, 3]
      ] as const) {
        const document = patternBody(base, {
          name: 'Row',
          targetBodyId,
          patternKind: 'linear',
          axis: 'x',
          count,
          spacing
        }).document;
        queries.mockClear();
        const frame = await adapter.syncDocument(
          document,
          undefined,
          undefined,
          undefined,
          options
        );
        expect(
          queries.mock.calls.filter(([kind]) => kind === 'intersect')
        ).toHaveLength(expected);
        const fresh = await createExactKernelAdapter();
        try {
          const reference = await fresh.syncDocument(
            document,
            undefined,
            undefined,
            undefined,
            options
          );
          const id = document.bodyOrder.at(-1)!;
          expect(frame.warnings).toEqual(reference.warnings);
          expect(frame.featureWarnings).toEqual(reference.featureWarnings);
          expect(frame.bodyRepresentations[id]).toEqual(
            reference.bodyRepresentations[id]
          );
        } finally {
          fresh.dispose();
        }
      }
    } finally {
      queries.mockRestore();
      adapter.dispose();
    }
  });

  it.each([false, true])(
    'uses independently measured pairs and preserves the complete solid and STEP (skip second copy: %s)',
    async (skipSecond) => {
      const stock = addPrimitiveFeature(
        createProjectDocument('Parallel row', toUserId('maker')),
        {
          name: 'Stock',
          primitiveKind: 'cylinder',
          dimensions: { radius: 5, height: 10 }
        }
      );
      const row = patternBody(stock, {
        name: 'Row',
        targetBodyId: stock.bodyOrder[0]!,
        patternKind: 'linear',
        axis: 'x',
        count: 13,
        spacing: 7,
        ...(skipSecond ? { skippedInstances: ['1'] } : {})
      });
      const adapter = await createExactKernelAdapter();
      const reference = await createExactKernelAdapter();
      const buildOptions = { lineageDemand: [], proposeCarry: true };
      const exportOptions = { timestamp: '2026-01-01T00:00:00Z' };
      try {
        const serial = await reference.syncDocument(
          row.document,
          undefined,
          undefined,
          undefined,
          buildOptions
        );
        const expectedStep = await reference.exportStep(
          row.document,
          [row.bodyId],
          exportOptions
        );
        const intersect = RemusKernel.prototype.booleanWithQuality;
        const calls = vi.spyOn(RemusKernel.prototype, 'booleanWithQuality');
        vi.spyOn(
          PatternOverlapWorkers.prototype,
          'available',
          'get'
        ).mockReturnValue(true);
        const jobs = vi
          .spyOn(PatternOverlapWorkers.prototype, 'measure')
          .mockImplementation(async (pairs) => {
            await Promise.resolve();
            const scratch = new RemusKernel();
            try {
              return pairs.map((bytes) => {
                const [a, b] = scratch.deserializeSolids(bytes);
                const common = intersect.call(
                  scratch,
                  'intersect',
                  a!,
                  b!,
                  true
                );
                return scratch.volume(common.solid, MEASUREMENT_DEFLECTION);
              });
            } finally {
              scratch.free();
            }
          });
        const actual = await adapter.syncDocument(
          row.document,
          undefined,
          undefined,
          undefined,
          buildOptions
        );
        expect(jobs).toHaveBeenCalledTimes(1);
        expect(jobs.mock.calls[0]![0]).toHaveLength(skipSecond ? 10 : 11);
        expect(
          calls.mock.calls.filter(([op]) => op === 'intersect')
        ).toHaveLength(skipSecond ? 0 : 1);
        expect(actual.bodyRepresentations[row.bodyId]).toEqual(
          serial.bodyRepresentations[row.bodyId]
        );
        expect(actual.warnings).toEqual(serial.warnings);
        expect(actual.featureWarnings).toEqual(serial.featureWarnings);
        expect(
          await adapter.exportStep(row.document, [row.bodyId], exportOptions)
        ).toBe(expectedStep);
      } finally {
        vi.restoreAllMocks();
        adapter.dispose();
        reference.dispose();
      }
    }
  );

  it('retries refused intersections and keeps the conservative overlap when serialization fails', () => {
    const kernel = new RemusKernel();
    try {
      const a = kernel.makeBox(10, 5, 2);
      const b = kernel.copyAndTransformSolid(
        a,
        transformMatrix({ x: 6, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
      );
      const queries = vi
        .spyOn(kernel, 'booleanWithQuality')
        .mockImplementation(() => {
          throw new Error('refused');
        });
      const refused = sharedSolidVolume(kernel, [a, b]);
      queries.mockClear();
      expect(refused).toBeGreaterThan(0);
      for (let i = 0; i < 2; i++)
        expect(sharedSolidVolume(kernel, [a, b], undefined, true)).toBe(
          refused
        );
      expect(queries).toHaveBeenCalledTimes(4);
      queries.mockRestore();
      const expected = sharedSolidVolume(kernel, [a, b]);
      vi.spyOn(kernel, 'serializeSolids').mockImplementation(() => {
        throw new Error('serialization unavailable');
      });
      expect(sharedSolidVolume(kernel, [a, b], undefined, true)).toBe(expected);
    } finally {
      kernel.free();
    }
  });
});
