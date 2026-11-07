import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '../../packages/kernel-adapter/src/exact';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { inspectTriangleMeshClosure } from '../../packages/kernel-adapter/src/boolean-result-validation';

it.skipIf(!process.env.VIDEO_PARITY_INPUT)(
  'measures source-parameter replay separately from local direct edits',
  async () => {
    const source = withoutDerivedProjection(
      normalizeDocument(
        (
          JSON.parse(
            readFileSync(
              join(
                process.env.VIDEO_PARITY_INPUT!,
                'Gentle-Gecko-W-Fillet.openzcad'
              ),
              'utf8'
            )
          ) as { document: ProjectDocument }
        ).document
      )
    );
    const adapter = await createExactKernelAdapter();
    const rows: unknown[] = [];
    try {
      await adapter.syncDocument(source);
      for (const [dimension, values] of [
        ['height', [22, 61.2, -4]],
        ['radius', [7.3, 8.5, 10.55, 7.35, 30]]
      ] as const) {
        for (const value of values) {
          const doc = structuredClone(source);
          doc.version++;
          const cylinder = Object.values(doc.nodes).find(
            (n) =>
              n.kind === 'feature' &&
              n.data.featureKind === 'primitive' &&
              n.data.primitiveKind === 'cylinder'
          );
          if (
            !cylinder ||
            cylinder.kind !== 'feature' ||
            cylinder.data.featureKind !== 'primitive'
          )
            throw new Error('Source cylinder missing');
          cylinder.data.dimensions[dimension] = value;
          const start = performance.now();
          const derived = await adapter.syncDocument(doc);
          const failed = derived.warnings.some(
            (w) => !w.includes('This fillet is approximate')
          );
          const checks: unknown[] = [];
          if (!failed) {
            const io = await loadRemusTranslators();
            const kernel = new RemusKernel();
            try {
              const step = await adapter.exportStep(
                doc,
                derived.exportableBodyIds
              );
              const solids = kernel.deserializeSolids(
                io.importStep(new TextEncoder().encode(step))
              );
              for (const solid of solids)
                checks.push({
                  validation: kernel.validateSolidDetailed(solid) as unknown,
                  volumes: [0.1, 0.01, 0.001].map((d) =>
                    kernel.volume(solid, d)
                  )
                });
            } finally {
              kernel.free();
            }
          }
          rows.push({
            failed,
            checks,
            dimension,
            value,
            ms: performance.now() - start,
            warnings: derived.warnings,
            bodies: derived.exportableBodyIds.map((id) => {
              const b = derived.bodyRepresentations[id]!;
              return {
                faces: b.faceCount,
                volume: b.volume,
                meshClosure: inspectTriangleMeshClosure(
                  b.mesh.vertices,
                  b.mesh.indices
                ),
                surfaces: b.topology?.faces.map((f) => f.geometry),
                lineages: b.topology?.faces.map((f) => f.reference?.lineageName)
              };
            })
          });
          await adapter.syncDocument(source);
        }
      }
    } finally {
      adapter.dispose();
      writeFileSync(
        join(
          process.env.VIDEO_PARITY_OUT ?? 'artifacts/video-parity',
          'native-source.json'
        ),
        JSON.stringify(rows, null, 2)
      );
    }
  },
  180_000
);
