import { describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  patternBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId } from '@openzcad/shared';
import * as rowFusion from '../packages/kernel-adapter/src/exact-grid-row-fusion';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import { barGrid, largePatternBar } from './support/large-pattern-bar';

// Each case rebuilds exact geometry, cold control kernels and STEP exports;
// the 50-copy bar takes ~3 s idle and over 5 s on a loaded CI runner.
describe('a rectangular grid with separated rows', { timeout: 60_000 }, () => {
  it('preserves the full-fuse topology, mesh, STEP and subsequent cut through a nested pattern', async () => {
    let doc = addPrimitiveFeature(
      createProjectDocument('Stock', toUserId('maker')),
      {
        name: 'Stock',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 5 }
      }
    );
    const seed = doc.bodyOrder[0]!;
    const bar = patternBody(doc, {
      name: 'Bar',
      targetBodyId: seed,
      patternKind: 'linear',
      count: 5,
      axis: 'x',
      spacing: 20
    });
    doc = bar.document;
    const grid = patternBody(
      doc,
      barGrid(doc.bodyOrder.at(-1)!, 4, 3)
    ).document;
    const id = grid.bodyOrder.at(-1)!;
    const tool = addPrimitiveFeature(grid, {
      name: 'Cutter',
      primitiveKind: 'box',
      dimensions: { width: 12, height: 8, depth: 12 }
    });
    const cut = booleanBodies(tool, {
      name: 'Cut',
      operation: 'subtract',
      targetBodyIds: [id, tool.bodyOrder.at(-1)!]
    }).document;
    const source = await createExactKernelAdapter();
    const idle = { lineageDemand: [] as BodyId[] };
    const stored = await (async () => {
      try {
        await source.syncDocument(doc, undefined, undefined, undefined, idle);
        const session = await source.captureHistorySession!(doc);
        expect(session).not.toBeNull();
        return structuredClone(session!);
      } finally {
        source.dispose();
      }
    })();
    const run = async () => {
      const events: RebuildCacheEvent[] = [];
      const adapter = await createExactKernelAdapter({
        onRebuildCacheEvent: (event) => events.push(event)
      });
      try {
        await adapter.syncDocument(doc, undefined, undefined, undefined, {
          ...idle,
          persistedSession: stored
        });
        expect(events.at(-1)?.sessionRestore).toBe('restored');
        const frame = await adapter.syncDocument(grid);
        expect(frame.warnings).toEqual([]);
        const body = frame.bodyRepresentations[id]!;
        expect(body.volume).toBeCloseTo((110 + 3 * 20) * 18 * 5 * 3, 6);
        const step = await adapter.exportStep(grid, [id], {
          timestamp: '2026-01-01T00:00:00Z'
        });
        const result = await adapter.syncDocument(cut);
        expect(result.warnings).toEqual([]);
        const cutBody = result.bodyRepresentations[cut.bodyOrder.at(-1)!]!;
        expect(cutBody.volume).toBeCloseTo(body.volume - 12 * 8 * 5, 6);
        return {
          topology: body.topology,
          mesh: body.mesh,
          step,
          cutTopology: cutBody.topology
        };
      } finally {
        adapter.dispose();
      }
    };
    const route = vi.spyOn(rowFusion, 'fuseSeparatedGridRows');
    try {
      const actual = await run();
      expect(
        route.mock.results.some((call) => typeof call.value === 'number')
      ).toBe(true);
      route.mockImplementation(() => undefined);
      expect(await run()).toEqual(actual);
    } finally {
      route.mockRestore();
    }
  });

  it.each(['box', '50-copy bar'])(
    'reuses only an identical first row across successive %s grid previews',
    async (fixture) => {
      const base =
        fixture === '50-copy bar'
          ? largePatternBar().document
          : addPrimitiveFeature(
              createProjectDocument('Preview', toUserId('maker')),
              {
                name: 'Stock',
                primitiveKind: 'box',
                dimensions: { width: 30, height: 18, depth: 5 }
              }
            );
      const source = base.bodyOrder.at(-1)!;
      const first = patternBody(base, barGrid(source, 4, 2)).document;
      const changedRows = patternBody(base, barGrid(source, 4, 3)).document;
      const changedSpacing = patternBody(base, {
        ...barGrid(source, 4, 3),
        spacing: 18
      }).document;
      const adapter = await createExactKernelAdapter();
      const fuse = vi.spyOn(RemusKernel.prototype, 'fuseAll');
      try {
        await adapter.syncDocument(first);
        const compare = async (document: typeof base, reused: boolean) => {
          fuse.mockClear();
          const frame = await adapter.syncDocument(document);
          expect(frame.warnings).toEqual([]);
          // Only the first-row fuse has four operands; final assembly has three.
          expect(fuse.mock.calls.some(([ids]) => ids.length === 4)).toBe(
            !reused
          );
          const id = document.bodyOrder.at(-1)!;
          const options = { timestamp: '2026-01-01T00:00:00Z' };
          const step = await adapter.exportStep(document, [id], options);
          const fresh = await createExactKernelAdapter();
          try {
            const control = await fresh.syncDocument(document);
            const actual = frame.bodyRepresentations[id]!;
            const expected = control.bodyRepresentations[id]!;
            expect(actual.mesh).toEqual(expected.mesh);
            expect(actual.topology).toEqual(expected.topology);
            expect(actual.volume).toBe(expected.volume);
            expect(step).toEqual(
              await fresh.exportStep(document, [id], options)
            );
          } finally {
            fresh.dispose();
          }
        };
        await compare(changedRows, true);
        await compare(changedSpacing, false);
      } finally {
        fuse.mockRestore();
        adapter.dispose();
      }
    }
  );

  it('keeps a skipped end copy out of the second row', async () => {
    const doc = addPrimitiveFeature(
      createProjectDocument('Skip', toUserId('maker')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 5 }
      }
    );
    const grid = patternBody(doc, {
      ...barGrid(doc.bodyOrder[0]!, 3, 2),
      skippedInstances: ['2-1']
    });
    const adapter = await createExactKernelAdapter();
    const route = vi.spyOn(rowFusion, 'fuseSeparatedGridRows');
    try {
      const frame = await adapter.syncDocument(grid.document);
      expect(frame.warnings).toEqual([]);
      expect(frame.bodyRepresentations[grid.bodyId]!.volume).toBeCloseTo(
        (70 + 50) * 18 * 5,
        6
      );
      expect(route).not.toHaveBeenCalled();
    } finally {
      route.mockRestore();
      adapter.dispose();
    }
  });

  it.each([18, 18 + 1e-8, 1e9])(
    'uses the full fuse for touching, near-contact or distant rows at %s mm',
    (step) => {
      const kernel = new RemusKernel();
      try {
        const box = kernel.makeBox(30, 18, 5);
        const matrix = (index: number) =>
          transformMatrix(
            { x: Math.floor(index / 2) * 10, y: (index % 2) * step, z: 0 },
            { x: 0, y: 0, z: 0 }
          );
        const copies = [
          box,
          ...[1, 2, 3].map((index) =>
            kernel.copyAndTransformSolid(box, matrix(index))
          )
        ];
        expect(
          rowFusion.fuseSeparatedGridRows(kernel, copies, 2, 'y', matrix)
        ).toBeUndefined();
      } finally {
        kernel.free();
      }
    }
  );
});
