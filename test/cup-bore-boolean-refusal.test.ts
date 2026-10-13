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
 * CAD-001 / remus#984: a centre-line bore used to make a crossing-wall fuse
 * refuse and a contained-wall fuse silently add material. Remus 2026.1.53
 * fixes both cases. Require exact results through the adapter and raw WASM.
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
      const refusal = (derived.featureWarnings ?? []).find(
        (warning) => warning.featureName === 'Ear union'
      );
      return {
        refusal,
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

    it('fuses exactly an ear that crosses the wall', async () => {
      const { refusal, body } = await union([4, 6, 4], [-3, 5, 3]);
      expect(refusal).toBeUndefined();
      expect(body?.volume).toBeCloseTo(CUP_WITH_BORE + EAR_OUTSIDE_WALL, 6);
      expect(body?.faceCount).toBe(17);
    });

    it('leaves the cup unchanged for a tool wholly inside the wall', async () => {
      const { refusal, body } = await union([1, 6, 4], [0.5, 5, 3]);
      expect(refusal).toBeUndefined();
      expect(body?.volume).toBeCloseTo(CUP_WITH_BORE, 6);
    });
  }
);

/** Keep the former refusal and silent wrong result fixed in the installed WASM. */
describe('kernel regression: centre-line bore classification', () => {
  const T = (x: number, y: number, z: number) =>
    new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);

  it('fuses crossing and contained tools exactly without changing the operands', () => {
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

      const earTool = box(-3, 5, 3, 4, 6, 4);
      const insideTool = box(0.5, 5, 3, 1, 6, 4);
      const operands = new Uint32Array([bored, earTool, insideTool]);
      const before = k.serializeSolids(operands);
      const exact = (solid: number, volume: number) => {
        expect(k.volume(solid, 1e-3)).toBeCloseTo(volume, 6);
        const mass: unknown = k.massProperties(solid);
        const quality: unknown = k.meshQuality(solid, 0.05);
        if (typeof mass !== 'string' || typeof quality !== 'string') {
          throw new Error('Expected kernel mass and mesh JSON payloads.');
        }
        const massPayload: unknown = JSON.parse(mass);
        const meshPayload: unknown = JSON.parse(quality);
        expect(massPayload).toHaveProperty('volume', expect.closeTo(volume, 6));
        expect(k.validateSolid(solid)).toBe(0);
        expect(meshPayload).toMatchObject({
          isWatertight: true,
          boundaryEdges: 0,
          nonManifoldEdges: 0
        });
      };

      const ear = ok(k.fuseDetailed(bored, earTool));
      exact(ear, CUP_WITH_BORE + EAR_OUTSIDE_WALL);
      expect(k.getSolidFaces(ear)).toHaveLength(17);
      expect(k.classifyPoint(ear, -2, 8, 5, 1e-7)).toBe('inside');
      expect(k.classifyPoint(ear, 10, 10, 1, 1e-7)).toBe('outside');
      // The same ear on the cup without the bore still fuses exactly.
      exact(
        ok(k.fuseDetailed(cup, box(-3, 5, 3, 4, 6, 4))),
        20 * 20 * 10 - 16 * 16 * 8 + EAR_OUTSIDE_WALL
      );

      const inside = ok(k.fuseDetailed(bored, insideTool));
      exact(inside, CUP_WITH_BORE);
      expect(k.getSolidFaces(inside)).toHaveLength(
        k.getSolidFaces(bored).length
      );
      expect(k.serializeSolids(operands)).toEqual(before);
    } finally {
      k.free();
    }
  });
});
