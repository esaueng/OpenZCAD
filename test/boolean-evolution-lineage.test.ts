import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  listFeaturesInOrder,
  transformBody,
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
  EdgeTopology,
  FaceTopology,
  ProjectDocument,
  SketchObjectData
} from '@openzcad/shared';

/**
 * Roadmap K05. The analytic-carrier rule can only name a boolean result face
 * when its quantized plane or cylinder holds exactly one named operand face
 * and exactly one result face. Two bosses of the same height break both
 * halves of that at once — their caps share a plane, and that plane carries
 * two result faces — so before this row a sketch pinned to either cap lost
 * its name and fell back to the ADR-011 hash, which an upstream edit changes.
 *
 * The kernel's boolean entity evolution names the operand face every result
 * face came from, so both caps keep their identity. These pin that, and pin
 * the cases where the kernel declines and the fallback must stay hash-only.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const user = toUserId('user_boolean_evolution');
const WIDTH = 40;
const HEIGHT = 24;
const DEPTH = 10;
const BOSS_HEIGHT = 8;

function facesOf(derived: DerivedState, bodyId: BodyId): FaceTopology[] {
  const body = derived.bodyRepresentations[bodyId];
  expect(body, 'result body').toBeDefined();
  return body!.topology!.faces;
}

function edgesOf(derived: DerivedState, bodyId: BodyId): EdgeTopology[] {
  return derived.bodyRepresentations[bodyId]?.topology?.edges ?? [];
}

function capAt(faces: readonly FaceTopology[], x: number): FaceTopology {
  const match = faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      Math.abs((face.geometry.normal?.z ?? 0) - 1) < 1e-9 &&
      Math.abs(face.geometry.center.z - (DEPTH + BOSS_HEIGHT)) < 1e-9 &&
      Math.abs(face.geometry.center.x - x) < 1e-6
  );
  expect(match, `one cap at x = ${x}`).toHaveLength(1);
  return match[0]!;
}

/** A plate carrying two bosses of equal height, grown by two add extrudes. */
function twoBossPlate(width = WIDTH): {
  document: ProjectDocument;
  bodyId: BodyId;
} {
  let document = addPrimitiveFeature(
    createProjectDocument('Boolean evolution', user),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width, height: HEIGHT, depth: DEPTH }
    }
  );
  let bodyId = document.bodyOrder[0]!;
  for (const [index, centerX] of [10, 30].entries()) {
    const circle: SketchObjectData = {
      objectKind: 'circle',
      radius: 4,
      centerX,
      centerY: HEIGHT / 2
    };
    const { document: withSketch, sketchId } = addSketchFeature(document, {
      name: `Boss sketch ${index}`,
      planeRef: { type: 'canonical', plane: 'XY', offset: DEPTH },
      objects: [circle]
    });
    const objectIds = [...(findSketch(withSketch, sketchId)?.objectIds ?? [])];
    const grown = extrudeSketch(withSketch, {
      name: `Boss ${index}`,
      sketchId,
      distance: BOSS_HEIGHT,
      operation: 'add',
      targetBodyId: bodyId,
      profiles: [{ all: true, sourceEntityIds: objectIds }]
    });
    document = grown.document;
    bodyId = grown.bodyId;
  }
  return { document, bodyId };
}

describe('boolean entity-evolution lineage', { timeout: 120_000 }, () => {
  it('names both caps of two equal-height bosses, and their plate', async () => {
    const { document, bodyId } = twoBossPlate();
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const faces = facesOf(derived, bodyId);
    const left = capAt(faces, 10);
    const right = capAt(faces, 30);
    expect(left.reference?.lineageName).toBeDefined();
    expect(right.reference?.lineageName).toBeDefined();
    // Two names, not one guessed twice.
    expect(left.reference!.lineageName).not.toBe(right.reference!.lineageName);
    for (const face of faces) {
      if (face.reference) {
        expect(face.reference.currentHash).toBe(face.hash);
      }
    }
    // Neither derivation contradicted the other anywhere on this body.
    expect(
      (
        derived.bodyRepresentations[bodyId]?.topology?.lineageDiagnostics ?? []
      ).filter((entry) =>
        /the analytic carrier rule named it/.test(entry.message)
      )
    ).toEqual([]);
  });

  it('carries a sketch on one of two identical bosses through a plate resize', async () => {
    const { document, bodyId } = twoBossPlate();
    const derived = await adapter.syncDocument(document);
    const cap = capAt(facesOf(derived, bodyId), 10);
    const geometry = cap.geometry!;
    expect(cap.reference?.kind).toBe('face');

    const { document: withAttached, sketchId } = addSketchFeature(
      { ...document, derived },
      {
        name: 'On the left boss',
        planeRef: {
          type: 'face',
          bodyId,
          faceHash: cap.hash,
          faceReference:
            cap.reference?.kind === 'face' ? cap.reference : undefined,
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
        objects: [{ objectKind: 'circle', radius: 1.5, centerX: 0, centerY: 0 }]
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

    // The upstream edit this row exists for: widen the plate underneath. The
    // left boss does not move, but the body it lives on is rebuilt from
    // scratch and its faces are new handles with new hashes.
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
    // Still standing on the left boss, not moved to the right one and not
    // dropped onto the plate.
    expect(pin!.bbox.min.z).toBeCloseTo(DEPTH + BOSS_HEIGHT, 5);
    expect(pin!.bbox.max.z).toBeCloseTo(DEPTH + BOSS_HEIGHT + 3, 5);
    expect((pin!.bbox.min.x + pin!.bbox.max.x) / 2).toBeCloseTo(10, 5);
  });

  it('keeps the plain fuse where the evolution fuse would leave false seams', async () => {
    // `fuseWithEntityEvolution` publishes the raw fragment layout so its
    // evolution map can address it. On two boxes with identical flush
    // cross-sections that layout is ten faces where plain `fuse` returns six,
    // and unification closes the face count but leaves four redundant seam
    // edges behind. Those are four false edges in the shaded-with-edges
    // viewport, so the union has to come back as the plain fuse built it and
    // give up its evolution lineage to do so.
    let document = addPrimitiveFeature(
      createProjectDocument('Stacked union', user),
      {
        name: 'Lower',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      }
    );
    document = addPrimitiveFeature(document, {
      name: 'Upper',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    const lowerId = document.bodyOrder[0]!;
    const upperId = document.bodyOrder[1]!;
    document = transformBody(document, {
      name: 'Lift upper',
      targetBodyId: upperId,
      translation: { x: 0, y: 0, z: 10 }
    }).document;
    const { document: fused, bodyId } = booleanBodies(document, {
      name: 'Stack',
      operation: 'union',
      targetBodyIds: [lowerId, upperId]
    });
    const derived = await adapter.syncDocument(fused);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId];
    expect(body?.volume).toBeCloseTo(20 * 20 * 20, 6);
    expect(body?.faceCount).toBe(6);
    expect(body?.topology?.edges).toHaveLength(12);
  });

  it('carries an untouched edge through a cut and leaves the cut edges alone', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Edge evolution', user),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: WIDTH, height: HEIGHT, depth: DEPTH }
      }
    );
    const plateId = document.bodyOrder[0]!;
    const { document: withSketch, sketchId } = addSketchFeature(document, {
      name: 'Pocket sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: DEPTH },
      objects: [
        {
          objectKind: 'rectangle',
          width: 10,
          height: 6,
          centerX: 20,
          centerY: HEIGHT / 2
        }
      ]
    });
    const objectIds = [...(findSketch(withSketch, sketchId)?.objectIds ?? [])];
    const { document: pocketed, bodyId } = extrudeSketch(withSketch, {
      name: 'Pocket',
      sketchId,
      distance: -4,
      operation: 'cut',
      targetBodyId: plateId,
      profiles: [{ all: true, sourceEntityIds: objectIds }]
    });
    const derived = await adapter.syncDocument(pocketed);
    expect(derived.warnings).toEqual([]);
    const edges = edgesOf(derived, bodyId);
    const named = edges
      .map((edge) => edge.reference?.lineageName)
      .filter((name): name is string => name !== undefined);
    // The plate's own edges are nowhere near the pocket, so the kernel
    // preserves them and the exact witness agrees.
    expect(named.length).toBeGreaterThan(0);
    expect(
      named.every((name) =>
        name.startsWith('boolean.edge.target.primitive.box.edge.')
      )
    ).toBe(true);
    for (const edge of edges) {
      if (edge.reference) {
        expect(edge.reference.currentHash).toBe(edge.hash);
      }
    }
    // The pocket's own rim and floor edges are new: the kernel generates
    // them, and nothing guesses a name for them.
    expect(named.length).toBeLessThan(edges.length);
  });
});
