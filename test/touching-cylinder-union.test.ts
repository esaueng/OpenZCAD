import { beforeAll, describe, expect, it, vi } from 'vitest';
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
  contactRepairFaults,
  fuseAllMergingFaceContacts,
  faceComponentsOf,
  isFaceConnectedSolid,
  MAX_CONTACT_REPAIR_OPERANDS
} from '../packages/kernel-adapter/src/exact-boolean-helpers';
import { AdapterRefusal } from '../packages/kernel-adapter/src/adapter-refusal';

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
 * cylinders (esaueng/remus#1738). The pairwise `fuse` merges the same pair
 * correctly, though it refuses parallel cylinders overlapping by 1 mm or less
 * (esaueng/remus#1742), and the union gate now regroups a result `fuseAll`
 * left in pieces with both. The same gate serves extrude Add, so a circular
 * boss extruded from a cylinder's top face had the identical defect. Once
 * both issues are fixed upstream, these cases are the oracles the plain
 * `fuseAll` must pass before the workaround goes.
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

function lifted(
  kernel: RemusKernel,
  solid: number,
  x: number,
  z: number,
  y = 0
): number {
  return kernel.copyAndTransformSolid(
    solid,
    transformMatrix({ x, y, z }, { x: 0, y: 0, z: 0 })
  );
}

function cylinder(
  document: ProjectDocument,
  name: string,
  radius: number,
  height: number,
  z: number,
  y = 0,
  x = 0
): ProjectDocument {
  const placed = addPrimitiveFeature(document, {
    name,
    primitiveKind: 'cylinder',
    dimensions: { radius, height }
  });
  return z === 0 && y === 0 && x === 0
    ? placed
    : transformBody(placed, {
        name: `${name} move`,
        targetBodyId: last(placed),
        translation: { x, y, z }
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
    const touching = [
      kernel.makeCylinder(FLANGE_R, FLANGE_H),
      lifted(kernel, kernel.makeCylinder(HUB_R, TOP - FLANGE_H), 0, FLANGE_H)
    ];
    const merged = fuseAllMergingFaceContacts(kernel, touching);
    expect(isFaceConnectedSolid(kernel, merged)).toBe(true);
    expect(kernel.getSolidFaces(merged)).toHaveLength(5);

    // Genuinely apart: nothing can join them, so the result stays in two
    // pieces and the union keeps reporting a disconnected body.
    const apart = [
      kernel.makeCylinder(FLANGE_R, FLANGE_H),
      lifted(
        kernel,
        kernel.makeCylinder(HUB_R, TOP - FLANGE_H),
        0,
        FLANGE_H + 1
      )
    ];
    const disjoint = fuseAllMergingFaceContacts(kernel, apart);
    expect(faceComponentsOf(kernel, disjoint)).toHaveLength(2);
    expect(kernel.volume(disjoint, 0.01)).toBeCloseTo(
      Math.PI * FLANGE_R ** 2 * FLANGE_H +
        Math.PI * HUB_R ** 2 * (TOP - FLANGE_H),
      6
    );
  });

  it('refuses, by type, a contact it cannot merge instead of returning the wall', () => {
    const kernel = new RemusKernel();
    // A cube standing on a slab: the stand-in fuseAll needs straight edges.
    const touching = boxOnBox(kernel);
    // A kernel whose `fuseAll` keeps the two caps gets the contact repaired
    // by the pairwise fuse: one piece, the exact material, no wall.
    const repaired = withFuseAllLeavingPieces(() =>
      fuseAllMergingFaceContacts(kernel, touching)
    );
    expect(faceComponentsOf(kernel, repaired)).toHaveLength(1);
    expect(kernel.getSolidFaces(repaired)).toHaveLength(11);
    expect(kernel.volume(repaired, 0.01)).toBeCloseTo(BOX_ON_BOX_VOLUME, 6);
    // Stand in for a kernel that can merge the contact by neither entry
    // point: once the contact is proved, the pairwise fuse refuses, and
    // `fuseAll` keeps the two caps.
    let refusal: unknown;
    withFuseAllLeavingPieces(() =>
      withRepairFuse(
        () => null,
        () => {
          try {
            fuseAllMergingFaceContacts(kernel, touching);
          } catch (error) {
            refusal = error;
          }
        }
      )
    );
    expect(refusal).toBeInstanceOf(AdapterRefusal);
    expect((refusal as AdapterRefusal).adapterCode).toBe(
      'union_unmerged_contact'
    );
  });
});

describe('several bodies standing on one flange', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  /** Two r20 bosses at x = ±19.5 overlap each other by 1 mm. */
  const BOSS_X = 19.5;
  const LENS =
    2 * HUB_R ** 2 * Math.acos(BOSS_X / HUB_R) -
    BOSS_X * Math.sqrt(4 * HUB_R ** 2 - 4 * BOSS_X ** 2);
  const BOSSES_AREA = 2 * Math.PI * HUB_R ** 2 - LENS;

  it.each([
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0]
  ])(
    'merges two overlapping bosses resting on the flange (operand order %s %s %s)',
    async (...order) => {
      let document = createProjectDocument(
        'Twin hub',
        toUserId('user_touching')
      );
      document = cylinder(document, 'Flange', FLANGE_R, FLANGE_H, 0);
      const ids = [last(document)];
      for (const x of [-BOSS_X, BOSS_X]) {
        document = cylinder(
          document,
          `Boss ${x}`,
          HUB_R,
          TOP - FLANGE_H,
          FLANGE_H,
          0,
          x
        );
        ids.push(last(document));
      }
      document = booleanBodies(document, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: order.map((index) => ids[index]!)
      }).document;
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[last(document)]!;
      expect(body.volume).toBeCloseTo(
        Math.PI * FLANGE_R ** 2 * FLANGE_H + BOSSES_AREA * (TOP - FLANGE_H),
        3
      );
      // Before the fix: both full 5026.55 mm² flange discs, the bosses'
      // bottom inside the solid.
      const planes = planarAreas(derived, last(document));
      expect(planes).toHaveLength(3);
      // Boss tops 2507.33, flange top annulus 2519.21, flange bottom.
      expect(planes[0]).toBeCloseTo(BOSSES_AREA, 3);
      expect(planes[1]).toBeCloseTo(Math.PI * FLANGE_R ** 2 - BOSSES_AREA, 3);
      expect(planes[2]).toBeCloseTo(Math.PI * FLANGE_R ** 2, 6);
    },
    120_000
  );

  it('keeps an enclosed cavity in a united body without refusing it', async () => {
    // A cavity is a second boundary component that is NOT a missed merge:
    // it must neither be repaired nor refused. (On the pin `fuseAll` refuses,
    // by its own typed refusal, any hub on a hollow CYLINDER flange, so the
    // document case is prismatic; the piece count of a hollow body is pinned
    // at kernel level below.)
    let document = createProjectDocument(
      'Hollow plate',
      toUserId('user_touching')
    );
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 40, depth: 10 }
    });
    const plate = last(document);
    document = addPrimitiveFeature(document, {
      name: 'Void',
      primitiveKind: 'box',
      dimensions: { width: 4, height: 4, depth: 4 }
    });
    document = transformBody(document, {
      name: 'Void move',
      targetBodyId: last(document),
      translation: { x: 3, y: 3, z: 3 }
    }).document;
    document = booleanBodies(document, {
      name: 'Hollow',
      operation: 'subtract',
      targetBodyIds: [plate, last(document)]
    }).document;
    const hollow = last(document);
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    document = transformBody(document, {
      name: 'Block move',
      targetBodyId: last(document),
      translation: { x: 15, y: 15, z: 10 }
    }).document;
    document = booleanBodies(document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [hollow, last(document)]
    }).document;
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
      40 * 40 * 10 - 4 ** 3 + 10 ** 3,
      6
    );
  }, 120_000);

  it('keeps a hollow body whole when a box joins it', () => {
    const kernel = new RemusKernel();
    const hollow = kernel.cut(
      kernel.makeBox(20, 20, 20),
      lifted(kernel, kernel.makeBox(10, 10, 10), 5, 5, 5)
    );
    expect(isFaceConnectedSolid(kernel, hollow)).toBe(false);
    // Fused with a box on its side: a contact group, certified despite the
    // cavity's second boundary component, and not refused.
    const united = fuseAllMergingFaceContacts(kernel, [
      hollow,
      lifted(kernel, kernel.makeBox(20, 20, 20), 20, 0)
    ]);
    expect(faceComponentsOf(kernel, united)).toHaveLength(2);
    expect(kernel.volume(united, 0.01)).toBeCloseTo(15000, 6);
  });
});

/**
 * Run `body` with the repair's pairwise fuse replaced by `injected`; the
 * gate's contact proof still reaches the real kernel.
 */
function withRepairFuse<T>(
  injected: (kernel: RemusKernel, left: number, right: number) => number | null,
  body: () => T
): T {
  contactRepairFaults.pairwiseFuse = injected;
  try {
    return body();
  } finally {
    delete contactRepairFaults.pairwiseFuse;
  }
}

/**
 * Run `body` with every `fuseAll` the gate makes replaced by the kernel's
 * behaviour before esaueng/remus#1792: the operands joined without a
 * boolean, every face of every operand sewn into one solid, so each contact
 * keeps both caps while the material stays exact and a correct repair can
 * still be accepted. Sewing takes straight edges only, so the fixtures run
 * under it are boxes. The contact proof still reads the real operands.
 */
function withFuseAllLeavingPieces<T>(body: () => T): T {
  contactRepairFaults.fuseAll = (kernel, solids) =>
    kernel.sewFaces(
      Uint32Array.from(
        Array.from(solids).flatMap((solid) =>
          Array.from<number>(kernel.getSolidFaces(kernel.copySolid(solid)))
        )
      ),
      1e-7
    );
  try {
    return body();
  } finally {
    delete contactRepairFaults.fuseAll;
  }
}

/** A 20 mm cube standing on a 40 × 40 × 10 slab, both offset by `by`. */
function boxOnBox(kernel: RemusKernel, by = 0): number[] {
  return [
    lifted(kernel, kernel.makeBox(40, 40, 10), by, by, by),
    lifted(kernel, kernel.makeBox(20, 20, 20), 10 + by, 10 + by, 10 + by)
  ];
}
const BOX_ON_BOX_VOLUME = 40 * 40 * 10 + 20 * 20 * 20;

/** Planar face areas of `solid`, ascending. */
function planeAreas(kernel: RemusKernel, solid: number): number[] {
  return Array.from<number>(kernel.getSolidFaces(solid))
    .filter((face) => kernel.getSurfaceType(face) === 'plane')
    .map((face) => kernel.faceArea(face, 0.01))
    .sort((left, right) => left - right);
}

/** A thin r20 tube, `wall` thick and 3 tall, standing at (x, y). */
function thinTube(kernel: RemusKernel, wall: number, x: number, y = 0): number {
  return lifted(
    kernel,
    kernel.cut(kernel.makeCylinder(20 + wall, 3), kernel.makeCylinder(20, 3)),
    x,
    0,
    y
  );
}

describe('certifying each contact group on its own', () => {
  /** A copy of `solid` moved by `by` on every axis. */
  const far = (kernel: RemusKernel, solid: number, by: number) =>
    lifted(kernel, solid, by, by, by);
  const hubOnFlange = (kernel: RemusKernel, by: number) => [
    far(kernel, kernel.makeCylinder(FLANGE_R, FLANGE_H), by),
    far(
      kernel,
      lifted(kernel, kernel.makeCylinder(HUB_R, TOP - FLANGE_H), 0, FLANGE_H),
      by
    )
  ];
  /** Whether no full flange disc remains above the bottom one. */
  const flangeTopMerged = (kernel: RemusKernel, solid: number) =>
    planeAreas(kernel, solid).filter(
      (area) => Math.abs(area - Math.PI * FLANGE_R ** 2) < 1e-6
    ).length === 1;

  it.each([0, 1e5, 1e7])(
    'fuseAll merges a hub standing on a flange at %s (esaueng/remus#1738)',
    (by) => {
      // Until esaueng/remus#1792 (2026.1.141) the plain fuseAll left two
      // pieces here, both caps intact. It now merges the contact itself.
      const kernel = new RemusKernel();
      const fused = kernel.fuseAll(Uint32Array.from(hubOnFlange(kernel, by)));
      expect(faceComponentsOf(kernel, fused)).toHaveLength(1);
      expect(flangeTopMerged(kernel, fused)).toBe(true);
    }
  );

  it.each([0, 1e5, 1e7])(
    'never returns the hub-on-flange wall silently at %s',
    (by) => {
      const kernel = new RemusKernel();
      let result: number | undefined;
      try {
        result = fuseAllMergingFaceContacts(kernel, hubOnFlange(kernel, by));
      } catch (error) {
        expect((error as AdapterRefusal).adapterCode).toBe(
          'union_unmerged_contact'
        );
        return;
      }
      expect(faceComponentsOf(kernel, result)).toHaveLength(1);
      expect(kernel.getSolidFaces(result)).toHaveLength(5);
    }
  );

  it.each([0, 1e5])(
    'unites a tiny hollow cube with its neighbour at %s without refusing',
    (by) => {
      const kernel = new RemusKernel();
      const hollow = kernel.cut(
        far(kernel, kernel.makeBox(0.2, 0.2, 0.2), by),
        far(
          kernel,
          lifted(kernel, kernel.makeBox(0.1, 0.1, 0.1), 0.05, 0.05, 0.05),
          by
        )
      );
      const neighbour = far(
        kernel,
        lifted(kernel, kernel.makeBox(0.2, 0.2, 0.2), 0.2, 0),
        by
      );
      // Before 06483e5: at 1e5 the cavity read as a second piece of
      // material and the union was refused.
      const united = fuseAllMergingFaceContacts(kernel, [hollow, neighbour]);
      expect(kernel.volume(united, 0.01)).toBeCloseTo(0.015, 9);
    }
  );

  it('accepts no retry that drops material, however few pieces it has', () => {
    const kernel = new RemusKernel();
    const operands = boxOnBox(kernel);
    const flange = operands[0]!;
    // A pairwise fuse that "merges" by returning the slab alone: one piece,
    // no wall — and no cube. Before 06483e5 (on a hub and flange):
    // accepted, 50265.48 mm³ shipped for an 87964.59 mm³ union.
    withFuseAllLeavingPieces(() =>
      withRepairFuse(
        (k) => k.copySolid(flange),
        () => {
          expect(() => fuseAllMergingFaceContacts(kernel, operands)).toThrow(
            AdapterRefusal
          );
        }
      )
    );
  });

  it('accepts no retry that drops a small feature off a large body far away', () => {
    const kernel = new RemusKernel();
    // A 2 m block at (1e7, 1e7, 1e7) with a 0.5 mm 40 × 40 boss on top.
    // Before 1f6c3fc (on an r1000 flange with an r20 boss): coordinate-scaled
    // tolerances passed a retry returning the flange alone, and 628.32 mm³
    // of boss was lost.
    const flange = far(kernel, kernel.makeBox(2000, 2000, 1000), 1e7);
    const boss = far(
      kernel,
      lifted(kernel, kernel.makeBox(40, 40, 0.5), 980, 1000, 980),
      1e7
    );
    withFuseAllLeavingPieces(() =>
      withRepairFuse(
        (k) => k.copySolid(flange),
        () => {
          expect(() =>
            fuseAllMergingFaceContacts(kernel, [flange, boss])
          ).toThrow(AdapterRefusal);
        }
      )
    );
  });

  it.each([
    ['eleven r1 pins and one r0.1 pin', 0.1],
    ['twelve r1 pins', 1]
  ])('refuses a flange with %s rather than ship their caps', (_label, last) => {
    const kernel = new RemusKernel();
    // Thirteen operands in one contact group: past the repair cap, so the
    // group cannot be repaired and fails closed. Before 1f6c3fc the r0.1 pin
    // read as unknown and silenced the refusal for all.
    const operands = [kernel.makeCylinder(FLANGE_R, FLANGE_H)];
    for (let index = 0; index < 12; index += 1) {
      const angle = (index * Math.PI) / 6;
      operands.push(
        lifted(
          kernel,
          kernel.makeCylinder(index === 11 ? last : 1, 3),
          30 * Math.cos(angle),
          FLANGE_H,
          30 * Math.sin(angle)
        )
      );
    }
    expect(operands.length).toBeGreaterThan(MAX_CONTACT_REPAIR_OPERANDS);
    // The pinned fuseAll merges every pin itself (esaueng/remus#1792): one
    // piece holding the flange and all twelve pins.
    const united = fuseAllMergingFaceContacts(kernel, operands);
    expect(faceComponentsOf(kernel, united)).toHaveLength(1);
    expect(kernel.volume(united, 0.01)).toBeCloseTo(
      Math.PI * FLANGE_R ** 2 * FLANGE_H +
        Math.PI * 3 * (11 * 1 ** 2 + last ** 2),
      6
    );
    // A kernel that left them in pieces could not be repaired past the cap,
    // and the gate fails closed. The stand-in needs straight edges, so the
    // same layout is built from a slab and square pins.
    const boxes = [
      lifted(kernel, kernel.makeBox(80, 80, FLANGE_H), -40, 0, -40)
    ];
    for (let index = 0; index < 12; index += 1) {
      const angle = (index * Math.PI) / 6;
      const side = 2 * (index === 11 ? last : 1);
      boxes.push(
        lifted(
          kernel,
          kernel.makeBox(side, side, 3),
          30 * Math.cos(angle) - side / 2,
          FLANGE_H,
          30 * Math.sin(angle) - side / 2
        )
      );
    }
    let refusal: unknown;
    withFuseAllLeavingPieces(() => {
      try {
        fuseAllMergingFaceContacts(kernel, boxes);
      } catch (error) {
        refusal = error;
      }
    });
    expect((refusal as AdapterRefusal | undefined)?.adapterCode).toBe(
      'union_unmerged_contact'
    );
  });

  it.each([
    ['one thin tube', 1],
    ['eleven thin tubes', 11]
  ])(
    'never lets %s elsewhere hide a hub left standing on its flange',
    (_label, tubes) => {
      const kernel = new RemusKernel();
      // Before: each r20 tube with a 1 µm wall stood apart as a component
      // whose sign could not be read, and the hub's contact caps shipped in
      // silence — 10 faces with one tube, 50 with eleven. The tubes touch
      // nothing, so they are no contact group's business.
      const operands = [
        kernel.makeCylinder(FLANGE_R, FLANGE_H),
        lifted(kernel, kernel.makeCylinder(HUB_R, TOP - FLANGE_H), 0, FLANGE_H)
      ];
      for (let index = 0; index < tubes; index += 1) {
        operands.push(thinTube(kernel, 0.001, 200 + index * 100));
      }
      let result: number;
      try {
        result = fuseAllMergingFaceContacts(kernel, operands);
      } catch (error) {
        expect((error as AdapterRefusal).adapterCode).toBe(
          'union_unmerged_contact'
        );
        return;
      }
      expect(flangeTopMerged(kernel, result)).toBe(true);
      expect(faceComponentsOf(kernel, result)).toHaveLength(1 + tubes);
    }
  );

  it('does no extra work on a union whose operands touch nowhere', () => {
    const kernel = new RemusKernel();
    // Thin tubes and a plate holding sixteen small cavities, all apart: the result
    // is in many pieces, but no two operands touch, so the gate tessellates
    // nothing and returns exactly what fuseAll made.
    const plate = () => {
      let body = kernel.makeBox(80, 80, 10);
      for (let i = 0; i < 4; i += 1) {
        for (let j = 0; j < 4; j += 1) {
          body = kernel.cut(
            body,
            lifted(
              kernel,
              kernel.makeBox(1, 1, 1),
              10 + i * 20,
              4.5,
              10 + j * 20
            )
          );
        }
      }
      return body;
    };
    const operands = () => [
      plate(),
      thinTube(kernel, 0.001, 200),
      thinTube(kernel, 0.01, 300)
    ];
    const plain = kernel.fuseAll(Uint32Array.from(operands()));
    const gated = operands();
    const tessellate = vi.spyOn(RemusKernel.prototype, 'tessellateFace');
    try {
      const result = fuseAllMergingFaceContacts(kernel, gated);
      expect(tessellate).not.toHaveBeenCalled();
      expect(kernel.getSolidFaces(result)).toHaveLength(
        kernel.getSolidFaces(plain).length
      );
      expect(kernel.volume(result, 0.01)).toBeCloseTo(
        kernel.volume(plain, 0.01),
        9
      );
    } finally {
      tessellate.mockRestore();
    }
  });

  it('certifies each contact of compound operands, not one witness per operand', () => {
    const kernel = new RemusKernel();
    // Operand A is one body of two flanges 200 mm apart. Operand B is one
    // body of a small cylinder inside the first flange and a tall r40
    // cylinder resting on the second. fuseAll merges both contacts: two
    // separate regions, 251327.41 mm³. Before: A's single witness sat in
    // region 1, B's in region 2, and the union was refused as walled.
    const compound = (solids: number[]) =>
      kernel.fuseAll(Uint32Array.from(solids));
    const operands = () => [
      compound([
        kernel.makeCylinder(40, 10),
        lifted(kernel, kernel.makeCylinder(40, 10), 200, 0)
      ]),
      compound([
        lifted(kernel, kernel.makeCylinder(20, 5), 0, 2),
        lifted(kernel, kernel.makeCylinder(40, 30), 200, 10)
      ])
    ];
    const plain = kernel.fuseAll(Uint32Array.from(operands()));
    const result = fuseAllMergingFaceContacts(kernel, operands());
    expect(kernel.volume(result, 0.01)).toBeCloseTo(251327.412287, 5);
    expect(kernel.getSolidFaces(result)).toHaveLength(
      kernel.getSolidFaces(plain).length
    );
    expect(faceComponentsOf(kernel, result)).toHaveLength(2);
  });

  it.each([0.001, 0.0001])(
    'unites a block resting on a %s mm plate held in a compound body',
    (thickness) => {
      const kernel = new RemusKernel();
      // A 1 m × 1 m plate compounded with a separate 1 mm cube, and a block
      // resting on the plate. Before: a witness had to clear every face by
      // 1e-6 of the plate's DIAGONAL (≈ 0.0014 mm), more than half the
      // plate's thickness, so the plate had no witness and the union was
      // refused.
      const operands = () => [
        kernel.fuseAll(
          Uint32Array.from([
            kernel.makeBox(1000, 1000, thickness),
            lifted(kernel, kernel.makeBox(1, 1, 1), 2000, 0)
          ])
        ),
        lifted(kernel, kernel.makeBox(10, 10, 1), 100, thickness, 100)
      ];
      const plain = kernel.fuseAll(Uint32Array.from(operands()));
      const result = fuseAllMergingFaceContacts(kernel, operands());
      expect(kernel.volume(result, 0.01)).toBeCloseTo(
        1000 * 1000 * thickness + 1 + 100,
        6
      );
      expect(kernel.getSolidFaces(result)).toHaveLength(
        kernel.getSolidFaces(plain).length
      );
      expect(faceComponentsOf(kernel, result)).toHaveLength(2);
    }
  );

  it('leaves cubes that share only a vertex exactly as fuseAll makes them', () => {
    const kernel = new RemusKernel();
    // A shared vertex cannot hold an internal wall. Before: distance 0 made
    // the pair a contact group, its two shells failed certification, and
    // the union was refused.
    const operands = () => [
      kernel.makeBox(10, 10, 10),
      lifted(kernel, kernel.makeBox(10, 10, 10), 10, 10, 10)
    ];
    const plain = kernel.fuseAll(Uint32Array.from(operands()));
    const result = fuseAllMergingFaceContacts(kernel, operands());
    expect(kernel.volume(result, 0.01)).toBeCloseTo(2000, 9);
    expect(faceComponentsOf(kernel, result)).toHaveLength(
      faceComponentsOf(kernel, plain)!.length
    );
  });

  it('counts several cavities as part of one certified piece', () => {
    const kernel = new RemusKernel();
    // Two voids: three boundary components, one piece of material. (An
    // island floating inside a void — a cavity nested in a cavity — cannot
    // be built on the pin: every exact route to it is refused.)
    const voided = kernel.cut(
      kernel.cut(
        kernel.makeBox(30, 30, 30),
        lifted(kernel, kernel.makeBox(5, 5, 5), 5, 5, 5)
      ),
      lifted(kernel, kernel.makeBox(5, 5, 5), 20, 20, 20)
    );
    const united = fuseAllMergingFaceContacts(kernel, [
      voided,
      lifted(kernel, kernel.makeBox(30, 30, 30), 30, 0)
    ]);
    expect(faceComponentsOf(kernel, united)).toHaveLength(3);
    expect(kernel.volume(united, 0.01)).toBeCloseTo(
      2 * 30 ** 3 - 2 * 5 ** 3,
      6
    );
  });

  it('certifies a contact group holding a void finer than the deflection', () => {
    const kernel = new RemusKernel();
    // A 0.05 mm cubic void, finer than the 0.08 measurement deflection,
    // inside a block that a second block touches. (The pin refuses to fuse a
    // block holding a curved void with its neighbour, so the void is
    // prismatic.)
    const pitted = kernel.cut(
      kernel.makeBox(10, 10, 10),
      lifted(kernel, kernel.makeBox(0.05, 0.05, 0.05), 5, 5, 5)
    );
    const united = fuseAllMergingFaceContacts(kernel, [
      pitted,
      lifted(kernel, kernel.makeBox(10, 10, 10), 10, 0)
    ]);
    expect(faceComponentsOf(kernel, united)).toHaveLength(2);
    expect(kernel.volume(united, 0.01)).toBeCloseTo(2000 - 0.05 ** 3, 9);
  });

  it.each([0.1, 0.01, 0.001])(
    'merges a %s mm tube wall standing on a flange without refusing',
    (wall) => {
      const kernel = new RemusKernel();
      // A thin tube resting on the flange top, beside a hub that also rests
      // there and a separate block that makes the result more than one
      // piece: every contact group must certify, thin walls included.
      const result = fuseAllMergingFaceContacts(kernel, [
        kernel.makeCylinder(FLANGE_R, FLANGE_H),
        lifted(kernel, thinTube(kernel, wall, 0), 0, FLANGE_H),
        lifted(kernel, kernel.makeCylinder(10, 5), 0, FLANGE_H),
        lifted(kernel, kernel.makeBox(5, 5, 5), 200, 0)
      ]);
      expect(flangeTopMerged(kernel, result)).toBe(true);
      expect(faceComponentsOf(kernel, result)).toHaveLength(2);
    }
  );
});

/**
 * QA 2026-11-14 finding #2 reported a ×4 circular pattern of Ø6 pins
 * subtracted from the flanged hub cutting one hole. It does not reproduce on
 * the stated geometry, about a world axis or about the bore's datum axis;
 * this pins the report's suggested regression for N = 2–8: the removed
 * volume is N holes, and the flange top (the area the report read) loses N
 * hole discs. The touching hub (base on the flange top) is the case the QA
 * pass built; the overlapping hub is the control.
 */
describe('a circular pattern of pins subtracted from a flange', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  // N = 2–8 about the bore's datum axis on the touching hub the QA pass
  // used, the overlapping hub as the control, and a world-axis pattern.
  const cases: (readonly ['world Z' | 'bore axis', number, number])[] = [
    ...[2, 3, 4, 5, 6, 7, 8].map(
      (count) => ['bore axis', count, FLANGE_H] as const
    ),
    ...[2, 4, 8].map((count) => ['bore axis', count, 5] as const),
    ['world Z', 4, FLANGE_H],
    ['world Z', 4, 5]
  ];

  it.each(cases)(
    'cuts every hole about the %s (×%s, hub base z = %s)',
    async (about, count, hubBase) => {
      let document = flangedHub(hubBase);
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
      // The QA symptom was the flange top's area: one hole short of N.
      const pierced = derived.bodyRepresentations[
        last(document)
      ]!.topology!.faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.area > Math.PI * HUB_R ** 2 + 1
      )
        .map((face) => face.geometry!.area)
        .sort((left, right) => left - right);
      // Flange top annulus, then the bottom disc, both pierced N times.
      expect(pierced).toHaveLength(2);
      expect(pierced[0]).toBeCloseTo(ANNULUS - count * Math.PI * 3 ** 2, 6);
    },
    120_000
  );
});
