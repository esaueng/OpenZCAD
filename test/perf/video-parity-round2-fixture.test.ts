import { it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeDocument,
  withoutDerivedProjection,
  filletEdges
} from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '../../packages/kernel-adapter/src/exact';
it.skipIf(!process.env.VIDEO_PARITY_INPUT)(
  'adds the reference R1 cap rim to the read-only supplied recipe',
  async () => {
    const input = process.env.VIDEO_PARITY_INPUT!;
    const out =
      process.env.VIDEO_PARITY_OUT ?? 'artifacts/video-parity-phase3-round2';
    const dest = join(out, 'input');
    mkdirSync(dest, { recursive: true });
    const backup = JSON.parse(
      readFileSync(join(input, 'Gentle-Gecko-W-Fillet.openzcad'), 'utf8')
    ) as { document: ProjectDocument };
    const base = withoutDerivedProjection(normalizeDocument(backup.document));
    const adapter = await createExactKernelAdapter();
    try {
      const s = await adapter.syncDocument(base);
      const id = s.exportableBodyIds[0]!;
      const rim = s.bodyRepresentations[id]!.topology!.edges.find(
        (e) =>
          e.curve?.type === 'CIRCLE' &&
          Math.abs((e.curve.circle?.radius ?? 0) - 6) < 1e-6 &&
          Array.from(e.points).every(
            (v, i) => i % 3 !== 2 || Math.abs(v - 36) < 1e-6
          )
      )!;
      const t = performance.now();
      const doc = filletEdges(base, {
        name: 'Reference R1 cap rim',
        targetBodyId: id,
        edgeHashes: [rim.hash],
        edgeReferences: rim.reference ? [rim.reference] : undefined,
        size: 1
      }).document;
      const state = await adapter.syncDocument(doc);
      const resultId = state.exportableBodyIds[0]!;
      writeFileSync(
        join(out, 'A0-rim-debug.json'),
        JSON.stringify(
          {
            edge: rim,
            warnings: state.warnings,
            featureWarnings: state.featureWarnings
          },
          null,
          2
        )
      );
      expect(
        state.bodyRepresentations[resultId]?.faceCount,
        state.warnings.join('\n')
      ).toBe(16);
      writeFileSync(
        join(dest, 'Gentle-Gecko-W-Fillet.openzcad'),
        JSON.stringify({ ...backup, document: withoutDerivedProjection(doc) })
      );
      writeFileSync(
        join(dest, 'Gentle-Gecko-W-Fillet.step'),
        await adapter.exportStep(doc, [resultId])
      );
      for (const ext of ['step', 'openzcad'])
        copyFileSync(
          join(input, `Gentle-Gecko.${ext}`),
          join(dest, `Gentle-Gecko.${ext}`)
        );
      writeFileSync(
        join(out, 'A0-rim.json'),
        JSON.stringify(
          {
            ms: performance.now() - t,
            faces: state.bodyRepresentations[resultId]?.faceCount,
            geometry: state.bodyRepresentations[resultId]?.topology?.faces.map(
              (f) => f.geometry
            ),
            warnings: state.warnings
          },
          null,
          2
        )
      );
    } finally {
      adapter.dispose();
    }
  },
  300_000
);
