import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  updateSketchObject
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  DerivedState,
  EntityId,
  FaceTopology,
  ProjectDocument,
  SketchObjectData
} from '@openzcad/shared';

/**
 * Every extrude the app makes goes through the region path: the drag rig and
 * the Extrude form both store `profiles`. Until these tests existed that path
 * named only the two caps, so every side wall of a drag-extruded plate was
 * hash-only and refused a sketch. These pin the side-wall lineage and the
 * thing it exists for — a sketch attached to a side wall surviving an edit of
 * the sketch that drew it.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

function regionExtrudeDocument(
  objects: SketchObjectData[],
  distance = 22
): {
  document: ProjectDocument;
  bodyId: BodyId;
  sketchId: ReturnType<typeof addSketchFeature>['sketchId'];
  objectIds: EntityId[];
} {
  const base = createProjectDocument(
    'Region lineage',
    toUserId('user_region_lineage')
  );
  const { document: withSketch, sketchId } = addSketchFeature(base, {
    name: 'Sketch 01',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects
  });
  const objectIds = [...(findSketch(withSketch, sketchId)?.objectIds ?? [])];
  const { document, bodyId } = extrudeSketch(withSketch, {
    name: 'Extrude',
    sketchId,
    distance,
    operation: 'new-body',
    // The drag path stores an entity-wide reference for a region bounded by
    // whole objects; that is the shape every UI extrude carries.
    profiles: [{ all: true, sourceEntityIds: objectIds }]
  });
  return { document, bodyId, sketchId, objectIds };
}

function facesOf(derived: DerivedState, bodyId: BodyId): FaceTopology[] {
  const body = derived.bodyRepresentations[bodyId];
  expect(body, 'extrusion body').toBeDefined();
  return body!.topology!.faces;
}

function faceWithNormal(
  faces: readonly FaceTopology[],
  normal: { x: number; y: number; z: number }
): FaceTopology {
  const match = faces.find((face) => {
    const n = face.geometry?.normal;
    return (
      face.geometry?.surfaceType === 'plane' &&
      n !== undefined &&
      Math.abs(n.x - normal.x) < 1e-6 &&
      Math.abs(n.y - normal.y) < 1e-6 &&
      Math.abs(n.z - normal.z) < 1e-6
    );
  });
  expect(match, `face with normal ${JSON.stringify(normal)}`).toBeDefined();
  return match!;
}

const rectangle: SketchObjectData = {
  objectKind: 'rectangle',
  width: 40,
  height: 10,
  centerX: 20,
  centerY: 5
};

// The 2-core CI runners rebuild these solids several times slower than a
// workstation; the budget is per test, not per file.
describe('region extrude lineage', { timeout: 120_000 }, () => {
  it('names every side wall of a rectangle region after its source segment', async () => {
    const { document, bodyId, objectIds } = regionExtrudeDocument([rectangle]);
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const faces = facesOf(derived, bodyId);
    expect(faces).toHaveLength(6);

    for (const face of faces) {
      expect(face.reference?.kind, face.topologyId).toBe('face');
      expect(face.reference?.currentHash).toBe(face.hash);
    }
    const [rectangleId] = objectIds;
    const sideNames = faces
      .map((face) => face.reference!.lineageName)
      .filter((name) => name.includes('.side.'))
      .sort();
    expect(sideNames).toEqual(
      [0, 1, 2, 3].map(
        (index) =>
          `sweep.face.side.region.${rectangleId}.${rectangleId}.${index}`
      )
    );
    expect(
      faces.map((face) => face.reference!.lineageName).filter((name) =>
        name.includes('.cap.')
      )
    ).toEqual(
      expect.arrayContaining([
        `sweep.face.cap.start.region.${rectangleId}`,
        `sweep.face.cap.end.region.${rectangleId}`
      ])
    );
  });

  it('keeps a side wall\'s name when the rectangle that drew it is resized', async () => {
    const { document, bodyId, sketchId, objectIds } =
      regionExtrudeDocument([rectangle]);
    const before = await adapter.syncDocument(document);
    const frontBefore = faceWithNormal(facesOf(before, bodyId), {
      x: 0,
      y: -1,
      z: 0
    });

    const resized = updateSketchObject(document, {
      sketchId,
      objectId: objectIds[0]!,
      data: { ...rectangle, width: 64, centerX: 32 }
    });
    const after = await adapter.syncDocument(resized);
    expect(after.warnings).toEqual([]);
    const frontAfter = faceWithNormal(facesOf(after, bodyId), {
      x: 0,
      y: -1,
      z: 0
    });
    // The geometry changed, so the hash did; the name must not.
    expect(frontAfter.hash).not.toBe(frontBefore.hash);
    expect(frontAfter.reference?.lineageName).toBe(
      frontBefore.reference?.lineageName
    );
    expect(frontAfter.reference?.currentHash).toBe(frontAfter.hash);
  });

  it('rebuilds a sketch attached to a side wall after the source rectangle changes', async () => {
    const { document, bodyId, sketchId, objectIds } =
      regionExtrudeDocument([rectangle]);
    const derived = await adapter.syncDocument(document);
    const front = faceWithNormal(facesOf(derived, bodyId), {
      x: 0,
      y: -1,
      z: 0
    });
    const geometry = front.geometry!;
    expect(front.reference?.kind).toBe('face');

    const { document: withAttached, sketchId: attachedSketchId } =
      addSketchFeature(
        { ...document, derived },
        {
          name: 'Front attachment',
          planeRef: {
            type: 'face',
            bodyId,
            faceHash: front.hash,
            faceReference:
              front.reference?.kind === 'face' ? front.reference : undefined,
            sourceArea: geometry.area,
            sourceCenter: geometry.center,
            sourceNormal: geometry.normal!,
            frame: {
              origin: geometry.centroid ?? geometry.center,
              xAxis: { x: 1, y: 0, z: 0 },
              yAxis: { x: 0, y: 0, z: 1 },
              zAxis: geometry.normal!
            }
          },
          objects: [
            {
              objectKind: 'rectangle',
              width: 6,
              height: 4,
              centerX: 0,
              centerY: 0
            }
          ]
        }
      );
    const { document: bossed, bodyId: bossId } = extrudeSketch(withAttached, {
      name: 'Front boss',
      sketchId: attachedSketchId,
      distance: 3
    });
    const built = await adapter.syncDocument(bossed);
    expect(built.warnings).toEqual([]);
    expect(built.bodyRepresentations[bossId]).toBeDefined();

    // Widen the plate the sketch hangs off: the wall is a different face now
    // (new hash), and the attached sketch has to find it again by name.
    const widened = updateSketchObject(bossed, {
      sketchId,
      objectId: objectIds[0]!,
      data: { ...rectangle, width: 64, centerX: 32 }
    });
    const rebuilt = await adapter.syncDocument(widened);
    expect(rebuilt.warnings).toEqual([]);
    const boss = rebuilt.bodyRepresentations[bossId];
    expect(boss).toBeDefined();
    // The boss still stands on the front wall (y = 0), grown outward to y = −3.
    expect(boss!.bbox.min.y).toBeCloseTo(-3, 5);
    expect(boss!.bbox.max.y).toBeCloseTo(0, 5);
  });

  it('names the wall of a circular region after the circle', async () => {
    const circle: SketchObjectData = {
      objectKind: 'circle',
      radius: 6,
      centerX: 0,
      centerY: 0
    };
    const { document, bodyId, objectIds } = regionExtrudeDocument([circle], 9);
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const faces = facesOf(derived, bodyId);
    const wall = faces.find((face) => face.geometry?.surfaceType === 'cylinder');
    expect(wall).toBeDefined();
    expect(wall!.reference?.lineageName).toBe(
      `sweep.face.side.region.${objectIds[0]}.${objectIds[0]}.circle`
    );
    expect(wall!.reference?.currentHash).toBe(wall!.hash);
  });

  it('names merged-region walls by their own objects and leaves a split side hash-only', async () => {
    // B stands on A and pokes through its top: the union outline has eight
    // walls. Six are whole rectangle sides; A's top side is cut into two
    // pieces by B, and two pieces of one segment cannot share one name.
    const second: SketchObjectData = {
      objectKind: 'rectangle',
      width: 10,
      height: 20,
      centerX: 30,
      centerY: 15
    };
    const { document, bodyId, objectIds } = regionExtrudeDocument([
      rectangle,
      second
    ]);
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const faces = facesOf(derived, bodyId);
    const walls = faces.filter(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.normal?.z ?? 0) < 1e-6
    );
    expect(walls).toHaveLength(8);

    const named = walls.filter((face) => face.reference !== undefined);
    const unnamed = walls.filter((face) => face.reference === undefined);
    expect(named).toHaveLength(6);
    expect(unnamed).toHaveLength(2);
    // The two unnamed pieces are both on A's top edge (the plane y = 10).
    for (const face of unnamed) {
      expect(face.geometry?.normal?.y).toBeCloseTo(1, 6);
      expect(face.geometry?.center.y).toBeCloseTo(10, 6);
    }
    const token = [...objectIds].sort().join('+');
    const names = named.map((face) => face.reference!.lineageName);
    expect(new Set(names).size).toBe(6);
    for (const name of names) {
      expect(
        objectIds.some((objectId) =>
          name.startsWith(`sweep.face.side.region.${token}.${objectId}.`)
        ),
        name
      ).toBe(true);
    }
  });
});
