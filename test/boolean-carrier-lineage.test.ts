import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  listFeaturesInOrder,
  updateFeature
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
 * Boolean results used to republish every face hash-only, so a boss grown
 * onto a plate cost the whole body its identity — nothing could be sketched
 * on the boss, nor on the plate beside it. These pin the carrier-derived
 * subset ADR-013 allows: a result face inherits an operand face's name when
 * both are the only faces on one quantized plane or cylinder, and nothing is
 * guessed when a carrier is shared or split.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const user = toUserId('user_boolean_lineage');
const WIDTH = 40;
const HEIGHT = 24;
const DEPTH = 10;

function facesOf(derived: DerivedState, bodyId: BodyId): FaceTopology[] {
  const body = derived.bodyRepresentations[bodyId];
  expect(body, 'result body').toBeDefined();
  return body!.topology!.faces;
}

function planarFace(
  faces: readonly FaceTopology[],
  normal: { x: number; y: number; z: number },
  offset: number
): FaceTopology[] {
  return faces.filter((face) => {
    const n = face.geometry?.normal;
    const c = face.geometry?.center;
    if (face.geometry?.surfaceType !== 'plane' || !n || !c) {
      return false;
    }
    const aligned =
      Math.abs(n.x - normal.x) < 1e-6 &&
      Math.abs(n.y - normal.y) < 1e-6 &&
      Math.abs(n.z - normal.z) < 1e-6;
    const along = c.x * normal.x + c.y * normal.y + c.z * normal.z;
    return aligned && Math.abs(along - offset) < 1e-6;
  });
}

function plateDocument(width = WIDTH): {
  document: ProjectDocument;
  plateId: BodyId;
} {
  const document = addPrimitiveFeature(
    createProjectDocument('Boolean lineage', user),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width, height: HEIGHT, depth: DEPTH }
    }
  );
  return { document, plateId: document.bodyOrder[0]! };
}

/** A rectangle drawn on the plate's top plane, extruded as the given op. */
function toolOnTop(
  base: ProjectDocument,
  plateId: BodyId,
  rectangle: SketchObjectData,
  distance: number,
  operation: 'add' | 'cut'
): { document: ProjectDocument; bodyId: BodyId; objectIds: EntityId[] } {
  const { document: withSketch, sketchId } = addSketchFeature(base, {
    name: 'Top sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset: DEPTH },
    objects: [rectangle]
  });
  const objectIds = [...(findSketch(withSketch, sketchId)?.objectIds ?? [])];
  const { document, bodyId } = extrudeSketch(withSketch, {
    name: operation === 'add' ? 'Boss' : 'Pocket',
    sketchId,
    distance,
    operation,
    targetBodyId: plateId,
    profiles: [{ all: true, sourceEntityIds: objectIds }]
  });
  return { document, bodyId, objectIds };
}

const boss: SketchObjectData = {
  objectKind: 'rectangle',
  width: 10,
  height: 6,
  centerX: 20,
  centerY: 12
};

// The 2-core CI runners rebuild these solids several times slower than a
// workstation; the budget is per test, not per file.
describe('boolean carrier lineage', { timeout: 120_000 }, () => {
  it('keeps the plate and the boss named through an add extrude', async () => {
    const { document: base, plateId } = plateDocument();
    const { document, bodyId } = toolOnTop(base, plateId, boss, 8, 'add');
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const faces = facesOf(derived, bodyId);
    // Six plate faces plus the boss's cap and four walls; the plate's top
    // carries the boss's footprint as an inner loop but stays one face.
    expect(faces).toHaveLength(11);
    const unnamed = faces.filter((face) => face.reference === undefined);
    expect(unnamed.map((face) => face.geometry?.normal)).toEqual([]);
    for (const face of faces) {
      expect(face.reference?.currentHash).toBe(face.hash);
    }
    // Names carry the operand's slot in the command, never a document id:
    // the same history rebuilt in another document reads the same.
    const [top] = planarFace(faces, { x: 0, y: 0, z: 1 }, DEPTH);
    expect(top?.reference?.lineageName).toBe(
      'boolean.face.target.primitive.box.face.z-max'
    );
    const [cap] = planarFace(faces, { x: 0, y: 0, z: 1 }, DEPTH + 8);
    expect(cap?.reference?.lineageName).toMatch(
      /^boolean\.face\.tool\.sweep\.face\.cap\.end\.region\./
    );
    const [wall] = planarFace(faces, { x: 0, y: -1, z: 0 }, -9);
    expect(wall?.reference?.lineageName).toMatch(
      /^boolean\.face\.tool\.sweep\.face\.side\.region\./
    );
  });

  it('names a pocket floor and its walls through a cut extrude', async () => {
    const { document: base, plateId } = plateDocument();
    const { document, bodyId } = toolOnTop(base, plateId, boss, -4, 'cut');
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const faces = facesOf(derived, bodyId);
    expect(faces).toHaveLength(11);
    expect(faces.filter((face) => face.reference === undefined)).toEqual([]);
    const [floor] = planarFace(faces, { x: 0, y: 0, z: 1 }, DEPTH - 4);
    expect(floor?.reference?.lineageName).toMatch(
      /\.sweep\.face\.cap\.end\.region\./
    );
  });

  it('carries a sketch on the boss cap through a resize of the plate', async () => {
    const { document: base, plateId } = plateDocument();
    const { document, bodyId } = toolOnTop(base, plateId, boss, 8, 'add');
    const derived = await adapter.syncDocument(document);
    const [cap] = planarFace(facesOf(derived, bodyId), { x: 0, y: 0, z: 1 }, DEPTH + 8);
    expect(cap?.reference?.kind).toBe('face');
    const geometry = cap!.geometry!;

    const { document: withAttached, sketchId } = addSketchFeature(
      { ...document, derived },
      {
        name: 'On the boss',
        planeRef: {
          type: 'face',
          bodyId,
          faceHash: cap!.hash,
          faceReference:
            cap!.reference?.kind === 'face' ? cap!.reference : undefined,
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal!,
          frame: {
            origin: geometry.centroid ?? geometry.center,
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: geometry.normal!
          }
        },
        objects: [
          { objectKind: 'circle', radius: 2, centerX: 0, centerY: 0 }
        ]
      }
    );
    const { document: pinned, bodyId: pinId } = extrudeSketch(withAttached, {
      name: 'Pin',
      sketchId,
      distance: 3
    });
    const built = await adapter.syncDocument(pinned);
    expect(built.warnings).toEqual([]);
    expect(built.bodyRepresentations[pinId]).toBeDefined();

    // Widen the plate underneath: the boss cap is a new face (new hash) on
    // the same carrier, and the attached sketch has to find it by name.
    const plate = listFeaturesInOrder(pinned).find(
      (feature) => feature.name === 'Plate'
    )!;
    const widened = updateFeature(pinned, {
      featureId: plate.featureId,
      data: { dimensions: { width: 50, height: HEIGHT, depth: DEPTH } }
    });
    const rebuilt = await adapter.syncDocument(widened);
    expect(rebuilt.warnings).toEqual([]);
    const pin = rebuilt.bodyRepresentations[pinId];
    expect(pin).toBeDefined();
    expect(pin!.bbox.min.z).toBeCloseTo(DEPTH + 8, 5);
    expect(pin!.bbox.max.z).toBeCloseTo(DEPTH + 8 + 3, 5);
  });

  it('leaves a top face split by a slot hash-only, and names the slot walls', async () => {
    const { document: base, plateId } = plateDocument();
    const slot: SketchObjectData = {
      objectKind: 'rectangle',
      width: 6,
      height: HEIGHT + 4,
      centerX: 20,
      centerY: HEIGHT / 2
    };
    const { document, bodyId } = toolOnTop(base, plateId, slot, -DEPTH, 'cut');
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const faces = facesOf(derived, bodyId);
    const tops = planarFace(faces, { x: 0, y: 0, z: 1 }, DEPTH);
    expect(tops).toHaveLength(2);
    // Two result faces on one carrier: no guess about which is which.
    expect(tops.map((face) => face.reference)).toEqual([undefined, undefined]);
    const bottoms = planarFace(faces, { x: 0, y: 0, z: -1 }, 0);
    expect(bottoms).toHaveLength(2);
    expect(bottoms.map((face) => face.reference)).toEqual([undefined, undefined]);
    // The slot's own walls come from the tool and are unique.
    const [wall] = planarFace(faces, { x: 1, y: 0, z: 0 }, 17);
    expect(wall?.reference?.lineageName).toMatch(/\.sweep\.face\.side\.region\./);
    const [end] = planarFace(faces, { x: 1, y: 0, z: 0 }, WIDTH);
    expect(end?.reference?.lineageName).toMatch(/primitive\.box\.face\.x-max$/);
  });

  it('names a union where carriers are unique and refuses where they are shared', async () => {
    const { document: withPlate, plateId } = plateDocument();
    const document = addPrimitiveFeature(withPlate, {
      name: 'Post',
      primitiveKind: 'box',
      dimensions: { width: 12, height: HEIGHT, depth: 30 }
    });
    const postId = document.bodyOrder[1]!;
    const { document: fused, bodyId } = booleanBodies(document, {
      name: 'Fuse',
      operation: 'union',
      targetBodyIds: [plateId, postId]
    });
    const derived = await adapter.syncDocument(fused);
    expect(derived.warnings).toEqual([]);
    const faces = facesOf(derived, bodyId);
    // Unique carriers: the plate's far end, the post's top.
    const [plateEnd] = planarFace(faces, { x: 1, y: 0, z: 0 }, WIDTH);
    expect(plateEnd?.reference?.lineageName).toBe(
      'boolean.face.operand.0.primitive.box.face.x-max'
    );
    const [postTop] = planarFace(faces, { x: 0, y: 0, z: 1 }, 30);
    expect(postTop?.reference?.lineageName).toBe(
      'boolean.face.operand.1.primitive.box.face.z-max'
    );
    // Shared carriers: both boxes stand on y = 0 and on z = 0, so the fused
    // faces there have two named sources and get no name.
    const [front] = planarFace(faces, { x: 0, y: -1, z: 0 }, 0);
    expect(front).toBeDefined();
    expect(front!.reference).toBeUndefined();
    const [bottom] = planarFace(faces, { x: 0, y: 0, z: -1 }, 0);
    expect(bottom).toBeDefined();
    expect(bottom!.reference).toBeUndefined();
  });
});
