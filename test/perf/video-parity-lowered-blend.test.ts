/** Opt-in kernel control over a document captured from the real UI. */
import { it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '../../packages/kernel-adapter/src/exact';
import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { measureFaceGeometry } from '../../packages/kernel-adapter/src/exact-measure';

const source = process.env.VIDEO_PARITY_SOURCE_DOC;
it.skipIf(!source)(
  'records raw prepared commits on the lowered boss',
  async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const doc = JSON.parse(readFileSync(source!, 'utf8')) as ProjectDocument;
      const derived = await adapter.syncDocument(doc);
      const id = derived.exportableBodyIds[0]!;
      const debug = adapter as unknown as {
        historyKernel: RemusKernel;
        currentMassSnapshot: { bodies: Map<string, { solid: number }> };
      };
      const k = debug.historyKernel;
      const solid = debug.currentMassSnapshot.bodies.get(id)!.solid;
      const face = [...k.getSolidFaces(solid)].find((f) => {
        const g = measureFaceGeometry(k, f);
        return g?.radius === 4 && Math.abs(g.axisEnd!.y - g.axisStart!.y) > 5;
      });
      expect(face).toBeDefined();
      const checkpoint = k.checkpoint();
      const rows: unknown[] = [];
      for (const radius of [1.5, 1.9]) {
        k.restore(checkpoint);
        let prepared: number | undefined;
        let prepareError: string | undefined;
        try {
          prepared = k.prepareResizeBlend(solid, face!, 4);
        } catch (e) {
          prepareError = String(e);
        }
        const started = performance.now();
        let preview: number | undefined;
        let previewError: string | undefined;
        try {
          preview =
            prepared === undefined
              ? k.resizeBlend(solid, face!, 4, radius)
              : k.previewPreparedGroupEdit(prepared, radius);
        } catch (e) {
          previewError = String(e);
        }
        k.restore(checkpoint);
        try {
          const journal = JSON.parse(
            prepared === undefined
              ? k.resizeBlendJournaled(solid, face!, 4, radius)
              : k.commitPreparedGroupEditJournaled(prepared, radius)
          ) as { solid: number };
          rows.push({
            radius,
            prepareError,
            preview,
            previewError,
            commitMs: performance.now() - started,
            strictErrors: k.validateSolid(journal.solid),
            faces: k.getSolidFaces(journal.solid).length
          });
        } catch (e) {
          rows.push({
            radius,
            prepareError,
            preview,
            previewError,
            error: String(e)
          });
        } finally {
          if (prepared !== undefined) k.releasePreparedGroupEdit(prepared);
        }
      }
      writeFileSync(
        join(
          process.env.VIDEO_PARITY_OUT!,
          'lowered-blend-kernel-control.json'
        ),
        JSON.stringify(rows, null, 2)
      );
    } finally {
      adapter.dispose();
    }
  },
  180_000
);
