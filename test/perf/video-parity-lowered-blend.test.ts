/** Opt-in kernel control over a document captured from the real UI. */
import { it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '../../packages/kernel-adapter/src/exact';
import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { measureFaceGeometry } from '../../packages/kernel-adapter/src/exact-measure';
import { inspectTriangleMeshClosure } from '../../packages/kernel-adapter/src/boolean-result-validation';

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
      const concave = process.env.VIDEO_PARITY_CONTROL_CONCAVE === '1';
      const cylinder = process.env.VIDEO_PARITY_CONTROL_CYLINDER === '1';
      const sourceMesh = [0.005, 0.01, 0.02].map((deflection) => {
        const mesh = k.tessellateSolidGroupedBinary(solid, deflection, 0.06);
        try {
          return {
            deflection,
            ...inspectTriangleMeshClosure(mesh.positions, mesh.indices)
          };
        } finally {
          mesh.free();
        }
      });
      const faces = [...k.getSolidFaces(solid)].filter((f) => {
        const g = measureFaceGeometry(k, f);
        const axis = concave ? 'z' : 'y';
        return (
          g?.radius === (cylinder ? 6 : 4) &&
          Math.abs(
            g.axisEnd![cylinder ? 'z' : axis] -
              g.axisStart![cylinder ? 'z' : axis]
          ) > 5
        );
      });
      expect(faces.length).toBeGreaterThan(0);
      const checkpoint = k.checkpoint();
      const rows: unknown[] = [];
      for (const face of concave ? faces : faces.slice(0, 1)) {
        for (const radius of cylinder
          ? [7.3, 8.5, 10.55, 7.35, 30]
          : concave
            ? [2]
            : [1.5, 1.9]) {
          k.restore(checkpoint);
          let prepared: number | undefined;
          let prepareError: string | undefined;
          try {
            prepared = cylinder
              ? k.prepareResizeCylindricalFace(solid, face)
              : k.prepareResizeBlend(solid, face, 4);
          } catch (e) {
            prepareError = String(e);
          }
          const started = performance.now();
          let preview: number | undefined;
          let previewError: string | undefined;
          try {
            preview =
              prepared === undefined
                ? cylinder
                  ? k.resizeCylindricalFace(solid, face, radius)
                  : k.resizeBlend(solid, face, 4, radius)
                : k.previewPreparedGroupEdit(prepared, radius);
          } catch (e) {
            previewError = String(e);
          }
          k.restore(checkpoint);
          try {
            const journal = JSON.parse(
              prepared === undefined
                ? cylinder
                  ? k.resizeCylindricalFaceJournaled(solid, face, radius)
                  : k.resizeBlendJournaled(solid, face, 4, radius)
                : k.commitPreparedGroupEditJournaled(prepared, radius)
            ) as { solid: number };
            rows.push({
              face,
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
              face,
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
      }
      writeFileSync(
        join(
          process.env.VIDEO_PARITY_OUT!,
          cylinder
            ? 'cumulative-cylinder-kernel-control.json'
            : concave
              ? 'concave-after-convex-kernel-control.json'
              : 'lowered-blend-kernel-control.json'
        ),
        JSON.stringify({ sourceMesh, rows }, null, 2)
      );
    } finally {
      adapter.dispose();
    }
  },
  180_000
);
