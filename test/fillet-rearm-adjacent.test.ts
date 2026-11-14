import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
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
 * whose bands carry names and on a shelled box whose faces are hash-only.
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

    it('never picks the earlier band on a hash-only shelled box', async () => {
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
      // Hash-only: the bands carry no name to tell them apart.
      expect(blends(after).every((face) => face.reference === undefined)).toBe(
        true
      );
      const pick = newBlendFacePick(resultId, before, after, fillet4Id);
      const picked = after.find((face) => face.hash === pick?.selection.hash);
      // Whatever is re-armed, it is not Fillet 3's R3 band.
      expect(picked?.geometry?.blendRadius ?? 1).toBe(1);
    });
  }
);
