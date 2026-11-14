import { beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumAxis,
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  filletEdges,
  findSketch,
  patternBody,
  transformBody
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import {
  fuseAllMergingFaceContacts,
  isFaceConnectedSolid
} from '../packages/kernel-adapter/src/exact-boolean-helpers';

/**
 * QA 2026-11-14 finding #1: a hub standing EXACTLY on a flange (a cylinder
 * whose base lies on another cylinder's top cap) united into a body that
 * still held both caps. The flange top read as the full Ø80 disc,
 * 5026.55 mm², instead of the 3769.91 mm² annulus around the hub; the hub's
 * base disc stayed inside the solid as a hidden wall. A fillet of the hub foot
 * then rounded the hub's own base rim convexly, removing material where a
 * concave blend adds it, and a later cut through the hub dropped the hub
 * entirely. Nothing warned: the body validated and its volume was the sum.
 *
 * The cause is the pinned Remus `fuseAll`, which joins groups it judges
 * disjoint without a boolean and misjudges cap-on-cap contact between two
 * cylinders. The pairwise `fuse` merges the same pair correctly, and the
 * union gate now refolds a result `fuseAll` left in pieces with it. The same
 * gate serves extrude Add, so a circular boss extruded from a cylinder's top
 * face had the identical defect.
 *
 * Every expectation is a closed form. The overlapping hub (base at z = 5) is
 * the control the QA pass used and was always correct.
 */

const FLANGE_R = 40;
const FLANGE_H = 10;
const HUB_R = 20;
const TOP = 40;
const ANNULUS = Math.PI * (FLANGE_R ** 2 - HUB_R ** 2);
const SOLID_VOLUME =
  Math.PI * FLANGE_R ** 2 * FLANGE_H + Math.PI * HUB_R ** 2 * (TOP - FLANGE_H);

/**
 * Material a concave fillet of radius `r` adds at the foot of a cylinder of
 * radius `R` standing on a plane: the spandrel r²(1 − π/4) swept round the
 * axis through its centroid, r(10 − 3π)/(12 − 3π) out from the wall.
 */
function concaveFootFillet(R: number, r: number): number {
  const area = r * r * (1 - Math.PI / 4);
  const centroid = (r * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI);
  return 2 * Math.PI * (R + centroid) * area;
}

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

function cylinder(
  document: ProjectDocument,
  name: string,
  radius: number,
  height: number,
  z: number,
  y = 0
): ProjectDocument {
  const placed = addPrimitiveFeature(document, {
    name,
    primitiveKind: 'cylinder',
    dimensions: { radius, height }
  });
  return z === 0 && y === 0
    ? placed
    : transformBody(placed, {
        name: `${name} move`,
        targetBodyId: last(placed),
        translation: { x: 0, y, z }
      }).document;
}

/** Flange r40 h10 united with a hub r20 reaching z = 40 from `hubBase`. */
function flangedHub(hubBase: number): ProjectDocument {
  let document = createProjectDocument('Hub', toUserId('user_touching'));
  document = cylinder(document, 'Flange', FLANGE_R, FLANGE_H, 0);
  const flange = last(document);
  document = cylinder(document, 'Hub', HUB_R, TOP - hubBase, hubBase);
  return booleanBodies(document, {
    name: 'Union',
    operation: 'union',
    targetBodyIds: [flange, last(document)]
  }).document;
}

function planarAreas(derived: DerivedState, bodyId: BodyId): number[] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
    (face) => face.geometry?.surfaceType === 'plane'
  )
    .map((face) => face.geometry!.area)
    .sort((left, right) => left - right);
}

describe('a cylinder standing exactly on another cylinder', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  it.each([
    ['touching', FLANGE_H],
    ['overlapping (control)', 5]
  ])(
    'unites into one solid with an annular flange top (%s)',
    async (_label, hubBase) => {
      const document = flangedHub(hubBase);
      const derived = await adapter.syncDocument(document);
      const body = derived.bodyRepresentations[last(document)]!;
      expect(derived.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(SOLID_VOLUME, 6);
      // Bottom disc, flange top annulus, hub top disc — and no full-disc
      // flange top or hub base left inside the solid.
      const planes = planarAreas(derived, last(document));
      expect(planes).toHaveLength(3);
      expect(planes[0]).toBeCloseTo(Math.PI * HUB_R ** 2, 6);
      expect(planes[1]).toBeCloseTo(ANNULUS, 6);
      expect(planes[2]).toBeCloseTo(Math.PI * FLANGE_R ** 2, 6);
      expect(body.topology!.faces).toHaveLength(5);
    },
    120_000
  );

  it.each([2, 5])(
    'fillets the hub foot as a concave blend that adds material (R%s)',
    async (radius) => {
      const document = flangedHub(FLANGE_H);
      const bodyId = last(document);
      const derived = await adapter.syncDocument(document);
      const foot = derived.bodyRepresentations[bodyId]!.topology!.edges.find(
        (edge) => {
          const circle =
            edge.curve?.type === 'CIRCLE' ? edge.curve.circle : undefined;
          return (
            circle !== undefined &&
            Math.abs(circle.radius - HUB_R) < 1e-9 &&
            Math.abs(circle.center.z - FLANGE_H) < 1e-9
          );
        }
      )!;
      expect(foot).toBeDefined();
      const filleted = filletEdges(document, {
        name: 'Foot fillet',
        targetBodyId: bodyId,
        edgeHashes: [foot.hash],
        ...(foot.reference ? { edgeReferences: [foot.reference] } : {}),
        size: radius
      }).document;
      const result = await adapter.syncDocument(filleted);
      expect(result.warnings).toEqual([]);
      // Before the fix: 87859.13 at R2 and 87328.05 at R5, i.e. material
      // removed by a convex round of the hub's base rim.
      expect(result.bodyRepresentations[last(filleted)]!.volume).toBeCloseTo(
        SOLID_VOLUME + concaveFootFillet(HUB_R, radius),
        3
      );
    },
    120_000
  );

  it('keeps the hub when a bore is cut through the united body', async () => {
    let document = flangedHub(FLANGE_H);
    const hub = last(document);
    document = cylinder(document, 'Bore', 10, 50, -5);
    document = booleanBodies(document, {
      name: 'Bore cut',
      operation: 'subtract',
      targetBodyIds: [hub, last(document)]
    }).document;
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    // Before the fix the cut silently dropped the whole hub: 46841.15.
    expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
      SOLID_VOLUME - Math.PI * 10 ** 2 * TOP,
      6
    );
  }, 120_000);

  it('merges a circular boss extruded onto a cylinder top face', async () => {
    let document = createProjectDocument('Boss', toUserId('user_touching'));
    document = cylinder(document, 'Flange', FLANGE_R, FLANGE_H, 0);
    const flange = last(document);
    const { document: sketched, sketchId } = addSketchFeature(document, {
      name: 'Top sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: FLANGE_H },
      objects: [{ objectKind: 'circle', radius: HUB_R, centerX: 0, centerY: 0 }]
    });
    const objectIds = [...(findSketch(sketched, sketchId)?.objectIds ?? [])];
    document = extrudeSketch(sketched, {
      name: 'Hub',
      sketchId,
      distance: TOP - FLANGE_H,
      operation: 'add',
      targetBodyId: flange,
      profiles: [{ all: true, sourceEntityIds: objectIds }]
    }).document;
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const planes = planarAreas(derived, last(document));
    expect(planes).toHaveLength(3);
    expect(planes[1]).toBeCloseTo(ANNULUS, 6);
  }, 120_000);

  it('folds only a fuseAll result left in pieces', () => {
    const kernel = new RemusKernel();
    const lifted = (solid: number, z: number) =>
      kernel.copyAndTransformSolid(
        solid,
        transformMatrix({ x: 0, y: 0, z }, { x: 0, y: 0, z: 0 })
      );
    const touching = [
      kernel.makeCylinder(FLANGE_R, FLANGE_H),
      lifted(kernel.makeCylinder(HUB_R, TOP - FLANGE_H), FLANGE_H)
    ];
    const merged = fuseAllMergingFaceContacts(kernel, touching);
    expect(isFaceConnectedSolid(kernel, merged)).toBe(true);
    expect(kernel.getSolidFaces(merged)).toHaveLength(5);

    // Genuinely apart: the fold cannot join them, so the result stays in
    // two pieces and the union keeps reporting a disconnected body.
    const apart = [
      kernel.makeCylinder(FLANGE_R, FLANGE_H),
      lifted(kernel.makeCylinder(HUB_R, TOP - FLANGE_H), FLANGE_H + 1)
    ];
    const disjoint = fuseAllMergingFaceContacts(kernel, apart);
    expect(isFaceConnectedSolid(kernel, disjoint)).toBe(false);
    expect(kernel.volume(disjoint, 0.01)).toBeCloseTo(
      Math.PI * FLANGE_R ** 2 * FLANGE_H +
        Math.PI * HUB_R ** 2 * (TOP - FLANGE_H),
      6
    );
  });
});

/**
 * QA 2026-11-14 finding #2 reported a ×4 circular pattern of Ø6 pins
 * subtracted from the flanged hub cutting one hole. It does not reproduce on
 * the stated geometry, about a world axis or about the bore's datum axis;
 * this pins the report's suggested regression — the removed volume is N holes.
 */
describe('a circular pattern of pins subtracted from a flange', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  it.each([
    ['world Z', 4],
    ['bore axis', 4],
    ['bore axis', 8]
  ] as const)(
    'cuts every hole about the %s (×%s)',
    async (about, count) => {
      let document = flangedHub(5);
      const hub = last(document);
      document = cylinder(document, 'Bore', 10, 50, -5);
      document = booleanBodies(document, {
        name: 'Bore cut',
        operation: 'subtract',
        targetBodyIds: [hub, last(document)]
      }).document;
      const bored = last(document);
      const built = await adapter.syncDocument(document);
      const bore = built.bodyRepresentations[bored]!.topology!.faces.find(
        (face) =>
          face.geometry?.surfaceType === 'cylinder' &&
          Math.abs(face.geometry.area - 2 * Math.PI * 10 * TOP) < 1e-6
      )!;
      expect(bore).toBeDefined();
      let axisRef: { type: 'datum-axis'; datumFeatureId: never } | undefined;
      if (about === 'bore axis') {
        const axis = addDatumAxis(document, {
          name: 'Bore axis',
          definition: {
            kind: 'cylinder',
            source: {
              type: 'face',
              bodyId: bored,
              faceReference: bore.reference!
            }
          }
        });
        document = axis.document;
        axisRef = {
          type: 'datum-axis',
          datumFeatureId: axis.featureId as never
        };
      }
      document = cylinder(document, 'Pin', 3, 20, -5, 31);
      document = patternBody(document, {
        name: 'Bolt circle',
        patternKind: 'circular',
        targetBodyId: last(document),
        axis: 'z',
        count,
        angleDeg: 360,
        ...(axisRef ? { axisRef } : {})
      }).document;
      document = booleanBodies(document, {
        name: 'Bolt holes',
        operation: 'subtract',
        targetBodyIds: [bored, last(document)]
      }).document;
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
        SOLID_VOLUME -
          Math.PI * 10 ** 2 * TOP -
          count * Math.PI * 3 ** 2 * FLANGE_H,
        6
      );
    },
    120_000
  );
});
