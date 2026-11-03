import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  filletEdges,
  listFeaturesInOrder,
  normalizeDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';

/**
 * Complete saved-history acceptance, with private fixtures kept outside Git.
 * FILLET_REPLAY_PROJECT names an .openzcad file; FILLET_REPLAY_EDGE_LENGTH
 * identifies the straight bottom edge in millimetres. The public kernel
 * regression independently constructs the retained curved-crown case.
 */
const projectPath = process.env.FILLET_REPLAY_PROJECT;
const edgeLength = Number(process.env.FILLET_REPLAY_EDGE_LENGTH);

it.skipIf(!projectPath)(
  'adds a 1 mm bottom fillet after the complete saved history and preserves earlier features',
  async () => {
    expect(Number.isFinite(edgeLength) && edgeLength > 0).toBe(true);
    const saved = JSON.parse(readFileSync(projectPath!, 'utf8')) as {
      document: ProjectDocument;
    };
    const document = normalizeDocument(saved.document);
    expect(document.units).toBe('mm');
    const originalFeatures = structuredClone(listFeaturesInOrder(document));
    const adapter = await createExactKernelAdapter();
    const fresh = await createExactKernelAdapter();
    try {
      document.derived = await adapter.syncDocument(document);
      const bodyId = document.derived.exportableBodyIds.at(-1)!;
      const before = document.derived.bodyRepresentations[bodyId]!;
      const bottomEdges = before.topology!.edges.filter(
        (edge) =>
          edge.curve?.type === 'LINE' &&
          Math.abs((edge.length ?? Number.NaN) - edgeLength) < 1e-6 &&
          edge.points.every(
            (coordinate, index) =>
              index % 3 !== 2 || Math.abs(coordinate) < 1e-7
          )
      );
      expect(bottomEdges).toHaveLength(1);
      const edge = bottomEdges[0]!;
      const rounded = filletEdges(document, {
        name: 'Bottom fillet',
        targetBodyId: bodyId,
        edgeHashes: [edge.hash],
        ...(edge.reference ? { edgeReferences: [edge.reference] } : {}),
        size: 1
      });
      const derived = await adapter.syncDocument(rounded.document);
      expect(derived.warnings).toEqual(document.derived.warnings);
      expect(derived.exportableBodyIds).toContain(rounded.bodyId);
      const after = derived.bodyRepresentations[rounded.bodyId]!;
      expect(after.volume).toBeGreaterThan(0);
      expect(after.volume).toBeLessThan(before.volume);
      expect(
        after.topology!.faces.some(
          (face) =>
            face.geometry?.surfaceType === 'cylinder' &&
            Math.abs((face.geometry.radius ?? 0) - 1) < 1e-6
        )
      ).toBe(true);
      expect(
        listFeaturesInOrder(rounded.document).slice(0, originalFeatures.length)
      ).toEqual(originalFeatures);

      const replay = await fresh.syncDocument(rounded.document);
      expect(replay.warnings).toEqual(derived.warnings);
      expect(replay.bodyRepresentations[rounded.bodyId]!.volume).toBeCloseTo(
        after.volume,
        6
      );
      const undone = await adapter.syncDocument(document);
      expect(undone.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        before.volume,
        6
      );
      const redone = await adapter.syncDocument(rounded.document);
      expect(redone.bodyRepresentations[rounded.bodyId]!.volume).toBeCloseTo(
        after.volume,
        6
      );

      const step = await adapter.exportStep(rounded.document, [rounded.bodyId]);
      const inspection = await adapter.inspectStep(step);
      expect(inspection.solid).toBe(true);
      expect(inspection.valid).toBe(true);
      expect(inspection.volume).toBeCloseTo(after.volume, 0);
    } finally {
      adapter.dispose();
      fresh.dispose();
    }
  },
  180_000
);
