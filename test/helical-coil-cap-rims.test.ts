import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  findSketch,
  helicalSweepProfile,
  resolveParamValue
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { approximateBlendAdvisory } from '../packages/kernel-adapter/src/exact-edge-modifiers';

function coilDocument() {
  const profile = addSketchFeature(
    createProjectDocument('Coil cap rims', toUserId('user_test')),
    {
      name: 'Wire',
      plane: 'XZ',
      offset: 0,
      object: { objectKind: 'circle', radius: 5, centerX: 25, centerY: 0 }
    }
  );
  const sketch = findSketch(profile.document, profile.sketchId)!;
  const objects = sketch.objectIds.map((id) => {
    const node = profile.document.nodes[id];
    if (node?.kind !== 'sketch-object') {
      throw new Error('Expected a sketch object.');
    }
    return { id: node.id, data: node.data };
  });
  const [region] = computeSketchProfileAnalysis(objects, (value) =>
    resolveParamValue(value, {}, 'profile dimension')
  ).profiles;
  if (!region) throw new Error('Expected one closed circle profile.');
  return helicalSweepProfile(profile.document, {
    name: 'Coil',
    profile: {
      sketchId: profile.sketchId,
      profile: {
        profileId: region.profileId,
        regionFingerprint: region.regionFingerprint,
        samplePoint: region.samplePoint,
        sourceArea: region.area,
        sourceEntityIds: region.sourceEntityIds
      }
    },
    axisOrigin: { x: 0, y: 0, z: 0 },
    axisDirection: { x: 0, y: 0, z: 1 },
    radius: 25,
    pitch: 23.5,
    turns: 2,
    construction: 'in-place'
  });
}

describe('in-place helical coil cap rims', { timeout: 120_000 }, () => {
  it('publishes only two closed cap rims and accepts a 1 mm fillet or chamfer on either rim', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const coil = coilDocument();
      const derived = await adapter.syncDocument(coil.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[coil.bodyId]!;
      const topology = body.topology!;
      const caps = topology.faces.filter(
        (face) => face.geometry?.surfaceType === 'plane'
      );
      expect(caps).toHaveLength(2);
      expect(topology.faces).toHaveLength(3);
      expect(topology.edges).toHaveLength(3);
      expect(new Set(topology.edges.map((edge) => edge.hash)).size).toBe(
        topology.edges.length
      );
      const visible = topology.edges.filter(
        (edge) => edge.displayRole !== 'seam'
      );
      expect(visible).toHaveLength(2);
      const rims = caps.map((cap) => {
        const edges = visible.filter((edge) =>
          edge.adjacentFaceHashes?.includes(cap.hash)
        );
        expect(edges).toHaveLength(1);
        const rim = edges[0]!;
        expect(rim.curve?.type).toBe('CIRCLE');
        expect(rim.vertexIds).toHaveLength(2);
        expect(rim.vertexIds![0]).toBe(rim.vertexIds![1]);
        return rim;
      });
      // Every visible edge bounds a cap; the longitudinal edge is a seam.
      expect(new Set(rims.map((edge) => edge.hash))).toEqual(
        new Set(visible.map((edge) => edge.hash))
      );
      expect(
        topology.edges.find((edge) => edge.displayRole === 'seam')
      ).toMatchObject({ isSmooth: true });

      for (const rim of rims) {
        for (const [kind, modify] of [
          ['fillet', filletEdges],
          ['chamfer', chamferEdges]
        ] as const) {
          const modified = modify(coil.document, {
            name: 'Cap modifier',
            targetBodyId: coil.bodyId,
            edgeHashes: [rim.hash],
            ...(rim.reference ? { edgeReferences: [rim.reference] } : {}),
            size: 1
          });
          const result = await adapter.syncDocument(modified.document);
          // Remus #1626 discloses walked blends around a spline tube as approximate.
          const warnings = [
            `Feature "Cap modifier": ${approximateBlendAdvisory(kind)}`
          ];
          expect(result.warnings).toEqual(warnings);
          expect(
            (result.featureWarnings ?? []).map((warning) => warning.kind)
          ).toEqual(warnings.map(() => 'advisory'));
          const modifiedBody = result.bodyRepresentations[modified.bodyId];
          expect(modifiedBody).toBeDefined();
          expect(result.exportableBodyIds).toContain(modified.bodyId);
          expect(modifiedBody!.volume).toBeGreaterThan(0);
          expect(modifiedBody!.volume).toBeLessThan(body.volume);
        }
      }
    } finally {
      adapter.dispose();
    }
  });
});
