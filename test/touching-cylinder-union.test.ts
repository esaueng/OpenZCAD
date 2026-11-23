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
  faceComponentsOf,
  isFaceConnectedSolid
} from '../packages/kernel-adapter/src/exact-boolean-helpers';
import {
  exactBooleanOutcome,
  exactFuseAll
} from '../packages/kernel-adapter/src/exact-boolean-refusal';
import { validationReport } from '../packages/kernel-adapter/src/kernel-validation';

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
 * The cause was two Remus defects: `fuseAll` misjudged cap-on-cap cylinder
 * contact as disjoint (esaueng/remus#1738, fixed in Remus 2026.1.141 / #1792),
 * and pairwise `fuse` refused parallel cylinders overlapping by 1 mm or less
 * (esaueng/remus#1742, fixed upstream and verified on Remus 2026.1.160).
 * With both fixed, the adapter's `fuseAllMergingFaceContacts` workaround is
 * retired and these oracles pin the plain `exactFuseAll` and pairwise `fuse`
 * directly.
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

  it('merges touching cylinders and keeps disjoint cylinders in two pieces via exactFuseAll', () => {
    const kernel = new RemusKernel();
    const touching = [
      kernel.makeCylinder(FLANGE_R, FLANGE_H),
      lifted(kernel, kernel.makeCylinder(HUB_R, TOP - FLANGE_H), 0, FLANGE_H)
    ];
    const merged = exactFuseAll(kernel, touching);
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
    const disjoint = exactFuseAll(kernel, apart);
    expect(faceComponentsOf(kernel, disjoint)).toHaveLength(2);
    expect(kernel.volume(disjoint, 0.01)).toBeCloseTo(
      Math.PI * FLANGE_R ** 2 * FLANGE_H +
        Math.PI * HUB_R ** 2 * (TOP - FLANGE_H),
      6
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
    // the union must keep it and must not refuse. (On the pin `fuseAll`
    // refuses, by its own typed refusal, any hub on a hollow CYLINDER flange,
    // so the document case is prismatic; the piece count of a hollow body is
    // pinned at kernel level below.)
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
    const united = exactFuseAll(kernel, [
      hollow,
      lifted(kernel, kernel.makeBox(20, 20, 20), 20, 0)
    ]);
    expect(faceComponentsOf(kernel, united)).toHaveLength(2);
    expect(kernel.volume(united, 0.01)).toBeCloseTo(15000, 6);
  });
});

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

describe('direct kernel fuse and fuseAll contact oracles', () => {
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
    'exactFuseAll merges a hub standing on a flange at %s (esaueng/remus#1738)',
    (by) => {
      const kernel = new RemusKernel();
      const fused = exactFuseAll(kernel, hubOnFlange(kernel, by));
      expect(faceComponentsOf(kernel, fused)).toHaveLength(1);
      expect(kernel.getSolidFaces(fused)).toHaveLength(5);
      expect(flangeTopMerged(kernel, fused)).toBe(true);
    }
  );

  it.each([1, 0.5, 0.1])(
    'exact pairwise fuse and exactFuseAll merge parallel r20 cylinders overlapping by %s mm (esaueng/remus#1742)',
    (overlap) => {
      const kernel = new RemusKernel();
      const halfSpan = HUB_R - overlap / 2;
      const lens =
        2 * HUB_R ** 2 * Math.acos(halfSpan / HUB_R) -
        halfSpan * Math.sqrt(4 * HUB_R ** 2 - 4 * halfSpan ** 2);
      const height = TOP - FLANGE_H;
      const expectedSameZ = (2 * Math.PI * HUB_R ** 2 - lens) * height;

      const left = lifted(
        kernel,
        kernel.makeCylinder(HUB_R, height),
        -halfSpan,
        FLANGE_H
      );
      const right = lifted(
        kernel,
        kernel.makeCylinder(HUB_R, height),
        halfSpan,
        FLANGE_H
      );

      const pair = exactBooleanOutcome(kernel, 'fuse', left, right);
      expect(pair.status).toBe('ok');
      if (pair.status === 'ok') {
        expect(validationReport(kernel, pair.solid).errorCount).toBe(0);
        expect(faceComponentsOf(kernel, pair.solid)).toHaveLength(1);
        expect(kernel.volume(pair.solid, 0.01)).toBeCloseTo(expectedSameZ, 3);
      }

      const fusedAll = exactFuseAll(kernel, [left, right]);
      expect(validationReport(kernel, fusedAll).errorCount).toBe(0);
      expect(faceComponentsOf(kernel, fusedAll)).toHaveLength(1);
      expect(kernel.volume(fusedAll, 0.01)).toBeCloseTo(expectedSameZ, 3);

      // Offset cap planes (z = 10..40 and z = 12..42, 28 mm shared height).
      const offsetRight = lifted(
        kernel,
        kernel.makeCylinder(HUB_R, height),
        halfSpan,
        FLANGE_H + 2
      );
      const offsetPair = exactBooleanOutcome(kernel, 'fuse', left, offsetRight);
      expect(offsetPair.status).toBe('ok');
      if (offsetPair.status === 'ok') {
        expect(validationReport(kernel, offsetPair.solid).errorCount).toBe(0);
        expect(faceComponentsOf(kernel, offsetPair.solid)).toHaveLength(1);
        expect(kernel.volume(offsetPair.solid, 0.01)).toBeCloseTo(
          2 * Math.PI * HUB_R ** 2 * height - lens * (height - 2),
          3
        );
      }
    }
  );

  it.each([0, 1e5])(
    'unites a tiny hollow cube with its neighbour at %s',
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
      const united = exactFuseAll(kernel, [hollow, neighbour]);
      expect(kernel.volume(united, 0.01)).toBeCloseTo(0.015, 9);
    }
  );

  it.each([
    ['eleven r1 pins and one r0.1 pin', 0.1],
    ['twelve r1 pins', 1]
  ])('merges a flange with %s into one component', (_label, lastRadius) => {
    const kernel = new RemusKernel();
    const operands = [kernel.makeCylinder(FLANGE_R, FLANGE_H)];
    for (let index = 0; index < 12; index += 1) {
      const angle = (index * Math.PI) / 6;
      operands.push(
        lifted(
          kernel,
          kernel.makeCylinder(index === 11 ? lastRadius : 1, 3),
          30 * Math.cos(angle),
          FLANGE_H,
          30 * Math.sin(angle)
        )
      );
    }
    const united = exactFuseAll(kernel, operands);
    expect(faceComponentsOf(kernel, united)).toHaveLength(1);
    expect(kernel.volume(united, 0.01)).toBeCloseTo(
      Math.PI * FLANGE_R ** 2 * FLANGE_H +
        Math.PI * 3 * (11 * 1 ** 2 + lastRadius ** 2),
      6
    );
  });

  it.each([
    ['one thin tube', 1],
    ['eleven thin tubes', 11]
  ])(
    'merges a hub standing on its flange alongside %s apart',
    (_label, tubes) => {
      const kernel = new RemusKernel();
      const operands = [
        kernel.makeCylinder(FLANGE_R, FLANGE_H),
        lifted(kernel, kernel.makeCylinder(HUB_R, TOP - FLANGE_H), 0, FLANGE_H)
      ];
      for (let index = 0; index < tubes; index += 1) {
        operands.push(thinTube(kernel, 0.001, 200 + index * 100));
      }
      const result = exactFuseAll(kernel, operands);
      expect(flangeTopMerged(kernel, result)).toBe(true);
      expect(faceComponentsOf(kernel, result)).toHaveLength(1 + tubes);
    }
  );

  it('merges each contact of compound operands into two components', () => {
    const kernel = new RemusKernel();
    // Operand A is one body of two flanges 200 mm apart. Operand B is one
    // body of a small cylinder inside the first flange and a tall r40
    // cylinder resting on the second. fuseAll merges both contacts: two
    // separate regions, 251327.41 mm³.
    const compound = (solids: number[]) =>
      kernel.fuseAll(Uint32Array.from(solids));
    const operands = [
      compound([
        kernel.makeCylinder(40, 10),
        lifted(kernel, kernel.makeCylinder(40, 10), 200, 0)
      ]),
      compound([
        lifted(kernel, kernel.makeCylinder(20, 5), 0, 2),
        lifted(kernel, kernel.makeCylinder(40, 30), 200, 10)
      ])
    ];
    const result = exactFuseAll(kernel, operands);
    expect(kernel.volume(result, 0.01)).toBeCloseTo(251327.412287, 5);
    expect(faceComponentsOf(kernel, result)).toHaveLength(2);
  });

  it.each([0.001, 0.0001])(
    'unites a block resting on a %s mm plate held in a compound body',
    (thickness) => {
      const kernel = new RemusKernel();
      const operands = [
        kernel.fuseAll(
          Uint32Array.from([
            kernel.makeBox(1000, 1000, thickness),
            lifted(kernel, kernel.makeBox(1, 1, 1), 2000, 0)
          ])
        ),
        lifted(kernel, kernel.makeBox(10, 10, 1), 100, thickness, 100)
      ];
      const result = exactFuseAll(kernel, operands);
      expect(kernel.volume(result, 0.01)).toBeCloseTo(
        1000 * 1000 * thickness + 1 + 100,
        6
      );
      expect(faceComponentsOf(kernel, result)).toHaveLength(2);
    }
  );

  it('keeps cubes that share only a vertex in two components with exact volume', () => {
    const kernel = new RemusKernel();
    // A shared vertex cannot hold an internal wall.
    const result = exactFuseAll(kernel, [
      kernel.makeBox(10, 10, 10),
      lifted(kernel, kernel.makeBox(10, 10, 10), 10, 10, 10)
    ]);
    expect(kernel.volume(result, 0.01)).toBeCloseTo(2000, 9);
    expect(faceComponentsOf(kernel, result)).toHaveLength(2);
  });

  it('keeps several cavities intact when a box joins a voided block', () => {
    const kernel = new RemusKernel();
    // Two voids: three boundary components, one piece of material.
    const voided = kernel.cut(
      kernel.cut(
        kernel.makeBox(30, 30, 30),
        lifted(kernel, kernel.makeBox(5, 5, 5), 5, 5, 5)
      ),
      lifted(kernel, kernel.makeBox(5, 5, 5), 20, 20, 20)
    );
    const united = exactFuseAll(kernel, [
      voided,
      lifted(kernel, kernel.makeBox(30, 30, 30), 30, 0)
    ]);
    expect(faceComponentsOf(kernel, united)).toHaveLength(3);
    expect(kernel.volume(united, 0.01)).toBeCloseTo(
      2 * 30 ** 3 - 2 * 5 ** 3,
      6
    );
  });

  it('unites a block holding a 0.05 mm void with its neighbour', () => {
    const kernel = new RemusKernel();
    const pitted = kernel.cut(
      kernel.makeBox(10, 10, 10),
      lifted(kernel, kernel.makeBox(0.05, 0.05, 0.05), 5, 5, 5)
    );
    const united = exactFuseAll(kernel, [
      pitted,
      lifted(kernel, kernel.makeBox(10, 10, 10), 10, 0)
    ]);
    expect(faceComponentsOf(kernel, united)).toHaveLength(2);
    expect(kernel.volume(united, 0.01)).toBeCloseTo(2000 - 0.05 ** 3, 9);
  });

  it.each([0.1, 0.01, 0.001])(
    'merges a %s mm tube wall standing on a flange alongside a hub and a separate block',
    (wall) => {
      const kernel = new RemusKernel();
      const result = exactFuseAll(kernel, [
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
