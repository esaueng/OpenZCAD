import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BrepKernel } from 'brepkit-wasm';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';

/**
 * The rebuild cache replaces re-parsing an imported STEP with restoring the
 * kernel's serialised solids. That is only sound if a restored solid is
 * indistinguishable from a freshly parsed one — both in the fingerprints saved
 * references resolve through, and in what downstream modelling does to it.
 */

const SOURCE = new Uint8Array(
  readFileSync(new URL('../../../samples/parametric-bracket.step', import.meta.url))
);

function importSolids(kernel: BrepKernel, bytes: Uint8Array): number[] {
  return Array.from(
    kernel.importStep(
      bytes,
      bytes.byteLength,
      Math.max(2_000_000, Math.ceil(bytes.byteLength / 16))
    )
  );
}

const quantize = (value: number) => Math.round(value / GEOMETRY_LINEAR_TOLERANCE);

/**
 * The quantized geometry every topology fingerprint is derived from. Raw f64s
 * can differ by an ULP where restoring recomputes a plane offset; what decides
 * whether a saved reference still resolves is this form.
 */
function quantizedTopology(kernel: BrepKernel, solid: number) {
  const faces = Array.from(kernel.getSolidFaces(solid));
  const edges = Array.from(kernel.getSolidEdges(solid));
  return {
    faceCount: faces.length,
    edgeCount: edges.length,
    faces: faces.map((face) => ({
      surfaceType: kernel.getSurfaceType(face),
      params: quantizedNumbers(kernel.getAnalyticSurfaceParams(face)),
      edges: Array.from(kernel.getFaceEdges(face)).map((edge) =>
        quantize(kernel.edgeLength(edge))
      )
    })),
    edges: edges.map((edge) => ({
      curveType: kernel.getEdgeCurveType(edge),
      length: quantize(kernel.edgeLength(edge)),
      vertices: Array.from(kernel.getEdgeVertices(edge)).map(quantize)
    }))
  };
}

function quantizedNumbers(json: string): number[] {
  const found: number[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      found.push(quantize(value));
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  try {
    walk(JSON.parse(json));
  } catch {
    /* a non-JSON parameter string contributes no numbers */
  }
  return found;
}

function measures(kernel: BrepKernel, solid: number) {
  return {
    volume: kernel.volume(solid, 0.01),
    area: kernel.surfaceArea(solid, 0.01)
  };
}

describe('imported STEP cache round trip', () => {
  it('restores a solid whose fingerprint inputs are identical', () => {
    const kernel = new BrepKernel();
    try {
      const parsed = importSolids(kernel, SOURCE)[0]!;
      const restored = kernel.deserializeSolid(kernel.serializeSolid(parsed));

      expect(quantizedTopology(kernel, restored)).toEqual(
        quantizedTopology(kernel, parsed)
      );
      const before = measures(kernel, parsed);
      const after = measures(kernel, restored);
      expect(after.volume).toBeCloseTo(before.volume, 9);
      expect(after.area).toBeCloseTo(before.area, 9);
    } finally {
      kernel.free();
    }
  });

  it('survives a serialise/restore cycle repeated across rebuilds', () => {
    // A cache entry is written once and restored on every later rebuild, so
    // the restored form has to be a fixed point rather than drifting.
    const kernel = new BrepKernel();
    try {
      const parsed = importSolids(kernel, SOURCE)[0]!;
      const blob = kernel.serializeSolid(parsed);
      const first = kernel.deserializeSolid(blob);
      const second = kernel.deserializeSolid(kernel.serializeSolid(first));

      expect(quantizedTopology(kernel, second)).toEqual(
        quantizedTopology(kernel, first)
      );
      expect(kernel.serializeSolid(second)).toEqual(
        kernel.serializeSolid(first)
      );
    } finally {
      kernel.free();
    }
  });

  it('gives downstream modelling the same result as a fresh parse', () => {
    // The residual risk in caching: restoring recomputes a handful of plane
    // offsets to within an ULP, and booleans can be sub-ULP sensitive. Cut a
    // box out of both forms and require the outcomes to agree.
    const kernel = new BrepKernel();
    try {
      const parsed = importSolids(kernel, SOURCE)[0]!;
      const restored = kernel.deserializeSolid(kernel.serializeSolid(parsed));

      const toolFor = () => kernel.makeBox(6, 6, 60);
      const fromParsed = kernel.cut(parsed, toolFor());
      const fromRestored = kernel.cut(restored, toolFor());

      expect(quantizedTopology(kernel, fromRestored)).toEqual(
        quantizedTopology(kernel, fromParsed)
      );
      expect(kernel.volume(fromRestored, 0.01)).toBeCloseTo(
        kernel.volume(fromParsed, 0.01),
        9
      );
    } finally {
      kernel.free();
    }
  });
});
