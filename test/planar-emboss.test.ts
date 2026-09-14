import { beforeAll, expect, it } from 'vitest';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import {
  recognizePlanarEmboss,
  separatePlanarEmboss
} from '../packages/kernel-adapter/src/planar-emboss';
import { letteredHolder } from './support/lettered-holder';
import { faceFingerprint } from '../packages/kernel-adapter/src/exact-witnesses';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';

beforeAll(loadRemusTranslators);

it('verifies lettering in a rigidly placed frame while retaining the exact original profiles', () => {
  const kernel = new RemusKernel();
  try {
    const source = letteredHolder(kernel);
    const original = recognizePlanarEmboss(kernel, source)!;
    const placement = [
      {
        translation: { x: 20, y: -13, z: 4 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      },
      { translation: { x: 3, y: 7, z: -2 }, rotationDeg: { x: 0, y: 0, z: 90 } }
    ];
    let placed = source;
    for (const transform of placement)
      placed = kernel.copyAndTransformSolid(
        placed,
        transformMatrix(transform.translation, transform.rotationDeg)
      );
    const measured = recognizePlanarEmboss(kernel, placed)!;
    expect(measured).not.toBeNull();
    expect(measured.capFaceHashes).not.toEqual(original.capFaceHashes);
    for (const part of ['base', 'text'] as const) {
      const expected = separatePlanarEmboss(kernel, source, original, part);
      const actual = separatePlanarEmboss(
        kernel,
        source,
        measured,
        part,
        placement
      );
      expect(kernel.serializeSolids(Uint32Array.from(actual))).toEqual(
        kernel.serializeSolids(Uint32Array.from(expected))
      );
      expect(() =>
        separatePlanarEmboss(
          kernel,
          source,
          measured,
          part,
          [...placement].reverse()
        )
      ).toThrow(/no longer matches/);
      expect(() =>
        separatePlanarEmboss(kernel, source, original, part, placement)
      ).toThrow(/no longer matches/);
    }
  } finally {
    kernel.free();
  }
});
it('separates exact concave raised profiles and retains source identity', () => {
  const kernel = new RemusKernel();
  try {
    const source = letteredHolder(kernel);
    const before = kernel.serializeSolids(Uint32Array.of(source));
    const measurement = recognizePlanarEmboss(kernel, source)!;
    expect(measurement.capFaceHashes).toHaveLength(2);
    expect(measurement.depth).toBe(0.4);
    const [base] = separatePlanarEmboss(kernel, source, measurement, 'base');
    const text = separatePlanarEmboss(kernel, source, measurement, 'text');
    expect(text).toHaveLength(2);
    const outputFaces = text.flatMap((solid) => [
      ...kernel.getSolidFaces(solid)
    ]);
    for (const hash of measurement.capFaceHashes) {
      expect(
        outputFaces.filter((face) => faceFingerprint(kernel, face) === hash)
      ).toHaveLength(1);
    }
    for (const solid of [base!, ...text])
      expect(kernel.validateSolid(solid)).toBe(0);
    const volumes = text
      .map((s) => kernel.volume(s, 0.01))
      .sort((a, b) => a - b);
    expect(volumes[0]).toBeCloseTo(7.2, 6);
    expect(volumes[1]).toBeCloseTo(9.6, 6);
    expect(kernel.volume(source, 0.01)).toBeCloseTo(
      kernel.volume(base!, 0.01) +
        text.reduce((s, t) => s + kernel.volume(t, 0.01), 0),
      6
    );
    expect(kernel.serializeSolids(Uint32Array.of(source))).toEqual(before);
    expect(() =>
      separatePlanarEmboss(
        kernel,
        source,
        { ...measurement, depth: 0.8 },
        'base'
      )
    ).toThrow(/no longer matches/);
    expect(() =>
      separatePlanarEmboss(
        kernel,
        source,
        { ...measurement, capFaceHashes: [1, 2] },
        'text'
      )
    ).toThrow(/no longer matches/);
  } finally {
    kernel.free();
  }
}, 30_000);

it.each([
  ['engraved', { engraved: true }],
  ['uneven depth', { unevenDepth: true }],
  ['ambiguous support faces', { bothArms: true }]
])(
  'refuses %s rather than removing unproven material',
  (_label, options) => {
    const kernel = new RemusKernel();
    try {
      expect(
        recognizePlanarEmboss(kernel, letteredHolder(kernel, options))
      ).toBeNull();
    } finally {
      kernel.free();
    }
  },
  30_000
);
