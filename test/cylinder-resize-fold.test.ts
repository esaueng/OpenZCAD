/**
 * Which history step a second radius drag rewrites, on exact rebuilds.
 *
 * `cylinderResizeFold` rewrites the history tip's resize instead of
 * appending one only when the held wall is the face that resize targeted.
 * Two invented fixtures pin the edges of that rule:
 *
 * - a tube far from the origin, whose outer wall shares the bore's axis and
 *   span and sits 0.05 mm from the bore's resized radius: a drag on the outer
 *   wall must never rewrite the bore's resize;
 * - a plate with a chamfered bore, resized by an older pick that stored no
 *   face reference: the resize re-trims the bore's span against the
 *   chamfers, and a repeat drag of the same bore must still fold.
 *
 * The sibling-patch case (coaxial patches split by slots) lives in
 * `repeated-curved-patches.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  directEditBody,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FaceTopology,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import {
  cylinderResizeFold,
  type HeldCylinderWall
} from '../apps/web/src/lib/interaction/cylinderResizeFold';

function builder(title: string) {
  let document = createProjectDocument(title, toUserId('user_resize_fold'));
  const place = (
    name: string,
    dimensions: Record<string, number>,
    primitiveKind: 'box' | 'cylinder',
    translation: Vector3
  ): BodyId => {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind,
      dimensions
    });
    const id = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: `Place ${name}`,
      targetBodyId: id,
      translation
    }).document;
    return id;
  };
  const subtract = (name: string, targetBodyIds: BodyId[]): BodyId => {
    const result = booleanBodies(document, {
      name,
      operation: 'subtract',
      targetBodyIds
    });
    document = result.document;
    return result.bodyId;
  };
  return {
    place,
    subtract,
    get document() {
      return document;
    },
    set document(next: ProjectDocument) {
      document = next;
    }
  };
}

function wallAt(body: BodyRepresentation, radius: number): FaceTopology {
  const found = body.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs(face.geometry.radius! - radius) < 1e-9
  );
  expect(found, `one wall at R${radius}`).toHaveLength(1);
  return found[0]!;
}

const held = (
  bodyId: BodyId,
  face: FaceTopology,
  concavity: 'hole' | 'boss'
): HeldCylinderWall => ({
  bodyId,
  radius: face.geometry!.radius!,
  axisStart: face.geometry!.axisStart!,
  axisEnd: face.geometry!.axisEnd!,
  concavity,
  ...(face.reference ? { reference: face.reference } : {})
});

/** The radius drag's through-hole edit, as an older pick stored it. */
function resizeHole(
  document: ProjectDocument,
  bodyId: BodyId,
  face: FaceTopology,
  diameter: number,
  withReference: boolean
) {
  const g = face.geometry!;
  return directEditBody(document, {
    name: 'Resize Through Hole',
    targetBodyId: bodyId,
    operation: {
      kind: 'resize-through-hole',
      faceHash: face.hash,
      ...(withReference && face.reference
        ? { faceReference: face.reference }
        : {}),
      sourceDiameter: g.radius! * 2,
      sourceAxisStart: g.axisStart!,
      sourceAxisEnd: g.axisEnd!,
      diameter
    }
  }).document;
}

describe('cylinder resize fold on exact rebuilds', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter.dispose());

  describe('a tube far from the origin', () => {
    const X = 100_000;
    let document: ProjectDocument;
    let bodyId: BodyId;
    let body: BodyRepresentation;
    beforeAll(async () => {
      const b = builder('Far tube');
      const outer = b.place('Tube', { radius: 5, height: 10 }, 'cylinder', {
        x: X,
        y: 0,
        z: 0
      });
      const bore = b.place('Bore', { radius: 4, height: 12 }, 'cylinder', {
        x: X,
        y: 0,
        z: -1
      });
      bodyId = b.subtract('Drill', [outer, bore]);
      const base = await adapter.syncDocument(b.document);
      expect(base.warnings).toEqual([]);
      const hole = wallAt(base.bodyRepresentations[bodyId]!, 4);
      expect(hole.geometry!.featureType).toBe('through-hole');
      document = resizeHole(b.document, bodyId, hole, 9.9, true);
      const built = await adapter.syncDocument(document);
      expect(built.warnings).toEqual([]);
      body = built.bodyRepresentations[bodyId]!;
      // The resize built: the bore at R4.95 inside the untouched R5 wall,
      // on the same axis and over the same span.
      wallAt(body, 4.95);
      wallAt(body, 5);
    });

    it('never folds an outer-wall drag into the bore resize', () => {
      expect(
        cylinderResizeFold(
          document,
          held(bodyId, wallAt(body, 5), 'boss'),
          4.975
        )
      ).toBeNull();
    });

    it('still folds a repeat drag of the bore', () => {
      const fold = cylinderResizeFold(
        document,
        held(bodyId, wallAt(body, 4.95), 'hole'),
        4.5
      );
      expect(fold?.featureId).toBe(document.featureOrder.at(-1));
      expect(fold?.operation).toMatchObject({ diameter: 9 });
    });
  });

  describe.each([
    ['without', false],
    ['with', true]
  ] as const)(
    'a chamfered bore resized %s a stored face reference',
    (_label, withReference) => {
      let document: ProjectDocument;
      let bodyId: BodyId;
      let source: FaceTopology;
      let resized: FaceTopology;
      beforeAll(async () => {
        const b = builder('Chamfered plate');
        const plate = b.place(
          'Plate',
          { width: 20, height: 20, depth: 10 },
          'box',
          { x: -10, y: -10, z: 0 }
        );
        const bore = b.place('Bore', { radius: 3, height: 12 }, 'cylinder', {
          x: 0,
          y: 0,
          z: -1
        });
        const drilled = b.subtract('Drill', [plate, bore]);
        const drilledBuild = await adapter.syncDocument(b.document);
        const drilledBody = drilledBuild.bodyRepresentations[drilled]!;
        const wall = wallAt(drilledBody, 3);
        const mouths = drilledBody.topology!.edges.filter((edge) => {
          const faces = edge.adjacentFaceHashes ?? [];
          return (
            faces.includes(wall.hash) && faces.some((h) => h !== wall.hash)
          );
        });
        expect(mouths).toHaveLength(2);
        const chamfered = chamferEdges(b.document, {
          name: 'Chamfer mouths',
          targetBodyId: drilled,
          edgeHashes: mouths.map((edge) => edge.hash),
          size: 1
        });
        bodyId = chamfered.bodyId;
        const base = await adapter.syncDocument(chamfered.document);
        expect(base.warnings).toEqual([]);
        source = wallAt(base.bodyRepresentations[bodyId]!, 3);
        expect(source.geometry!.featureType).toBe('through-hole');
        expect(source.geometry!.axialLength).toBeCloseTo(8, 9);
        document = resizeHole(
          { ...chamfered.document, derived: base },
          bodyId,
          source,
          4.2,
          withReference
        );
        const built = await adapter.syncDocument(document);
        expect(built.warnings).toEqual([]);
        resized = wallAt(built.bodyRepresentations[bodyId]!, 2.1);
      });

      it('re-trims the bore against the chamfers', () => {
        // The resize itself moves the wall's ends: its span no longer
        // matches the one the edit recorded.
        expect(resized.geometry!.axialLength).toBeCloseTo(6.2, 6);
      });

      it('folds a repeat drag of the same bore', () => {
        const fold = cylinderResizeFold(
          document,
          held(bodyId, resized, 'hole'),
          2.5
        );
        expect(fold?.featureId).toBe(document.featureOrder.at(-1));
        expect(fold?.operation).toMatchObject({
          kind: 'resize-through-hole',
          faceHash: source.hash,
          diameter: 5
        });
      });
    }
  );
});
