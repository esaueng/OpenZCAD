import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FaceGeometry } from '@openzcad/shared';
import { RemusKernel } from './remus-runtime';
import {
  boreAxisMeasurement,
  classifyThroughHoleFace,
  measureFaceGeometry,
  withFaceGeometryMemo
} from './exact-measure';

/**
 * One body measurement reads each face from several places (its published
 * geometry, the imported-feature query, the opening inventory). The memo
 * makes that one kernel read per listed face, hands every caller its own
 * copy, and never answers for a handle it was not given or outside its scope.
 */
describe('face geometry memo', () => {
  let kernel: RemusKernel | null = null;
  afterEach(() => {
    kernel?.free();
    kernel = null;
  });

  it('reads each listed face once and returns independent copies', () => {
    kernel = new RemusKernel();
    const box = kernel.makeBox(30, 18, 24);
    const other = kernel.makeBox(5, 5, 5);
    const faces = Array.from(kernel.getSolidFaces(box));
    const otherFace = kernel.getSolidFaces(other)[0]!;
    const fresh = faces.map((face) => measureFaceGeometry(kernel!, face));
    const area = vi.spyOn(kernel, 'faceArea');

    withFaceGeometryMemo(kernel, faces, () => {
      const first = faces.map((face) => measureFaceGeometry(kernel!, face));
      // Callers decorate what they get; the next caller must not see it.
      first[0]!.featureType = 'blend';
      first[0]!.center.x += 1;
      const second = faces.map((face) => measureFaceGeometry(kernel!, face));
      expect(second).toEqual(fresh);
      expect(area).toHaveBeenCalledTimes(faces.length);

      // A handle the scope was not given is always measured afresh.
      measureFaceGeometry(kernel!, otherFace);
      measureFaceGeometry(kernel!, otherFace);
      expect(area).toHaveBeenCalledTimes(faces.length + 2);
    });

    // The memo closes with its scope.
    measureFaceGeometry(kernel, faces[0]!);
    expect(area).toHaveBeenCalledTimes(faces.length + 3);
  });

  it('closes the scope when the measurement throws', () => {
    kernel = new RemusKernel();
    const box = kernel.makeBox(10, 10, 10);
    const faces = Array.from(kernel.getSolidFaces(box));
    const area = vi.spyOn(kernel, 'faceArea');
    expect(() =>
      withFaceGeometryMemo(kernel!, faces, () => {
        measureFaceGeometry(kernel!, faces[0]!);
        throw new Error('measurement failed');
      })
    ).toThrow('measurement failed');
    measureFaceGeometry(kernel, faces[0]!);
    expect(area).toHaveBeenCalledTimes(2);
  });
});

describe('bore classification during solid measurement', () => {
  const cylinder: FaceGeometry = {
    surfaceType: 'cylinder',
    area: 20 * Math.PI,
    center: { x: 0, y: 0, z: 0 },
    axisStart: { x: 0, y: 0, z: 0 },
    axisEnd: { x: 0, y: 0, z: 10 },
    axialLength: 10,
    radius: 1,
    diameter: 2
  };

  it('reuses only the identical interior point during a single pass', () => {
    const kernel = new RemusKernel();
    try {
      const classify = vi
        .spyOn(kernel, 'classifyPoint')
        .mockReturnValueOnce('inside')
        .mockReturnValueOnce('unknown')
        .mockImplementationOnce(() => {
          throw Error('temporary failure');
        })
        .mockReturnValue('outside');
      const outside = boreAxisMeasurement(kernel, 1);
      const point = { x: 0, y: 0, z: 5 };
      expect(outside(point)).toBe(false);
      point.x = 1e-12;
      expect(outside(point)).toBe(false);
      expect(outside(point)).toBe(false);
      expect(outside(point)).toBe(true);
      expect(outside({ ...point, x: 0 })).toBe(false);
      expect(outside({ ...point, x: -0 })).toBe(true);
      expect(boreAxisMeasurement(kernel, 2)({ ...point, x: 0 })).toBe(true);
      expect(boreAxisMeasurement(kernel, 1)({ ...point, x: 0 })).toBe(true);
      expect(classify).toHaveBeenCalledTimes(7);
    } finally {
      kernel.free();
    }
  });

  it.each([
    ['through', true, 7],
    ['boss', false, 1],
    ['external', false, 4],
    ['boundary', false, 4],
    ['mixed', false, 5],
    ['blind', false, 2]
  ] as const)(
    'publishes the same positive proof for %s walls',
    (kind, proven, probes) => {
      const kernel = new RemusKernel();
      try {
        vi.spyOn(kernel, 'getSurfaceDomain').mockReturnValue(
          Float64Array.of(0, 2 * Math.PI, 0, 10)
        );
        const probe = vi
          .spyOn(kernel, 'classifyPoint')
          .mockImplementation((_solid, x, y, z) => {
            if (x === 0 && y === 0) {
              if (kind === 'boss' || (kind === 'blind' && z < 0))
                return 'inside';
              return 'outside';
            }
            if (kind === 'boundary') return 'boundary';
            if (kind === 'external' || (kind === 'mixed' && x > 0.9))
              return 'outside';
            return 'inside';
          });
        const detailed = classifyThroughHoleFace(kernel, 1, 42, cylinder);
        expect(detailed.status === 'through-hole').toBe(proven);
        const reason = detailed.status === 'refused' ? detailed.message : '';
        if (kind === 'blind') expect(reason).toContain('blind pocket');
        if (kind === 'external') expect(reason).toContain('external wall');
        probe.mockClear();
        const measured = classifyThroughHoleFace(
          kernel,
          1,
          42,
          cylinder,
          boreAxisMeasurement(kernel, 1)
        );
        expect(measured.status).toBe(detailed.status);
        expect(probe).toHaveBeenCalledTimes(probes);
      } finally {
        kernel.free();
      }
    }
  );
});
