import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemusKernel } from './remus-runtime';
import { measureFaceGeometry, withFaceGeometryMemo } from './exact-measure';

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
