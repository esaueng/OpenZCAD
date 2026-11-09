/** Opt-in diagnostic: repeated direct blend edits on the supplied network. */
import { it, expect } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExactKernelAdapter } from '../../packages/kernel-adapter/src/exact';
import { blendCarrierSnapshot } from '../../packages/kernel-adapter/src/exact-measure';
import {
  normalizeDocument,
  withoutDerivedProjection,
  directEditBody,
  updateFeature,
  listFeaturesInOrder
} from '@openzcad/document-core';
import type { ProjectDocument, FaceTopology } from '@openzcad/shared';

const input = process.env.VIDEO_PARITY_INPUT;
it.skipIf(!input)(
  'records append versus replay of a recognized blend resize',
  async () => {
    const out =
      process.env.VIDEO_PARITY_OUT ?? 'artifacts/video-parity-phase3/post';
    mkdirSync(out, { recursive: true });
    const adapter = await createExactKernelAdapter();
    try {
      const base = withoutDerivedProjection(
        normalizeDocument(
          (
            JSON.parse(
              readFileSync(
                join(input!, 'Gentle-Gecko-W-Fillet.openzcad'),
                'utf8'
              )
            ) as { document: ProjectDocument }
          ).document
        )
      );
      const initial = await adapter.syncDocument(base);
      const id = initial.exportableBodyIds[0]!;
      const band = initial.bodyRepresentations[id]!.topology!.faces.find(
        (f) =>
          f.geometry?.radius === 4 &&
          Math.abs(f.geometry.axisEnd!.x - f.geometry.axisStart!.x) > 10
      )!;
      const operation = (f: FaceTopology, radius: number) => {
        const carrier = blendCarrierSnapshot(f.geometry);
        if (!carrier) throw new Error('Selected band has no analytic carrier');
        return {
          kind: 'resize-blend' as const,
          faceHash: f.hash,
          faceReference: f.reference,
          surfaceClass: 'cylinder' as const,
          recordedRadius: f.geometry!.radius!,
          recordedCenter: carrier.center,
          recordedAxis: carrier.axis,
          newRadius: radius
        };
      };
      const first = directEditBody(base, {
        name: 'Resize blend',
        targetBodyId: id,
        operation: operation(band, 1.5)
      }).document;
      const rebuilt = await adapter.syncDocument(first);
      expect(
        rebuilt.warnings.filter((w) => !w.startsWith('Feature "Fillet":'))
      ).toEqual([]);
      const resized = rebuilt.bodyRepresentations[id]!.topology!.faces.find(
        (f) => f.geometry?.radius === 1.5
      )!;
      expect(resized).toBeDefined();
      const feature = listFeaturesInOrder(first).at(-1)!;
      const rows: unknown[] = [];
      for (const [label, document] of [
        [
          'append',
          directEditBody(first, {
            name: 'Resize blend again',
            targetBodyId: id,
            operation: operation(resized, 1.9)
          }).document
        ],
        [
          'replay',
          updateFeature(first, {
            featureId: feature.featureId,
            data: { operation: operation(band, 1.9) }
          })
        ]
      ] as const) {
        const start = performance.now();
        const result = await adapter.syncDocument(document);
        if (label === 'replay') {
          expect(
            result.warnings.filter((w) => !w.startsWith('Feature "Fillet":'))
          ).toEqual([]);
          expect(
            result.bodyRepresentations[id]?.topology?.faces.some(
              (f) => Math.abs((f.geometry?.radius ?? 0) - 1.9) < 1e-6
            )
          ).toBe(true);
        }
        rows.push({
          label,
          ms: performance.now() - start,
          warnings: result.warnings,
          featureWarnings: result.featureWarnings,
          faces: result.bodyRepresentations[id]?.faceCount,
          geometry: result.bodyRepresentations[id]?.topology?.faces.map(
            (f) => f.geometry
          )
        });
      }
      writeFileSync(
        join(out, 'sequential-blend.json'),
        JSON.stringify({ firstReference: resized.reference, rows }, null, 2)
      );
    } finally {
      adapter.dispose();
    }
  },
  300_000
);
