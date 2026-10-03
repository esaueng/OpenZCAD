import { describe, expect, it, vi } from 'vitest';
import {
  analyzeUnionConnectivity,
  disconnectedUnionWarning,
  type UnionSolid
} from '../packages/kernel-adapter/src/union-connectivity';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  certifiedSolidDistance,
  fuseUniformSolidChecked,
  isFaceConnectedSolid,
  solidsHavePositiveExactIntersection,
  solidsShareMaterialOrTouch,
  verdictRefusesUnion
} from '../packages/kernel-adapter/src/exact-boolean-helpers';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

function box(
  solid: string,
  min: [number, number, number],
  max: [number, number, number]
): UnionSolid<string> {
  return {
    solid,
    bounds: {
      min: { x: min[0], y: min[1], z: min[2] },
      max: { x: max[0], y: max[1], z: max[2] }
    }
  };
}

describe('Union connectivity', () => {
  it('rejects a real gap and reports the exact closest distance', () => {
    const distance = vi.fn(() => 2);
    const result = analyzeUnionConnectivity(
      [
        box('lower', [0, 0, 0], [10, 10, 10]),
        box('upper', [0, 0, 12], [10, 10, 22])
      ],
      distance
    );

    expect(result).toMatchObject({
      connected: false,
      componentCount: 2,
      closestGap: 2
    });
    expect(distance).toHaveBeenCalledTimes(1);
    expect(disconnectedUnionWarning(result, 'mm')).toBe(
      'Union does not fill empty space. The selected solids form 2 disconnected groups. The closest gap is 2 mm. Move or extend a body until every solid touches or overlaps.'
    );
  });

  it('accepts a chain when each solid touches the next one', () => {
    const result = analyzeUnionConnectivity(
      [
        box('a', [0, 0, 0], [10, 10, 10]),
        box('b', [0, 0, 10], [10, 10, 20]),
        box('c', [0, 0, 20], [10, 10, 30])
      ],
      () => 0
    );

    expect(result).toMatchObject({
      connected: true,
      componentCount: 1,
      closestGap: null
    });
  });

  it('uses exact distance when bounding boxes overlap without contact', () => {
    const result = analyzeUnionConnectivity(
      [
        box('ring-left', [0, 0, 0], [10, 10, 10]),
        box('ring-right', [5, 5, 0], [15, 15, 10])
      ],
      () => 1.25
    );

    expect(result).toMatchObject({
      connected: false,
      componentCount: 2,
      closestGap: 1.25
    });
  });

  it('accepts volume overlap when a kernel distance reports penetration', () => {
    const overlap = vi.fn(() => true);
    const result = analyzeUnionConnectivity(
      [
        box('wall', [0, 32, 7.5], [80, 40, 39.5]),
        box('boss', [30, 22, 14], [50, 34, 34])
      ],
      () => 2,
      overlap
    );

    expect(result).toMatchObject({
      connected: true,
      componentCount: 1,
      closestGap: null
    });
    expect(overlap).toHaveBeenCalledTimes(1);
  });

  it('does not mistake a visually tiny gap for contact', () => {
    const result = analyzeUnionConnectivity(
      [
        box('lower', [0, 0, 0], [10, 10, 10]),
        box('upper', [0, 0, 10.00000001], [10, 10, 20.00000001])
      ],
      () => 1e-8
    );

    expect(result.connected).toBe(false);
    expect(result.contactTolerance).toBeLessThan(1e-8);
  });

  it('scales numerical contact tolerance for far-translated geometry', () => {
    const result = analyzeUnionConnectivity(
      [
        box('lower', [1e9, 0, 0], [1e9 + 10, 10, 10]),
        box('upper', [1e9, 0, 10], [1e9 + 10, 10, 20])
      ],
      () => 1e-7
    );

    expect(result.connected).toBe(true);
    expect(result.contactTolerance).toBeGreaterThan(1e-7);
  });

  it('rejects a connectivity graph above the bounded pair budget', () => {
    const solids = Array.from({ length: 318 }, (_, index) =>
      box(String(index), [index * 2, 0, 0], [index * 2 + 1, 1, 1])
    );
    expect(() => analyzeUnionConnectivity(solids, () => 1)).toThrow(
      /limit is 50000/
    );
  });

  it('keeps unsupported distance unknown until shared material is proved', () => {
    const solids = [
      box('a', [0, 0, 0], [10, 10, 10]),
      box('b', [5, 5, 0], [15, 15, 10])
    ];
    const distance = vi.fn(() => null);
    expect(
      analyzeUnionConnectivity(solids, distance, () => false)
    ).toMatchObject({
      connected: false,
      uncertain: true,
      closestGap: null
    });
    expect(distance).toHaveBeenCalledTimes(1);
    expect(
      analyzeUnionConnectivity(
        solids,
        () => null,
        () => true
      )
    ).toMatchObject({
      connected: true,
      uncertain: false,
      closestGap: null
    });
  });

  it('keeps a proven box gap disconnected when distance is unsupported', () => {
    const overlap = vi.fn(() => true);
    expect(
      analyzeUnionConnectivity(
        [
          box('a', [0, 0, 0], [1, 1, 1]),
          box('b', [0, 0, 1.00000001], [1, 1, 2])
        ],
        () => null,
        overlap
      )
    ).toMatchObject({
      connected: false,
      uncertain: false,
      closestGap: null
    });
    expect(overlap).not.toHaveBeenCalled();
  });

  it('cannot defer a separated third component to an unknown pair', () => {
    expect(
      analyzeUnionConnectivity(
        [
          box('a', [0, 0, 0], [10, 10, 10]),
          box('b', [5, 5, 0], [15, 15, 10]),
          box('c', [30, 0, 0], [40, 10, 10])
        ],
        () => null,
        () => false
      )
    ).toMatchObject({
      connected: false,
      uncertain: false,
      componentCount: 3
    });
  });

  it.each([NaN, Infinity, -1])(
    'rejects invalid distance %s despite overlap claims',
    (distance) => {
      expect(() =>
        analyzeUnionConnectivity(
          [
            box('a', [0, 0, 0], [10, 10, 10]),
            box('b', [5, 5, 0], [15, 15, 10])
          ],
          () => distance,
          () => true
        )
      ).toThrow('invalid solid distance');
    }
  );
});

function serialized(kernel: RemusKernel, solids: number[]): number[] {
  return Array.from(kernel.serializeSolids(Uint32Array.from(solids)));
}

function move(
  kernel: RemusKernel,
  solid: number,
  x: number,
  y: number,
  z: number
): number {
  kernel.transformSolid(
    solid,
    transformMatrix({ x, y, z }, { x: 0, y: 0, z: 0 })
  );
  return solid;
}

describe('certified curved union connectivity', () => {
  it('keeps the installed SDK carrier-scope distance refusal unknown', () => {
    const kernel = new RemusKernel();
    try {
      const cylinder = kernel.makeCylinder(2, 2);
      const sphere = kernel.makeSphere(1, 32);
      const before = serialized(kernel, [cylinder, sphere]);
      // No injected diagnostic: this calls the real released WASM distance.
      expect(() => kernel.solidToSolidDistance(cylinder, sphere)).toThrow();
      expect(certifiedSolidDistance(kernel, cylinder, sphere)).toBeNull();
      expect(() =>
        certifiedSolidDistance(kernel, 0xffffffff, sphere)
      ).toThrow();
      expect(serialized(kernel, [cylinder, sphere])).toEqual(before);
    } finally {
      kernel.free();
    }
  });

  it.each([
    { cap: 'lower', centerZ: 8 },
    { cap: 'upper', centerZ: 12 }
  ])(
    'preserves contained sphere tangency at the $cap cylinder cap',
    ({ centerZ }) => {
      const kernel = new RemusKernel();
      try {
        const container = kernel.makeCylinder(10, 20);
        const sphere = move(kernel, kernel.makeSphere(8, 32), 0, 0, centerZ);
        const before = serialized(kernel, [container, sphere]);
        // The sphere's radius is smaller than the cylinder's and its axial
        // extent touches one cap exactly. Their union is the whole cylinder.
        expect(solidsShareMaterialOrTouch(kernel, container, sphere)).toBe(
          true
        );
        const result = fuseUniformSolidChecked(kernel, [container, sphere]);
        expect(verdictRefusesUnion(result.verdict)).toBe(false);
        expect(kernel.validateSolid(result.solid)).toBe(0);
        expect(isFaceConnectedSolid(kernel, result.solid)).toBe(true);
        expect(
          Array.from(kernel.getSolidFaces(result.solid), (face) =>
            kernel.getSurfaceType(face)
          ).sort()
        ).toEqual(['cylinder', 'plane', 'plane']);
        const quality: unknown = kernel.meshQuality(result.solid, 0.05);
        if (typeof quality !== 'string') {
          throw new Error('Mesh quality did not return its JSON payload.');
        }
        const parsedQuality: unknown = JSON.parse(quality);
        expect(parsedQuality).toMatchObject({ isWatertight: true });
        expect(kernel.volume(result.solid, 0.01)).toBeCloseTo(
          2000 * Math.PI,
          9
        );
        expect(Array.from(kernel.boundingBox(result.solid))).toEqual([
          -10, -10, 0, 10, 10, 20
        ]);
        // The center remains material; a point beyond the sphere proves that
        // the result retains the cylinder instead of returning the smaller body.
        expect(kernel.classifyPoint(result.solid, 0, 0, centerZ, 1e-7)).toBe(
          'inside'
        );
        expect(kernel.classifyPoint(sphere, 9, 0, 10, 1e-7)).toBe('outside');
        expect(kernel.classifyPoint(result.solid, 9, 0, 10, 1e-7)).toBe(
          'inside'
        );
        expect(serialized(kernel, [container, sphere])).toEqual(before);
      } finally {
        kernel.free();
      }
    }
  );

  it.each([
    { cap: 'lower', centerZ: 8 },
    { cap: 'upper', centerZ: 12 }
  ])(
    'publishes contained sphere tangency at the $cap cap through the document adapter',
    async ({ centerZ }) => {
      const adapter = await createExactKernelAdapter();
      try {
        let document = addPrimitiveFeature(
          createProjectDocument('Sphere cap contact', toUserId('union-test')),
          {
            name: 'Container',
            primitiveKind: 'cylinder',
            dimensions: { radius: 10, height: 20 }
          }
        );
        const container = document.bodyOrder.at(-1)!;
        document = addPrimitiveFeature(document, {
          name: 'Sphere',
          primitiveKind: 'sphere',
          dimensions: { radius: 8 }
        });
        const moved = transformBody(document, {
          name: 'Touch cap',
          targetBodyId: document.bodyOrder.at(-1)!,
          translation: { x: 0, y: 0, z: centerZ }
        });
        const united = booleanBodies(moved.document, {
          name: 'Keep container',
          operation: 'union',
          targetBodyIds: [container, moved.bodyId]
        });
        const before = JSON.stringify(united.document);
        const result = await adapter.syncDocument(united.document);
        expect(result.warnings).toEqual([]);
        const body = result.bodyRepresentations[united.bodyId]!;
        expect(body).toBeDefined();
        expect(body.volume).toBeCloseTo(2000 * Math.PI, 9);
        expect(body.faceCount).toBe(3);
        expect(body.bbox).toEqual({
          min: { x: -10, y: -10, z: 0 },
          max: { x: 10, y: 10, z: 20 }
        });
        expect(
          body.topology?.faces.map((face) => face.geometry?.surfaceType).sort()
        ).toEqual(['cylinder', 'plane', 'plane']);
        expect(JSON.stringify(united.document)).toBe(before);
      } finally {
        adapter.dispose();
      }
    }
  );

  it('preserves the corner-axis box/cylinder union and both inputs', () => {
    const kernel = new RemusKernel();
    try {
      const plate = kernel.makeBox(60, 40, 8);
      const boss = kernel.makeCylinder(10, 16);
      const before = serialized(kernel, [plate, boss]);
      expect(kernel.classifyPoint(plate, 1, 1, 12, 1e-7)).toBe('outside');
      expect(kernel.classifyPoint(boss, 1, 1, 12, 1e-7)).toBe('inside');
      expect(solidsShareMaterialOrTouch(kernel, plate, boss)).toBe(true);
      const result = fuseUniformSolidChecked(kernel, [plate, boss]);
      expect(verdictRefusesUnion(result.verdict)).toBe(false);
      expect(isFaceConnectedSolid(kernel, result.solid)).toBe(true);
      expect(kernel.volume(result.solid, 0.01)).toBeCloseTo(
        19200 + 1400 * Math.PI,
        7
      );
      expect(Array.from(kernel.boundingBox(result.solid))).toEqual([
        -10, -10, 0, 60, 40, 16
      ]);
      expect(kernel.classifyPoint(result.solid, 1, 1, 12, 1e-7)).toBe('inside');
      expect(kernel.classifyPoint(result.solid, 30, 20, 4, 1e-7)).toBe(
        'inside'
      );
      expect(serialized(kernel, [plate, boss])).toEqual(before);
    } finally {
      kernel.free();
    }
  });

  it('proves full-rim cylinder contact through the actual exact fused topology', () => {
    const kernel = new RemusKernel();
    try {
      const lower = kernel.makeCylinder(2, 2);
      const upper = move(kernel, kernel.makeCylinder(2, 2), 0, 0, 2);
      const before = serialized(kernel, [lower, upper]);
      expect(solidsHavePositiveExactIntersection(kernel, lower, upper)).toBe(
        false
      );
      expect(solidsShareMaterialOrTouch(kernel, lower, upper)).toBe(true);
      const result = fuseUniformSolidChecked(kernel, [lower, upper]);
      expect(verdictRefusesUnion(result.verdict)).toBe(false);
      expect(kernel.volume(result.solid, 0.01)).toBeCloseTo(16 * Math.PI, 9);
      expect(kernel.classifyPoint(result.solid, 0, 0, 1, 1e-7)).toBe('inside');
      expect(kernel.classifyPoint(result.solid, 0, 0, 3, 1e-7)).toBe('inside');
      expect(serialized(kernel, [lower, upper])).toEqual(before);
    } finally {
      kernel.free();
    }
  });

  it('rejects disjoint cylinders despite overlapping carrier boxes', () => {
    const kernel = new RemusKernel();
    try {
      const a = kernel.makeCylinder(1, 2);
      const b = move(kernel, kernel.makeCylinder(1, 2), 1.6, 1.6, 0);
      const before = serialized(kernel, [a, b]);
      // Center distance 1.6*sqrt(2) exceeds the sum of radii, while both
      // axis-aligned boxes overlap on x and y by 0.4.
      expect(1.6 * Math.SQRT2 - 2).toBeGreaterThan(0.26);
      expect(kernel.boundingBox(a)[3]! - kernel.boundingBox(b)[0]!).toBeCloseTo(
        0.4,
        12
      );
      expect(solidsShareMaterialOrTouch(kernel, a, b)).toBe(false);
      expect(serialized(kernel, [a, b])).toEqual(before);
    } finally {
      kernel.free();
    }
  });

  it('rejects a body in a through-hole despite contained carrier boxes', () => {
    const kernel = new RemusKernel();
    try {
      const outer = kernel.makeCylinder(3, 2);
      const bore = kernel.makeCylinder(2, 2);
      const ring = kernel.cut(outer, bore);
      const insert = kernel.makeCylinder(1, 2);
      const before = serialized(kernel, [ring, insert]);
      expect(kernel.volume(ring, 0.01)).toBeCloseTo(10 * Math.PI, 9);
      expect(kernel.classifyPoint(ring, 0, 0, 1, 1e-7)).toBe('outside');
      expect(kernel.classifyPoint(insert, 0, 0, 1, 1e-7)).toBe('inside');
      expect(solidsShareMaterialOrTouch(kernel, ring, insert)).toBe(false);
      expect(serialized(kernel, [ring, insert])).toEqual(before);
    } finally {
      kernel.free();
    }
  });

  it('does not let a tolerant exact fuse bridge a real cylinder gap', () => {
    const kernel = new RemusKernel();
    try {
      const lower = kernel.makeCylinder(2, 2);
      const upper = move(kernel, kernel.makeCylinder(2, 2), 0, 0, 2 + 1e-8);
      const before = serialized(kernel, [lower, upper]);
      expect(solidsShareMaterialOrTouch(kernel, lower, upper)).toBe(false);
      expect(serialized(kernel, [lower, upper])).toEqual(before);
    } finally {
      kernel.free();
    }
  });

  it('keeps malformed distance answers and unrelated failures as errors', () => {
    const kernel = new RemusKernel();
    try {
      const a = kernel.makeCylinder(1, 2);
      const b = kernel.makeCylinder(1, 2);
      const distance = vi.spyOn(kernel, 'solidToSolidDistance');
      for (const value of [NaN, Infinity, -1]) {
        distance.mockReturnValue(Float64Array.of(value));
        expect(() => certifiedSolidDistance(kernel, a, b)).toThrow(
          'invalid solid distance'
        );
      }
      distance.mockImplementation(() => {
        throw new Error('invalid solid handle');
      });
      expect(() => certifiedSolidDistance(kernel, a, b)).toThrow(
        'invalid solid handle'
      );
      distance.mockImplementation(() => {
        throw new Error(
          'check: distance computation failed: a certified solid boundary minimum requires unexpected geometry'
        );
      });
      expect(() => certifiedSolidDistance(kernel, a, b)).toThrow(
        'unexpected geometry'
      );
    } finally {
      vi.restoreAllMocks();
      kernel.free();
    }
  });

  it('publishes the exact stacked-cylinder union through the document adapter', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      let document = addPrimitiveFeature(
        createProjectDocument('Rim contact', toUserId('union-test')),
        {
          name: 'Lower',
          primitiveKind: 'cylinder',
          dimensions: { radius: 2, height: 2 }
        }
      );
      const lower = document.bodyOrder.at(-1)!;
      document = addPrimitiveFeature(document, {
        name: 'Upper',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 2 }
      });
      const moved = transformBody(document, {
        name: 'Place upper',
        targetBodyId: document.bodyOrder.at(-1)!,
        translation: { x: 0, y: 0, z: 2 }
      });
      const united = booleanBodies(moved.document, {
        name: 'Join rims',
        operation: 'union',
        targetBodyIds: [lower, moved.bodyId]
      });
      const result = await adapter.syncDocument(united.document);
      expect(result.warnings).toEqual([]);
      expect(result.bodyRepresentations[united.bodyId]!.volume).toBeCloseTo(
        16 * Math.PI,
        9
      );
    } finally {
      adapter.dispose();
    }
  });

  it('refuses a known gap even when an injected fused solid fills it', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      let document = addPrimitiveFeature(
        createProjectDocument('Gap guard', toUserId('union-test')),
        {
          name: 'Lower',
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        }
      );
      const lower = document.bodyOrder.at(-1)!;
      document = addPrimitiveFeature(document, {
        name: 'Upper',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
      const moved = transformBody(document, {
        name: 'Leave gap',
        targetBodyId: document.bodyOrder.at(-1)!,
        translation: { x: 0, y: 0, z: 12 }
      });
      const united = booleanBodies(moved.document, {
        name: 'Wrong bridge',
        operation: 'union',
        targetBodyIds: [lower, moved.bodyId]
      });
      vi.spyOn(RemusKernel.prototype, 'fuseAll').mockImplementation(function (
        this: RemusKernel
      ) {
        return this.makeBox(10, 10, 22);
      });
      const result = await adapter.syncDocument(united.document);
      const disconnected = result.featureWarnings!.find(
        (warning) =>
          warning.featureName === 'Wrong bridge' &&
          warning.message.includes('2 disconnected groups')
      );
      expect(disconnected?.kind).toBe('refusal');
      expect(
        result.featureWarnings!.some((warning) =>
          warning.message.includes('closest gap is 2 mm')
        )
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
      adapter.dispose();
    }
  });
});
