import { describe, expect, it } from 'vitest';
import type { FaceGeometry, FaceWitnessV1 } from '@openzcad/shared';
import {
  PreviewFaceGeometryCache,
  faceContentDigestsOf,
  type FaceShapeKernel
} from './preview-face-geometry-cache';
import type { RemusKernel } from './remus-runtime';

interface FakeFace {
  normal: number[];
  /** One closed edge, evaluated at a parameter in [0, 1]. */
  curve: (t: number) => number[];
}

/**
 * A fake kernel whose faces share one seam vertex, one closed edge of the
 * same type, one plane and one domain: only what the face list gives them
 * differs.
 */
function kernelWith(faces: Record<number, FakeFace>): FaceShapeKernel {
  return {
    getFaceVertices: () => Uint32Array.from([0]),
    getVertexPosition: () => Float64Array.from([10, 0, 5]),
    getFaceEdges: (face: number) => Uint32Array.from([face]),
    getAnalyticSurfaceParams: () => '{"normal":[0,0,1],"d":5}',
    getSurfaceDomain: () => Float64Array.from([0, 10, 0, 10]),
    getFaceNormal: (face: number) => Float64Array.from(faces[face]!.normal),
    getFaceWires: (face: number) => Uint32Array.from([face]),
    getWireEdges: (wire: number) => Uint32Array.from([wire]),
    isEdgeForwardInWire: () => true,
    getEdgeCurveType: () => 'ELLIPSE',
    getEdgeParamSpan: () => Float64Array.from([0, 1]),
    evaluateEdgeCurve: (edge: number, t: number) =>
      Float64Array.from(faces[edge]!.curve(t)),
    getEdgeNurbsData: () => null
  };
}

const ellipse =
  (a: number, b: number) =>
  (t: number): number[] => [
    a * Math.cos(2 * Math.PI * t),
    b * Math.sin(2 * Math.PI * t),
    5
  ];

const witness: FaceWitnessV1 = {
  surfaceType: 'plane',
  perimeter: 62_830_000,
  centroid: [10_000_000, 0, 5_000_000],
  analytic: { kind: 'plane', normal: [0, 0, 1_000_000], offset: 5_000_000 },
  closure: { u: 'open', v: 'open' }
} as unknown as FaceWitnessV1;

/** Records which faces were measured; reports each face's own normal. */
function recordingCache(kernel: FaceShapeKernel) {
  const measured: number[] = [];
  const cache = new PreviewFaceGeometryCache(16, (_, face) => {
    measured.push(face);
    const [x, y, z] = Array.from(kernel.getFaceNormal(face));
    return {
      surfaceType: 'plane',
      area: 100 + face,
      center: { x: 5, y: 5, z: 5 },
      normal: { x: x!, y: y!, z: z! },
      planeOffset: 5 * z!
    } satisfies FaceGeometry;
  });
  return { cache, measured };
}

describe('preview face geometry cache', () => {
  it('keeps coincident faces of opposite orientation apart', () => {
    const kernel = kernelWith({
      1: { normal: [0, 0, 1], curve: ellipse(10, 10) },
      2: { normal: [0, 0, -1], curve: ellipse(10, 10) }
    });
    const { cache, measured } = recordingCache(kernel);
    const up = cache.measure(kernel as RemusKernel, 1, witness);
    const down = cache.measure(kernel as RemusKernel, 2, witness);
    expect(up?.normal?.z).toBe(1);
    expect(down?.normal?.z).toBe(-1);
    expect(down?.planeOffset).toBe(-5);
    expect(measured).toEqual([1, 2]);
    // The same oriented face is reused, as its own copy.
    const again = cache.measure(kernel as RemusKernel, 2, witness);
    expect(again).toEqual(down);
    expect(again).not.toBe(down);
    expect(cache.hits).toBe(1);
  });

  it('keeps boundaries of equal perimeter but different shape apart', () => {
    // Same seam vertex, curve type, plane and domain; the second
    // boundary is a different ellipse through the same seam point.
    const kernel = kernelWith({
      1: { normal: [0, 0, 1], curve: ellipse(10, 10) },
      2: { normal: [0, 0, 1], curve: ellipse(10, 6) }
    });
    const { cache, measured } = recordingCache(kernel);
    const circle = cache.measure(kernel as RemusKernel, 1, witness);
    const oval = cache.measure(kernel as RemusKernel, 2, witness);
    expect(measured).toEqual([1, 2]);
    expect(circle?.area).toBe(101);
    expect(oval?.area).toBe(102);
    expect(cache.hits).toBe(0);
  });

  it('measures a face cold when its boundary cannot be read', () => {
    const kernel: FaceShapeKernel = {
      ...kernelWith({ 1: { normal: [0, 0, 1], curve: ellipse(10, 10) } }),
      getFaceWires: () => {
        throw new Error('unsupported imported boundary');
      }
    };
    const { cache, measured } = recordingCache(kernel);
    expect(cache.measure(kernel as RemusKernel, 1, witness)?.area).toBe(101);
    expect(cache.measure(kernel as RemusKernel, 1, witness)?.area).toBe(101);
    // Nothing unreadable is cached: each frame measures it again.
    expect(measured).toEqual([1, 1]);
    expect(cache.hits).toBe(0);
  });

  it('reuses a face by content digest without reading it again', () => {
    const kernel = kernelWith({
      1: { normal: [0, 0, 1], curve: ellipse(10, 10) },
      2: { normal: [0, 0, 1], curve: ellipse(10, 10) },
      3: { normal: [0, 0, 1], curve: ellipse(10, 6) }
    });
    const { cache, measured } = recordingCache(kernel);
    const witnessed: number[] = [];
    const witnessOf = (_: RemusKernel, face: number) => {
      witnessed.push(face);
      return witness;
    };
    const first = cache.describe(kernel as RemusKernel, 1, 'a', witnessOf);
    // A later tick's handle for the same content reads nothing.
    const again = cache.describe(kernel as RemusKernel, 2, 'a', witnessOf);
    expect(again).toEqual(first);
    expect(again.geometry).not.toBe(first.geometry);
    again.geometry!.area = -1;
    expect(cache.describe(kernel as RemusKernel, 2, 'a', witnessOf)).toEqual(
      first
    );
    // A different digest, or none, reads the face as before.
    cache.describe(kernel as RemusKernel, 3, 'b', witnessOf);
    cache.describe(kernel as RemusKernel, 3, undefined, witnessOf);
    expect(witnessed).toEqual([1, 3, 3]);
    expect(measured).toEqual([1, 3]);
    expect(cache.digestHits).toBe(2);
  });

  it('never measures a B-spline face, with or without a digest', () => {
    const kernel = kernelWith({
      1: { normal: [0, 0, 1], curve: ellipse(10, 10) }
    });
    const { cache, measured } = recordingCache(kernel);
    const spline: FaceWitnessV1 = { ...witness, surfaceType: 'bspline' };
    const witnessOf = () => spline;
    for (const digest of ['s', 's', undefined]) {
      expect(
        cache.describe(kernel as RemusKernel, 1, digest, witnessOf)
      ).toEqual({ witness: spline, geometry: undefined });
    }
    expect(measured).toEqual([]);
  });
});

describe('faceContentDigestsOf', () => {
  const faces = Uint32Array.from([4, 5]);
  it('is null on kernels without the binding, or when it refuses', () => {
    expect(faceContentDigestsOf({} as RemusKernel, faces)).toBeNull();
    const refusing = {
      faceContentDigests: () => {
        throw new Error('invalid face handle');
      }
    };
    expect(
      faceContentDigestsOf(refusing as unknown as RemusKernel, faces)
    ).toBeNull();
    const short = { faceContentDigests: () => ['x'] };
    expect(
      faceContentDigestsOf(short as unknown as RemusKernel, faces)
    ).toBeNull();
  });

  it('returns one digest per face, in order', () => {
    const kernel = {
      faceContentDigests: (handles: Uint32Array) =>
        Array.from(handles, (face) => `d${face}`)
    };
    expect(
      faceContentDigestsOf(kernel as unknown as RemusKernel, faces)
    ).toEqual(['d4', 'd5']);
  });
});
