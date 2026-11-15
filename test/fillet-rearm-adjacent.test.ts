import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  shellBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { newBlendFacePick } from '../apps/web/src/lib/blendRearm';

/**
 * QA 2026-11-14 finding #10: after a drag-committed Fillet 4 landed beside
 * Fillet 3, the face re-armed for the new fillet was Fillet 3's band (the
 * new fillet trims it to a new hash), so the Picked chip read "Fillet 3 R 3
 * mm" and a typed radius edited Fillet 3. Run on the exact kernel, on a box
 * on a shelled box (Shell has published face names since #1500), and on a
 * union whose faces share carriers, so its bands stay hash-only and are told
 * apart by their carrier alone.
 */

type Edge = BodyTopology['edges'][number];
type Face = BodyTopology['faces'][number];

const user = toUserId('user_fillet_rearm');

function endpoints(edge: Edge): string[] {
  const key = (index: number) =>
    edge.points
      .slice(index * 3, index * 3 + 3)
      .map((value) => Math.round(value * 1000) / 1000)
      .join(',');
  return [key(0), key(edge.points.length / 3 - 1)];
}

function blends(faces: readonly Face[]): Face[] {
  return faces.filter((face) => face.geometry?.featureType === 'blend');
}

describe(
  're-arming a fillet beside an earlier one',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });

    afterAll(() => {
      adapter.dispose();
    });

    /**
     * Fillet 3 on one edge of `bodyId` at R3, then Fillet 4 on an edge
     * that meets Fillet 3's band at a corner.
     */
    async function besideFillet(
      document: ProjectDocument,
      bodyId: BodyId,
      secondRadius: number
    ) {
      const base = await adapter.syncDocument(document);
      const first = base.bodyRepresentations[bodyId]!.topology!.edges.find(
        (edge) =>
          edge.displayRole !== 'seam' &&
          Math.abs(edge.points[2]! - edge.points.at(-1)!) > 5
      )!;
      const fillet3 = filletEdges(document, {
        name: 'Fillet 3',
        targetBodyId: bodyId,
        edgeHashes: [first.hash],
        ...(first.reference ? { edgeReferences: [first.reference] } : {}),
        size: 3
      });
      const filleted = await adapter.syncDocument(fillet3.document);
      expect(filleted.warnings).toEqual([]);
      const topology = filleted.bodyRepresentations[fillet3.bodyId]!.topology!;
      const bandHashes = new Set(
        blends(topology.faces).map((face) => face.hash)
      );
      const bandEnds = new Set(
        topology.edges
          .filter((edge) =>
            (edge.adjacentFaceHashes ?? []).some((hash) => bandHashes.has(hash))
          )
          .flatMap(endpoints)
      );
      const second = topology.edges.find(
        (edge) =>
          edge.displayRole !== 'seam' &&
          !(edge.adjacentFaceHashes ?? []).some((hash) =>
            bandHashes.has(hash)
          ) &&
          endpoints(edge).some((point) => bandEnds.has(point))
      )!;
      expect(second).toBeDefined();
      const fillet4 = filletEdges(fillet3.document, {
        name: 'Fillet 4',
        targetBodyId: fillet3.bodyId,
        edgeHashes: [second.hash],
        ...(second.reference ? { edgeReferences: [second.reference] } : {}),
        size: secondRadius
      });
      const derived = await adapter.syncDocument(fillet4.document);
      expect(derived.warnings).toEqual([]);
      const after =
        derived.bodyRepresentations[fillet4.bodyId]!.topology!.faces;
      const fillet4Id = listFeaturesInOrder(fillet4.document).at(-1)!.featureId;
      expect(listFeaturesInOrder(fillet4.document).at(-1)!.name).toBe(
        'Fillet 4'
      );
      return {
        before: topology.faces,
        after,
        bodyId: fillet4.bodyId,
        fillet4Id
      };
    }

    it('picks the new fillet band on a named box', async () => {
      const document = addPrimitiveFeature(
        createProjectDocument('Rearm beside a fillet', user),
        {
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: 40, depth: 30, height: 20 }
        }
      );
      const bodyId = document.bodyOrder.at(-1)!;
      const {
        before,
        after,
        bodyId: resultId,
        fillet4Id
      } = await besideFillet(document, bodyId, 2);
      // The precondition the defect needs: the earlier band came back with a
      // new hash.
      expect(
        blends(after).filter(
          (face) =>
            face.reference?.producingFeatureId !== fillet4Id &&
            !before.some((previous) => previous.hash === face.hash)
        )
      ).not.toHaveLength(0);
      const pick = newBlendFacePick(resultId, before, after, fillet4Id);
      const picked = after.find((face) => face.hash === pick?.selection.hash);
      expect(picked?.reference?.producingFeatureId).toBe(fillet4Id);
      expect(picked?.geometry?.blendRadius).toBe(2);
    });

    it("re-arms the new fillet's own band on a shelled box", async () => {
      const boxed = addPrimitiveFeature(
        createProjectDocument('Rearm beside a fillet, shelled', user),
        {
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: 40, depth: 30, height: 20 }
        }
      );
      const boxId = boxed.bodyOrder.at(-1)!;
      const base = await adapter.syncDocument(boxed);
      const top = base.bodyRepresentations[boxId]!.topology!.faces.find(
        (face) => (face.geometry?.normal?.z ?? 0) > 0.99
      )!;
      const shelled = shellBody(boxed, {
        name: 'Shell',
        targetBodyId: boxId,
        openingFaceHashes: [top.hash],
        ...(top.reference ? { openingFaceReferences: [top.reference] } : {}),
        thickness: 2
      });
      const {
        before,
        after,
        bodyId: resultId,
        fillet4Id
      } = await besideFillet(shelled.document, shelled.bodyId, 1);
      // Since #1500 the shelled bands carry names, so the trimmed Fillet 3
      // band is named for Fillet 3 and cannot be taken for the new one.
      expect(blends(after).every((face) => face.reference !== undefined)).toBe(
        true
      );
      const pick = newBlendFacePick(resultId, before, after, fillet4Id);
      const picked = after.find((face) => face.hash === pick?.selection.hash);
      expect(picked?.reference?.producingFeatureId).toBe(fillet4Id);
      expect(picked?.geometry?.blendRadius).toBe(1);
    });
    it('never picks the earlier band on a hash-only shared-carrier union', async () => {
      // As in test/boolean-carrier-lineage.test.ts: both boxes stand on
      // y = 0 and z = 0, so the fused faces there have two sources and no
      // name, and fillets between them publish hash-only bands.
      const withPlate = addPrimitiveFeature(
        createProjectDocument('Rearm beside a fillet, union', user),
        {
          name: 'Plate',
          primitiveKind: 'box',
          dimensions: { width: 40, height: 24, depth: 10 }
        }
      );
      const withPost = addPrimitiveFeature(withPlate, {
        name: 'Post',
        primitiveKind: 'box',
        dimensions: { width: 12, height: 24, depth: 30 }
      });
      const fused = booleanBodies(withPost, {
        name: 'Fuse',
        operation: 'union',
        targetBodyIds: [withPost.bodyOrder[0]!, withPost.bodyOrder[1]!]
      });
      const {
        before,
        after,
        bodyId: resultId,
        fillet4Id
      } = await besideFillet(fused.document, fused.bodyId, 1);
      // Hash-only: no band carries a name to tell it apart.
      expect(blends(after).every((face) => face.reference === undefined)).toBe(
        true
      );
      // Fillet 4 trimmed Fillet 3's band, which came back under a new hash.
      const earlier = blends(before);
      expect(earlier).toHaveLength(1);
      expect(after.some((face) => face.hash === earlier[0]!.hash)).toBe(false);
      const pick = newBlendFacePick(resultId, before, after, fillet4Id);
      const picked = after.find((face) => face.hash === pick?.selection.hash);
      expect(picked?.geometry?.blendRadius).toBe(1);
    });
  }
);
