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
  fuseAllMergingFaceContacts,
  isFaceConnectedSolid,
  MAX_CONTACT_REPAIR_OPERANDS,
  materialCensus,
  solidMaterialPieces
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
    expect(solidMaterialPieces(kernel, disjoint)).toBe(2);
    expect(kernel.volume(disjoint, 0.01)).toBeCloseTo(
      Math.PI * FLANGE_R ** 2 * FLANGE_H +
        Math.PI * HUB_R ** 2 * (TOP - FLANGE_H),
      6
    );
  });

  it('refuses, by type, a contact it cannot merge instead of returning the wall', () => {
    const kernel = new RemusKernel();
    const touching = [
      kernel.makeCylinder(FLANGE_R, FLANGE_H),
      lifted(kernel, kernel.makeCylinder(HUB_R, TOP - FLANGE_H), 0, FLANGE_H)
    ];
    // Stand in for a kernel that can merge the contact by neither entry
    // point: the pairwise fuse refuses, and `fuseAll` keeps the two caps.
    const refuse = vi
      .spyOn(RemusKernel.prototype, 'fuseDetailed')
      .mockImplementation(
        () =>
          ({
            status: 'error',
            code: 'exact_only_unattainable',
            category: 'quality_refused',
            details: {}
          }) as never
      );
    try {
      let refusal: unknown;
      try {
        fuseAllMergingFaceContacts(kernel, touching, undefined, 1);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(AdapterRefusal);
      expect((refusal as AdapterRefusal).adapterCode).toBe(
        'union_unmerged_contact'
      );
    } finally {
      refuse.mockRestore();
    }
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

  it('counts a cavity as no extra piece of material', () => {
    const kernel = new RemusKernel();
    const hollow = kernel.cut(
      kernel.makeBox(20, 20, 20),
      lifted(kernel, kernel.makeBox(10, 10, 10), 5, 5, 5)
    );
    expect(isFaceConnectedSolid(kernel, hollow)).toBe(false);
    expect(solidMaterialPieces(kernel, hollow)).toBe(1);
    // Fused with a box on its side, still one piece, and not refused.
    const united = fuseAllMergingFaceContacts(
      kernel,
      [hollow, lifted(kernel, kernel.makeBox(20, 20, 20), 20, 0)],
      undefined,
      1
    );
    expect(solidMaterialPieces(kernel, united)).toBe(1);
    expect(kernel.volume(united, 0.01)).toBeCloseTo(15000, 6);
  });
});

describe('reading a fused body for unmerged pieces', () => {
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

  it.each([0, 1e5, 1e7])(
    'counts the two pieces fuseAll leaves of a hub on a flange at %s',
    (by) => {
      const kernel = new RemusKernel();
      // About the world origin the 1e7 case summed to ZERO pieces: the wall
      // was then never repaired and never refused.
      const census = materialCensus(
        kernel,
        kernel.fuseAll(Uint32Array.from(hubOnFlange(kernel, by)))
      );
      expect(census).toEqual({
        components: 2,
        certainPieces: 2,
        certainCavities: 0,
        uncertain: 0,
        pieces: 2
      });
    }
  );

  it.each([0, 1e5, 1e7])(
    'never returns the hub-on-flange wall silently at %s',
    (by) => {
      const kernel = new RemusKernel();
      let result: number | undefined;
      try {
        result = fuseAllMergingFaceContacts(
          kernel,
          hubOnFlange(kernel, by),
          undefined,
          1
        );
      } catch (error) {
        expect((error as AdapterRefusal).adapterCode).toBe(
          'union_unmerged_contact'
        );
        return;
      }
      expect(materialCensus(kernel, result)).toMatchObject({
        components: 1,
        pieces: 1
      });
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
      // Before: at 1e5 the cavity read as a second piece of material and the
      // union was refused as `union_unmerged_contact`.
      const united = fuseAllMergingFaceContacts(
        kernel,
        [hollow, neighbour],
        undefined,
        1
      );
      expect(kernel.volume(united, 0.01)).toBeCloseTo(0.015, 9);
    }
  );

  it('accepts no retry that drops material, however few pieces it has', () => {
    const kernel = new RemusKernel();
    const operands = hubOnFlange(kernel, 0);
    const flange = operands[0]!;
    // A pairwise fuse that "merges" by returning the flange alone: one
    // piece, no wall — and no hub. Before: accepted, 50265.48 mm³ shipped
    // for an 87964.59 mm³ union.
    const bad = vi
      .spyOn(RemusKernel.prototype, 'fuseDetailed')
      .mockImplementation(function (this: RemusKernel) {
        return { status: 'ok', value: this.copySolid(flange) } as never;
      });
    try {
      expect(() =>
        fuseAllMergingFaceContacts(kernel, operands, undefined, 1)
      ).toThrow(AdapterRefusal);
    } finally {
      bad.mockRestore();
    }
  });

  it('accepts no retry that drops a small feature off a large body far away', () => {
    const kernel = new RemusKernel();
    // A 2 m flange at (1e7, 1e7, 1e7) with a 0.5 mm r20 boss on top. Before:
    // the coordinate-scaled box tolerance exceeded 1 mm and the volume
    // allowance (1e-6 of 3.1e9 mm³) exceeded 3141 mm³, so a retry returning
    // the flange alone passed both and 628.32 mm³ of boss was lost.
    const flange = far(kernel, kernel.makeCylinder(1000, 1000), 1e7);
    const boss = far(
      kernel,
      lifted(kernel, kernel.makeCylinder(20, 0.5), 0, 1000),
      1e7
    );
    const census = materialCensus(
      kernel,
      kernel.fuseAll(
        Uint32Array.from([kernel.copySolid(flange), kernel.copySolid(boss)])
      )
    );
    expect(census?.certainPieces).toBe(2);
    const bad = vi
      .spyOn(RemusKernel.prototype, 'fuseDetailed')
      .mockImplementation(function (this: RemusKernel) {
        return { status: 'ok', value: this.copySolid(flange) } as never;
      });
    try {
      expect(() =>
        fuseAllMergingFaceContacts(kernel, [flange, boss], undefined, 1)
      ).toThrow(AdapterRefusal);
    } finally {
      bad.mockRestore();
    }
  });

  it.each([
    ['eleven r1 pins and one r0.1 pin', 0.1],
    ['twelve r1 pins', 1]
  ])('refuses a flange with %s rather than ship their caps', (_label, last) => {
    const kernel = new RemusKernel();
    // Thirteen operands: past the repair cap, so the census decides. The
    // r0.1 pin used to read as unknown and silence the refusal for all.
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
    let refusal: unknown;
    try {
      fuseAllMergingFaceContacts(kernel, operands);
    } catch (error) {
      refusal = error;
    }
    expect((refusal as AdapterRefusal | undefined)?.adapterCode).toBe(
      'union_unmerged_contact'
    );
  });

  it('counts several cavities as one piece and unites the body', () => {
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
    expect(materialCensus(kernel, voided)).toEqual({
      components: 3,
      certainPieces: 1,
      certainCavities: 2,
      uncertain: 0,
      pieces: 1
    });
    const united = fuseAllMergingFaceContacts(
      kernel,
      [voided, lifted(kernel, kernel.makeBox(30, 30, 30), 30, 0)],
      undefined,
      1
    );
    expect(materialCensus(kernel, united)).toEqual({
      components: 3,
      certainPieces: 1,
      certainCavities: 2,
      uncertain: 0,
      pieces: 1
    });
    expect(kernel.volume(united, 0.01)).toBeCloseTo(
      2 * 30 ** 3 - 2 * 5 ** 3,
      6
    );
  });

  it('judges a fine feature at its own scale', () => {
    const kernel = new RemusKernel();
    // A Ø0.08 spherical void is smaller than the 0.08 measurement
    // deflection; at the body's deflection its sign was unknown. Measured
    // again at its own extent it is a certain cavity.
    const pitted = kernel.cut(
      kernel.makeBox(10, 10, 10),
      lifted(kernel, kernel.makeSphere(0.04, 16), 5, 5, 5)
    );
    expect(materialCensus(kernel, pitted)).toEqual({
      components: 2,
      certainPieces: 1,
      certainCavities: 1,
      uncertain: 0,
      pieces: 1
    });
  });

  it('treats a sign inside its uncertainty band as unknown, never as a verdict', () => {
    const kernel = new RemusKernel();
    // A 1 µm wall on an r20 tube: even at its own scale the chord error of
    // its 750 mm² of curved faces exceeds its 0.38 mm³ of material.
    const tube = lifted(
      kernel,
      kernel.cut(kernel.makeCylinder(20.001, 3), kernel.makeCylinder(20, 3)),
      100,
      0
    );
    const apart = kernel.fuseAll(
      Uint32Array.from([kernel.makeBox(10, 10, 10), kernel.copySolid(tube)])
    );
    expect(materialCensus(kernel, apart)).toEqual({
      components: 2,
      certainPieces: 1,
      certainCavities: 0,
      uncertain: 1,
      pieces: null
    });
    // Unknown is not evidence against a body: even told the operands are
    // one group, the gate does not refuse it.
    const united = fuseAllMergingFaceContacts(
      kernel,
      [kernel.makeBox(10, 10, 10), tube],
      undefined,
      1
    );
    expect(kernel.volume(united, 0.01)).toBeCloseTo(
      1000 + kernel.volume(tube, 0.01),
      6
    );
  });

  it('lets no uncertain component mask the certain pieces beside it', () => {
    const kernel = new RemusKernel();
    // Two pins left standing on a flange, and apart from them a tube whose
    // sign cannot be read. Before: the one uncertain component made the
    // whole count unknown, and the two unmerged pins shipped in silence.
    const operands = [
      kernel.makeCylinder(FLANGE_R, FLANGE_H),
      lifted(kernel, kernel.makeCylinder(1, 3), 30, FLANGE_H),
      lifted(kernel, kernel.makeCylinder(1, 3), -30, FLANGE_H),
      lifted(
        kernel,
        kernel.cut(kernel.makeCylinder(20.001, 3), kernel.makeCylinder(20, 3)),
        200,
        0
      )
    ];
    // No repair can merge anything: the pairwise fuse refuses.
    const refuse = vi
      .spyOn(RemusKernel.prototype, 'fuseDetailed')
      .mockImplementation(
        () =>
          ({
            status: 'error',
            code: 'exact_only_unattainable',
            category: 'quality_refused',
            details: {}
          }) as never
      );
    try {
      // Flange-and-pins, and the tube: two groups.
      expect(() =>
        fuseAllMergingFaceContacts(kernel, operands, undefined, 2)
      ).toThrow(AdapterRefusal);
    } finally {
      refuse.mockRestore();
    }
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
