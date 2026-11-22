import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  importStepBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '../packages/kernel-adapter/src/exact';
import { toUserId, type BodyId, type EdgeTopology } from '@openzcad/shared';

/**
 * M03 export/reimport agreement: an exact variable-radius fillet survives a
 * STEP round trip. The reimported solid keeps the face count and measures
 * the same closed form, (1 − π/4)·L·∫r² removed along the edge, and the
 * tangent-ball corners of an all-edge round keep their eight spheres.
 */
const LENGTH = 60;
const BOX = LENGTH * 40 * 20;
const CORNER = 1 - Math.PI / 4;

/** ∫₀¹ r(t)² dt for r = r0 + (r1 − r0)·s(t). */
function meanSquare(r0: number, r1: number, law: 'linear' | 'scurve') {
  const d = r1 - r0;
  // ∫s = 1/2 under both laws; ∫s² = 1/3 (linear) or 13/35 (smoothstep).
  const s2 = law === 'linear' ? 1 / 3 : 13 / 35;
  return r0 * r0 + r0 * d + d * d * s2;
}

describe('variable fillet STEP round trip (M03)', { timeout: 180_000 }, () => {
  it('reimports a variable round with its faces and its closed-form volume', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const document = addPrimitiveFeature(
        createProjectDocument('Round trip', toUserId('user_roundtrip')),
        {
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: LENGTH, height: 40, depth: 20 }
        }
      );
      const bodyId = document.bodyOrder.at(-1) as BodyId;
      const built = await adapter.syncDocument(document);
      const edge = built.bodyRepresentations[bodyId]!.topology!.edges.find(
        (candidate: EdgeTopology) =>
          candidate.curve?.type === 'LINE' &&
          Math.abs((candidate.length ?? 0) - LENGTH) < 1e-6
      )!;
      for (const law of ['linear', 'scurve'] as const) {
        const rounded = filletEdges(document, {
          name: 'Round',
          targetBodyId: bodyId,
          edgeHashes: [edge.hash],
          edgeReferences: [edge.reference!],
          size: 1,
          endRadius: 3,
          radiusLaw: law
        });
        const derived = await adapter.syncDocument(rounded.document);
        expect(derived.featureWarnings ?? [], law).toEqual([]);
        const resultId = rounded.document.bodyOrder.at(-1) as BodyId;
        const source = derived.bodyRepresentations[resultId]!;
        const expected = BOX - CORNER * LENGTH * meanSquare(1, 3, law);
        expect(source.volume, law).toBeCloseTo(expected, 6);

        const step = await adapter.exportStep(rounded.document, [resultId]);
        const imported = importStepBody(
          createProjectDocument('Reimport', toUserId('user_roundtrip')),
          {
            name: 'Round',
            artifactId: `round-${law}`,
            sourceName: `round-${law}.step`,
            stepText: step
          }
        );
        const reread = await adapter.syncDocument(imported.document);
        expect(reread.warnings, law).toEqual([]);
        const again = reread.bodyRepresentations[imported.bodyId]!;
        expect(again.topology!.faces, law).toHaveLength(
          source.topology!.faces.length
        );
        expect(Math.abs(again.volume - expected) / expected, law).toBeLessThan(
          1e-6
        );
      }
    } finally {
      adapter.dispose();
    }
  });

  it('reimports the tangent-ball corners of an all-edge variable round', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const document = addPrimitiveFeature(
        createProjectDocument('Corners', toUserId('user_roundtrip')),
        {
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: LENGTH, height: 40, depth: 20 }
        }
      );
      const bodyId = document.bodyOrder.at(-1) as BodyId;
      const built = await adapter.syncDocument(document);
      const edges = built.bodyRepresentations[bodyId]!.topology!.edges;
      const r = 2;
      const rounded = filletEdges(document, {
        name: 'Round',
        targetBodyId: bodyId,
        edgeHashes: edges.map((edge) => edge.hash),
        edgeReferences: edges.map((edge) => edge.reference!),
        size: r,
        endRadius: r,
        radiusLaw: 'scurve'
      });
      const derived = await adapter.syncDocument(rounded.document);
      expect(derived.featureWarnings ?? []).toEqual([]);
      const resultId = rounded.document.bodyOrder.at(-1) as BodyId;
      const source = derived.bodyRepresentations[resultId]!;
      const lengths = edges.reduce((sum, edge) => sum + edge.length!, 0);
      const expected =
        BOX -
        CORNER * r * r * (lengths - 24 * r) -
        8 * r ** 3 * (1 - Math.PI / 6);
      // B20's 1e-6 relative measurement target: the sphere octants are
      // integrated numerically, so the volume is not exact to the digit.
      expect(Math.abs(source.volume - expected) / expected).toBeLessThan(1e-6);

      const step = await adapter.exportStep(rounded.document, [resultId]);
      const imported = importStepBody(
        createProjectDocument('Reimport', toUserId('user_roundtrip')),
        {
          name: 'Corners',
          artifactId: 'corners',
          sourceName: 'corners.step',
          stepText: step
        }
      );
      const reread = await adapter.syncDocument(imported.document);
      expect(reread.warnings).toEqual([]);
      const again = reread.bodyRepresentations[imported.bodyId]!;
      const spheres = (faces: NonNullable<typeof again.topology>['faces']) =>
        faces.filter((face) => face.geometry?.surfaceType === 'sphere').length;
      expect(spheres(again.topology!.faces)).toBe(8);
      expect(again.topology!.faces).toHaveLength(source.topology!.faces.length);
      expect(Math.abs(again.volume - expected) / expected).toBeLessThan(1e-6);
    } finally {
      adapter.dispose();
    }
  });
});
