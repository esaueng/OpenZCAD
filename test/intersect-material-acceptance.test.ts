import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createBodyFeatureIds,
  createProjectDocument,
  extrudeSketch,
  importStepBody,
  setParameter,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  toUserId,
  type DerivedState,
  type FeatureWarning,
  type MeshGeometry,
  type ProjectDocument
} from '@openzcad/shared';
import { expectPassedThrough } from './support/failed-pass-through';

/**
 * Issue #1244: exact Intersect of a torus (R 7, r 3) with a holed block
 * (24 × 18 × 12, r 3 through-hole, scaled 0.82, moved to (6, 1, 0.5)) kept
 * material inside the hole on Remus 2026.1.122, in both orders.
 *
 * The acceptance is that both orders exclude the hole witness and build a
 * valid body, or refuse safely — and that the same holds when a reload or an
 * upstream edit replays the stored Intersect. Every route that rebuilds a
 * stored Boolean or extrude Intersect runs the same feature builder, so each
 * case below is checked fresh, after a cold reload (a new adapter with no
 * memory of the build) and after an upstream parameter edit.
 *
 * Expected volumes are independent closed forms (see
 * test/fixtures/issue-1244/README.md), never recorded kernel values; the
 * witnesses are checked against the derived display mesh by a winding
 * number computed here, not by the kernel's classifier.
 */

const HOLE_WITNESS = { x: 6, y: 1, z: 0.5 };
/**
 * Inside the torus tube (|(7, −4)| = 8.06, 1.06 from the tube centre) and in
 * the block's material at both placements: 5.1 and 5.0 from the hole axis,
 * inside the 19.68 × 14.76 outline.
 */
const MATERIAL_WITNESS = { x: 7, y: -4, z: 0.5 };
/** Closed-form torus ∩ holed block, block at (6, 1, 0.5). */
const INTERSECTION_VOLUME = 570.78893;
/** The same with the block moved +1 mm in x (quadrature, README). */
const SHIFTED_VOLUME = 514.145;
/**
 * The body volume is read from the measurement tessellation, which reads
 * this pair about 5e-5 low; 2e-4 relative bounds that approximation while
 * staying two orders of magnitude below the 96.65 mm³ the defect kept.
 */
const VOLUME_TOLERANCE = 2e-4;

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/issue-1244/${name}`, import.meta.url),
    'utf8'
  );

/** Generalized winding number of a closed triangle mesh about a point. */
function windingNumber(
  mesh: MeshGeometry,
  p: { x: number; y: number; z: number }
): number {
  const v = mesh.vertices;
  let total = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const corner = (k: number) => {
      const i = mesh.indices[t + k]! * 3;
      return [v[i]! - p.x, v[i + 1]! - p.y, v[i + 2]! - p.z] as const;
    };
    const a = corner(0);
    const b = corner(1);
    const c = corner(2);
    const la = Math.hypot(...a);
    const lb = Math.hypot(...b);
    const lc = Math.hypot(...c);
    const det =
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
    const dot = (u: readonly number[], w: readonly number[]) =>
      u[0]! * w[0]! + u[1]! * w[1]! + u[2]! * w[2]!;
    const denominator =
      la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb;
    total += 2 * Math.atan2(det, denominator);
  }
  return total / (4 * Math.PI);
}

const blocking = (derived: DerivedState): FeatureWarning[] =>
  (derived.featureWarnings ?? []).filter(
    (warning) => warning.kind === 'build-failed' || warning.kind === 'refusal'
  );

type Order = 'torus first' | 'block first';
const ORDERS: Order[] = ['torus first', 'block first'];

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);

/** One sync on a new adapter: a reload, with no memory of earlier builds. */
async function coldSync(document: ProjectDocument): Promise<DerivedState> {
  const cold = await createExactKernelAdapter();
  try {
    return await cold.syncDocument(document);
  } finally {
    cold.dispose();
  }
}

/** Fresh, reload (cold adapter) and upstream-edit syncs of one document. */
async function replays(
  document: ProjectDocument,
  edited: ProjectDocument
): Promise<Array<[string, DerivedState]>> {
  const fresh = await adapter.syncDocument(document);
  const reloaded = await coldSync(document);
  const upstream = await adapter.syncDocument(edited);
  // Back to the stored values on the warm adapter: the edit's replay must
  // not leave a stale checkpoint that replays a different body.
  const restored = await adapter.syncDocument(document);
  return [
    ['fresh', fresh],
    ['reload', reloaded],
    ['upstream edit', upstream],
    ['edit undone', restored]
  ];
}

describe('#1244 on the issue’s STEP operands', () => {
  /**
   * The operands as the issue imported them (one-face torus bounded by its
   * seam circles). A `shift` parameter drives a Move of the block between
   * the import and the Intersect, so editing it replays the stored
   * Intersect on a changed upstream body; `shift = 0` is the issue's
   * placement.
   */
  function imported(order: Order) {
    const base = setParameter(
      createProjectDocument('Issue 1244', toUserId('user_issue_1244')),
      { name: 'shift', expression: '0' }
    );
    const torus = importStepBody(base, {
      name: 'Torus',
      artifactId: 'issue-1244-torus',
      sourceName: 'torus.step',
      stepText: fixture('torus.step')
    });
    const block = importStepBody(torus.document, {
      name: 'Block',
      artifactId: 'issue-1244-block',
      sourceName: 'holed-block.step',
      stepText: fixture('holed-block.step')
    });
    const moved = transformBody(block.document, {
      name: 'Shift block',
      targetBodyId: block.bodyId,
      translation: { x: 'shift', y: 0, z: 0 }
    });
    const common = booleanBodies(moved.document, {
      name: 'Common',
      operation: 'intersect',
      targetBodyIds:
        order === 'torus first'
          ? [torus.bodyId, moved.bodyId]
          : [moved.bodyId, torus.bodyId]
    });
    return { document: common.document, bodyId: common.bodyId };
  }

  it.each(ORDERS)(
    'intersects exactly with the hole excluded, %s, on every replay',
    async (order) => {
      const { document, bodyId } = imported(order);
      const edited = setParameter(document, {
        name: 'shift',
        expression: '1'
      });
      for (const [route, derived] of await replays(document, edited)) {
        const shifted = route === 'upstream edit' ? 1 : 0;
        const body = derived.bodyRepresentations[bodyId];
        expect(blocking(derived), route).toEqual([]);
        expect(derived.warnings, route).toEqual([]);
        expect(body, route).toBeDefined();
        expect(body!.consumed, route).toBeFalsy();
        const expected = shifted ? SHIFTED_VOLUME : INTERSECTION_VOLUME;
        expect(
          Math.abs(body!.volume - expected) / expected,
          `${route}: volume ${body!.volume}`
        ).toBeLessThan(VOLUME_TOLERANCE);
        const hole = { ...HOLE_WITNESS, x: HOLE_WITNESS.x + shifted };
        expect(Math.abs(windingNumber(body!.mesh, hole)), route).toBeLessThan(
          0.5
        );
        expect(
          windingNumber(body!.mesh, MATERIAL_WITNESS),
          route
        ).toBeGreaterThan(0.5);
      }
    },
    300_000
  );
});

describe('#1244 on operands modelled in the app', () => {
  /**
   * The same pair built from primitives: a torus, and a centred box less a
   * centred cylinder, scaled 0.82 and moved to (6, 1, 0.5). The hole radius
   * is a parameter, so an upstream edit replays the stored Intersect. Remus
   * cannot certify this torus's degenerate-seam layout and refuses it by
   * name; the refusal must hold on every replay, and the bodies must stay.
   */
  function modelled(order: Order) {
    let document = setParameter(
      createProjectDocument('Issue 1244 native', toUserId('user_issue_1244')),
      { name: 'hole_radius', expression: '3' }
    );
    const torusIds = createBodyFeatureIds();
    document = addPrimitiveFeature(document, {
      name: 'Torus',
      primitiveKind: 'torus',
      dimensions: { majorRadius: 7, minorRadius: 3 },
      ids: torusIds
    });
    const boxIds = createBodyFeatureIds();
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 24, height: 18, depth: 12 },
      ids: boxIds
    });
    const centred = transformBody(document, {
      name: 'Centre block',
      targetBodyId: boxIds.bodyId,
      translation: { x: -12, y: -9, z: -6 }
    });
    const drillIds = createBodyFeatureIds();
    document = addPrimitiveFeature(centred.document, {
      name: 'Drill',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'hole_radius', height: 40 },
      ids: drillIds
    });
    const drill = transformBody(document, {
      name: 'Centre drill',
      targetBodyId: drillIds.bodyId,
      translation: { x: 0, y: 0, z: -20 }
    });
    const holed = booleanBodies(drill.document, {
      name: 'Hole',
      operation: 'subtract',
      targetBodyIds: [centred.bodyId, drill.bodyId]
    });
    const placed = transformBody(holed.document, {
      name: 'Place block',
      targetBodyId: holed.bodyId,
      translation: { x: 6, y: 1, z: 0.5 },
      scale: 0.82
    });
    const first = order === 'torus first' ? torusIds.bodyId : placed.bodyId;
    const second = order === 'torus first' ? placed.bodyId : torusIds.bodyId;
    const common = booleanBodies(placed.document, {
      name: 'Common',
      operation: 'intersect',
      targetBodyIds: [first, second]
    });
    return { document: common.document, bodyId: common.bodyId, first };
  }

  it.each(ORDERS)(
    'refuses by name and keeps both bodies, %s, on every replay',
    async (order) => {
      const { document, bodyId, first } = modelled(order);
      const edited = setParameter(document, {
        name: 'hole_radius',
        expression: '2.9'
      });
      for (const [route, derived] of await replays(document, edited)) {
        const refusals = blocking(derived);
        expect(refusals, route).toHaveLength(1);
        const [refusal] = refusals;
        expect(refusal!.featureName, route).toBe('Common');
        // A typed refusal: either the kernel's own, or the adapter's
        // material check should a later kernel accept a wrong body.
        expect(refusal!.kernelRefusal, route).toBeDefined();
        expect(
          [
            'boolean/quality_refused/exact_only_unattainable',
            'validation/internal/intersect_kept_outside_material'
          ],
          `${route}: ${refusal!.message}`
        ).toContain(
          `${refusal!.kernelRefusal!.family}/${refusal!.kernelRefusal!.category}/${refusal!.kernelRefusal!.code}`
        );
        expectPassedThrough(derived, bodyId, first);
      }
    },
    300_000
  );
});

describe('a wrong intersection the kernel reports as built', () => {
  /**
   * Forges the #1244 failure mode: the kernel's typed intersect entry
   * points (plain and cancellable) report `ok` and hand back the target
   * untouched, which keeps material outside the tool. Nothing structural is
   * wrong with that body, so only the material check can refuse it — on
   * every route that replays the stored operation.
   */
  function forgeIntersect(): void {
    vi.spyOn(RemusKernel.prototype, 'intersectDetailed').mockImplementation(
      function (this: RemusKernel, a: number) {
        return {
          status: 'ok',
          value: this.copySolid(a)
        } as ReturnType<RemusKernel['intersectDetailed']>;
      }
    );
    const cancellable = RemusKernel.prototype.booleanWithCancellation;
    vi.spyOn(
      RemusKernel.prototype,
      'booleanWithCancellation'
    ).mockImplementation(function (
      this: RemusKernel,
      ...args: Parameters<RemusKernel['booleanWithCancellation']>
    ) {
      if (args[0] !== 'intersect') return cancellable.apply(this, args);
      return {
        status: 'completed',
        result: { solid: this.copySolid(args[1]), quality: 'exact' }
      };
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function expectMaterialRefusal(derived: DerivedState, route: string) {
    const refusals = blocking(derived);
    expect(refusals, route).toHaveLength(1);
    expect(refusals[0]!.kernelRefusal, route).toEqual({
      family: 'validation',
      category: 'internal',
      code: 'intersect_kept_outside_material'
    });
    expect(refusals[0]!.message, route).toContain(
      'Intersect refused: the exact kernel returned material that lies outside'
    );
  }

  it('refuses a Boolean Intersect fresh, after a reload and after an upstream edit', async () => {
    let document = setParameter(
      createProjectDocument('Forged', toUserId('user_issue_1244')),
      { name: 'drill_radius', expression: '6' }
    );
    const boxIds = createBodyFeatureIds();
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 60, height: 60, depth: 20 },
      ids: boxIds
    });
    const drillIds = createBodyFeatureIds();
    document = addPrimitiveFeature(document, {
      name: 'Drill',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'drill_radius', height: 30 },
      ids: drillIds
    });
    const placed = transformBody(document, {
      name: 'Place drill',
      targetBodyId: drillIds.bodyId,
      translation: { x: 30, y: 30, z: -5 }
    });
    const common = booleanBodies(placed.document, {
      name: 'Common',
      operation: 'intersect',
      targetBodyIds: [boxIds.bodyId, placed.bodyId]
    });
    // The unforged kernel builds it: the check accepts a correct body.
    const honest = await coldSync(common.document);
    expect(blocking(honest)).toEqual([]);
    expect(honest.bodyRepresentations[common.bodyId]!.volume).toBeCloseTo(
      Math.PI * 36 * 20,
      0
    );
    forgeIntersect();
    const edited = setParameter(common.document, {
      name: 'drill_radius',
      expression: '5'
    });
    for (const [route, derived] of await replays(common.document, edited)) {
      expectMaterialRefusal(derived, route);
      expectPassedThrough(derived, common.bodyId, boxIds.bodyId);
    }
  }, 300_000);

  it('refuses an extrude Intersect fresh, after a reload and after an upstream edit', async () => {
    let document = setParameter(
      createProjectDocument('Forged extrude', toUserId('user_issue_1244')),
      { name: 'column', expression: '10' }
    );
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    const blockId = document.bodyOrder[0]!;
    const sketched = addSketchFeature(document, {
      name: 'Square',
      planeRef: { type: 'canonical', plane: 'XY', offset: -5 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 'column',
          height: 'column',
          centerX: 10,
          centerY: 10
        }
      ]
    });
    const column = extrudeSketch(sketched.document, {
      name: 'Keep column',
      sketchId: sketched.sketchId,
      distance: 20,
      operation: 'intersect',
      targetBodyId: blockId
    });
    const honest = await coldSync(column.document);
    expect(blocking(honest)).toEqual([]);
    expect(honest.bodyRepresentations[column.bodyId]!.volume).toBeCloseTo(
      10 * 10 * 10,
      6
    );
    forgeIntersect();
    const edited = setParameter(column.document, {
      name: 'column',
      expression: '8'
    });
    for (const [route, derived] of await replays(column.document, edited)) {
      expectMaterialRefusal(derived, route);
    }
  }, 300_000);
});
