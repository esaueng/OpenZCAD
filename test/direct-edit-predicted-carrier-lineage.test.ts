/**
 * Face names across a wall resize that leaves no construction history.
 *
 * The public filleted union (box ∪ cylinder with its seam fillet) with the
 * cylinder's top rim rounded too. With that band in place the kernel journals
 * a boss-wall resize only by inference, which is not construction history
 * (ADR-013, M07), so the resize used to publish only the names whose exact
 * witness survived — the box top, re-trimmed by the wall, was not one of
 * them. A later push of the box top then held only its selection-time
 * witness, which any upstream edit invalidates: changing the seam fillet's
 * radius failed the push with "Direct-edit face is stale: The selected face
 * lineage no longer exists."
 *
 * Untouched faces keep their exact quantized carriers through the resize, so
 * their names now cross when that carrier is unique on both sides (ADR-013,
 * H01/M07 predicted-carrier amendment).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  directEditBody,
  filletEdges,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type {
  BodyId,
  BodyRepresentation,
  FaceTopology,
  ProjectDocument
} from '@openzcad/shared';
import {
  JUNCTION_FILLET_DISCLOSURE,
  filletedUnion
} from './support/filleted-union';

const BOX_TOP = 'boolean.face.operand.1.primitive.box.face.z-max';
const PUSH = -3;

function named(body: BodyRepresentation, lineageName: string): FaceTopology {
  const faces = body.topology!.faces.filter(
    (face) => face.reference?.lineageName === lineageName
  );
  expect(faces, lineageName).toHaveLength(1);
  return faces[0]!;
}

function wallOf(body: BodyRepresentation, radius: number): FaceTopology {
  const walls = body.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs(face.geometry.radius! - radius) < 1e-9
  );
  expect(walls).toHaveLength(1);
  return walls[0]!;
}

function boxTop(body: BodyRepresentation): FaceTopology {
  // The largest upward plane: the box top, not the cylinder's own cap.
  return body
    .topology!.faces.filter(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal!.z > 1 - 1e-9
    )
    .sort((a, b) => b.geometry!.area - a.geometry!.area)[0]!;
}

describe(
  'direct-edit lineage by exact predicted carrier',
  { timeout: 240_000 },
  () => {
    let adapter: ExactKernelAdapter;
    let document: ProjectDocument;
    let bodyId: BodyId;
    let resized: BodyRepresentation;
    let topZ: number;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
      const model = await filletedUnion(adapter, {
        heightEdit: false,
        radius: 2
      });
      const faceName = (hash: number) =>
        model.body.topology!.faces.find((face) => face.hash === hash)?.reference
          ?.lineageName ?? '';
      const rim = model.body.topology!.edges.filter((edge) => {
        const names = (edge.adjacentFaceHashes ?? []).map(faceName);
        return (
          names.some((name) => name.endsWith('cylinder.face.wall')) &&
          names.some((name) => name.endsWith('cylinder.face.cap.end'))
        );
      });
      expect(rim.length).toBeGreaterThan(0);
      const rounded = filletEdges(model.document, {
        name: 'Rim fillet',
        targetBodyId: model.bodyId,
        edgeHashes: rim.map((edge) => edge.hash),
        size: 2
      });
      bodyId = rounded.bodyId;
      const derived = await adapter.syncDocument(rounded.document);
      expect(derived.warnings).toEqual([JUNCTION_FILLET_DISCLOSURE]);
      topZ = boxTop(derived.bodyRepresentations[bodyId]!).geometry!.center.z;
      const wall = wallOf(derived.bodyRepresentations[bodyId]!, 6);
      const g = wall.geometry!;
      document = directEditBody(rounded.document, {
        name: 'Resize Cylinder',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: wall.hash,
          ...(wall.reference ? { faceReference: wall.reference } : {}),
          sourceRadius: g.radius!,
          sourceAxisStart: g.axisStart!,
          sourceAxisEnd: g.axisEnd!,
          concavity: 'boss',
          radius: 4.75
        }
      }).document;
      const afterResize = await adapter.syncDocument(document);
      expect(afterResize.warnings).toEqual([JUNCTION_FILLET_DISCLOSURE]);
      resized = afterResize.bodyRepresentations[bodyId]!;
    }, 240_000);
    afterAll(() => adapter.dispose());

    it('keeps the re-trimmed box top’s name through the resize', () => {
      const top = named(resized, BOX_TOP);
      expect(top).toBe(boxTop(resized));
      expect(top.geometry!.center.z).toBeCloseTo(topZ, 9);
      const names = resized.topology!.faces.flatMap((face) =>
        face.reference ? [face.reference.lineageName] : []
      );
      expect(new Set(names).size).toBe(names.length);
    });

    it('replays a push of the box top by lineage after the seam fillet radius changes', async () => {
      const top = named(resized, BOX_TOP);
      const pushed = directEditBody(document, {
        name: 'Offset top',
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: top.hash,
          faceReference: top.reference!,
          sourceSurfaceType: 'plane',
          sourceArea: top.geometry!.area,
          sourceCenter: top.geometry!.center,
          sourceNormal: top.geometry!.normal!,
          offset: PUSH
        }
      }).document;
      const before = await adapter.syncDocument(pushed);
      expect(before.warnings).toEqual([JUNCTION_FILLET_DISCLOSURE]);
      expect(
        boxTop(before.bodyRepresentations[bodyId]!).geometry!.center.z
      ).toBeCloseTo(topZ + PUSH, 9);

      const seam = listFeaturesInOrder(pushed).find(
        (feature) => feature.name === 'Junction fillet'
      )!;
      const edited = updateFeature(pushed, {
        featureId: seam.featureId,
        data: { radius: 3 }
      });
      const replay = await adapter.syncDocument(edited);
      expect(replay.warnings).toEqual([JUNCTION_FILLET_DISCLOSURE]);
      const body = replay.bodyRepresentations[bodyId]!;
      wallOf(body, 4.75);
      expect(named(body, BOX_TOP).geometry!.center.z).toBeCloseTo(
        topZ + PUSH,
        9
      );
    });
  }
);
