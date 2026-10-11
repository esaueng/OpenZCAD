import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * Production QA CAD-001 (2026-10-11): a mounting ear overlapping the wall of a
 * shelled gearbox housing would not union with it. Reduced on the pinned
 * kernel (record: docs/qa/2026-10-11/cad-001-cup-bore-boolean.md) to any
 * open cup whose bounding-box centre line runs through a round through-hole
 * in its floor: the kernel's internal sub-face classifier calls material
 * inside the cup "outside", so every boolean with a tool touching it is
 * refused exact-only — and one fuse returns `ok` with the wrong volume.
 *
 * The adapter must stay fail-closed: either a typed refusal, or the exact
 * answer once upstream fixes the classifier. Never a different body.
 */
const CUP_WITH_BORE = 20 * 20 * 10 - 16 * 16 * 8 - Math.PI * 9 * 2; // 1895.4513
const EAR_OUTSIDE_WALL = 3 * 6 * 4; // the part of a 4 × 6 × 4 ear past x = 0

function placed(
  document: ProjectDocument,
  name: string,
  primitive:
    | { primitiveKind: 'box'; size: [number, number, number] }
    | { primitiveKind: 'cylinder'; radius: number; height: number },
  [x, y, z]: [number, number, number]
) {
  const next = addPrimitiveFeature(document, {
    name,
    primitiveKind: primitive.primitiveKind,
    dimensions:
      primitive.primitiveKind === 'box'
        ? {
            width: primitive.size[0],
            height: primitive.size[1],
            depth: primitive.size[2]
          }
        : { radius: primitive.radius, height: primitive.height }
  });
  return transformBody(next, {
    name: `Place ${name}`,
    targetBodyId: next.bodyOrder.at(-1)!,
    translation: { x, y, z }
  });
}

/** 20 × 20 × 10 cup, 2 mm walls and floor, an r3 bore on its centre line. */
function cupWithCentredBore() {
  const outer = placed(
    createProjectDocument('Cup', toUserId('user_cup_bore')),
    'Outer',
    { primitiveKind: 'box', size: [20, 20, 10] },
    [0, 0, 0]
  );
  const cavity = placed(
    outer.document,
    'Cavity',
    { primitiveKind: 'box', size: [16, 16, 10] },
    [2, 2, 2]
  );
  const cup = booleanBodies(cavity.document, {
    name: 'Cup',
    operation: 'subtract',
    targetBodyIds: [outer.bodyId, cavity.bodyId]
  });
  const bore = placed(
    cup.document,
    'Bore',
    { primitiveKind: 'cylinder', radius: 3, height: 4 },
    [10, 10, -1]
  );
  return booleanBodies(bore.document, {
    name: 'Bored cup',
    operation: 'subtract',
    targetBodyIds: [cup.bodyId, bore.bodyId]
  });
}

describe(
  'booleans on a cup bored on its centre line',
  { timeout: 60_000 },
  () => {
    let adapter: ExactKernelAdapter;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });

    afterAll(() => adapter.dispose());

    async function union(
      size: [number, number, number],
      at: [number, number, number]
    ) {
      const cup = cupWithCentredBore();
      const tool = placed(
        cup.document,
        'Ear',
        { primitiveKind: 'box', size },
        at
      );
      const fused = booleanBodies(tool.document, {
        name: 'Ear union',
        operation: 'union',
        targetBodyIds: [cup.bodyId, tool.bodyId]
      });
      const derived = await adapter.syncDocument(fused.document);
      const refused = (derived.featureWarnings ?? []).some(
        (warning) =>
          warning.featureName === 'Ear union' &&
          (warning.kind === 'build-failed' || warning.kind === 'refusal')
      );
      return {
        refused,
        body: derived.bodyRepresentations[fused.bodyId]
      };
    }

    it('builds the bored cup exactly', async () => {
      const cup = cupWithCentredBore();
      const derived = await adapter.syncDocument(cup.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[cup.bodyId]?.volume).toBeCloseTo(
        CUP_WITH_BORE,
        6
      );
    });

    it('refuses or fuses exactly an ear that crosses the wall, never another body', async () => {
      const { refused, body } = await union([4, 6, 4], [-3, 5, 3]);
      if (!refused) {
        expect(body?.volume).toBeCloseTo(CUP_WITH_BORE + EAR_OUTSIDE_WALL, 6);
        expect(body?.faceCount).toBe(17);
      }
    });

    it('refuses or leaves the cup unchanged for a tool wholly inside the wall', async () => {
      // The pinned kernel's fuse answers this one `ok` with the tool's 24 mm³
      // added; only the adapter's union connectivity gate stops it.
      const { refused, body } = await union([1, 6, 4], [0.5, 5, 3]);
      if (!refused) expect(body?.volume).toBeCloseTo(CUP_WITH_BORE, 6);
    });
  }
);

/**
 * Kernel canary, raw Remus calls (the upstream reproduction, remus#984). It pins the
 * defect as it stands so the kernel update that fixes it fails here: then
 * flip these expectations to the exact answers, update the QA record and
 * ROADMAP K01, and recheck the housing union through the app.
 */
describe('kernel canary: centre-line bore misclassification', () => {
  const T = (x: number, y: number, z: number) =>
    new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);

  it('still refuses the exact fuse and still mis-fuses a tool inside the wall', () => {
    const k = new RemusKernel();
    try {
      const box = (
        x: number,
        y: number,
        z: number,
        dx: number,
        dy: number,
        dz: number
      ) => k.copyAndTransformSolid(k.makeBox(dx, dy, dz), T(x, y, z));
      const ok = (result: { status: string; value?: unknown }) => {
        expect(result.status).toBe('ok');
        return result.value as number;
      };
      const cup = ok(
        k.cutDetailed(box(0, 0, 0, 20, 20, 10), box(2, 2, 2, 16, 16, 10))
      );
      const bored = ok(
        k.cutDetailed(
          cup,
          k.copyAndTransformSolid(k.makeCylinder(3, 4), T(10, 10, -1))
        )
      );
      expect(k.volume(bored, 1e-3)).toBeCloseTo(CUP_WITH_BORE, 6);
      expect(k.classifyPoint(bored, 0.5, 8, 5, 1e-7)).toBe('inside');

      // Expected: ok, 17 faces, CUP_WITH_BORE + 72. Actual: exact-only refusal.
      const ear = k.fuseDetailed(bored, box(-3, 5, 3, 4, 6, 4)) as {
        status: string;
        code?: string;
      };
      expect(ear.status).toBe('error');
      expect(ear.code).toBe('exact_only_unattainable');
      // The same ear on the cup without the bore fuses exactly.
      expect(
        k.volume(ok(k.fuseDetailed(cup, box(-3, 5, 3, 4, 6, 4))), 1e-3)
      ).toBeCloseTo(20 * 20 * 10 - 16 * 16 * 8 + EAR_OUTSIDE_WALL, 6);

      // Expected: the cup unchanged. Actual: `ok` with the tool added.
      const inside = ok(k.fuseDetailed(bored, box(0.5, 5, 3, 1, 6, 4)));
      expect(k.volume(inside, 1e-3)).toBeCloseTo(CUP_WITH_BORE + 24, 3);
    } finally {
      k.free();
    }
  });
});
