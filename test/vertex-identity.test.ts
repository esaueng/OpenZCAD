/**
 * Where edge-to-vertex incidence comes from, and why it is not derived from
 * positions.
 *
 * M3/W4 needs to know which edges meet at a vertex: sharing a face is
 * necessary for an edge run but not sufficient, since two edges on opposite
 * sides of a box's top face both bound it. The obvious way to get incidence
 * without a new kernel call is to quantize edge endpoint positions at the
 * ADR-011 1e-6 quantum and treat equal keys as one vertex. This file is the
 * measurement of whether that works, kept as a test so the answer cannot rot
 * into folklore.
 *
 * It does not work, and it does not need to: `getEdgeVertexHandles` returns
 * the kernel's own `[start_vertex_handle, end_vertex_handle]`, and `exact.ts`
 * already relies on it in `selectionTouchesBlendFace`. The measurement is kept anyway because "we
 * checked and positions are not good enough" is the reason the published
 * field is handle-derived, and a future reader will otherwise re-propose the
 * quantized version.
 */

import { describe, expect, it } from 'vitest';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';

/** The same quantizer the ADR-011 edge signature and mesh welding both use. */
function quantizedKey(point: ArrayLike<number>): string {
  const f = (value: number) =>
    String(Math.round((value ?? 0) / GEOMETRY_LINEAR_TOLERANCE));
  return `${f(point[0]!)},${f(point[1]!)},${f(point[2]!)}`;
}

function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

/** The display polylines the viewport receives, in `getSolidEdges` order. */
function displayPolylines(kernel: RemusKernel, solid: number): number[][] {
  const bounds = Array.from(kernel.boundingBox(solid));
  const scale = Math.max(
    bounds[3]! - bounds[0]!,
    bounds[4]! - bounds[1]!,
    bounds[5]! - bounds[2]!
  );
  // Mirrors `displayTessellationForExtents`: the deflection is size-relative,
  // so this is what the app itself would ask for on a body this size.
  const mesh = kernel.meshEdgesAll(solid, Math.max(1e-5, scale * 2e-4), 0.06);
  try {
    const values = Array.from(mesh.positions);
    const offsets = [...Array.from(mesh.offsets), values.length];
    return offsets
      .slice(0, -1)
      .map((from, index) => values.slice(from, offsets[index + 1]));
  } finally {
    mesh.free();
  }
}

function verticalEdgesOf(kernel: RemusKernel, solid: number): number[] {
  return Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
    const ends = Array.from(kernel.getEdgeVertices(edge));
    return Math.abs(ends[2]! - ends[5]!) > 1e-12;
  });
}

describe('edge-to-vertex incidence', { timeout: 60_000 }, () => {
  it('comes from the kernel, which names a vertex handle at each end', () => {
    const kernel = new RemusKernel();
    const bodies: [string, number, number, number][] = [
      // label, solid, expected vertices, expected edges
      ['box', kernel.makeBox(20, 20, 10), 8, 12],
      ['cylinder', kernel.makeCylinder(10, 20), 2, 3],
      ['cone', kernel.makeCone(10, 4, 20), 2, 3],
      ['torus', kernel.makeTorus(10, 3, 32), 1, 2]
    ];
    const plate = kernel.makeBox(80, 60, 6);
    const bore = kernel.copyAndTransformSolid(
      kernel.makeCylinder(2.25, 6),
      new Float64Array([1, 0, 0, 40, 0, 1, 0, 30, 0, 0, 1, 0, 0, 0, 0, 1])
    );
    bodies.push(['bored plate', kernel.cut(plate, bore), 10, 15]);

    for (const [label, solid, vertexCount, edgeCount] of bodies) {
      const vertices = Array.from(kernel.getSolidVertices(solid));
      const edges = Array.from(kernel.getSolidEdges(solid));
      expect(vertices, label).toHaveLength(vertexCount);
      expect(edges, label).toHaveLength(edgeCount);

      const known = new Set(vertices);
      for (const edge of edges) {
        const handles = Array.from(kernel.getEdgeVertexHandles(edge));
        // Always exactly two entries, always inside this solid's own vertex
        // set. Measured across 78 solids of the parity corpus and the STEP
        // fixtures — 1,767 vertices, 2,977 edges, no handle outside the set.
        expect(handles, label).toHaveLength(2);
        for (const handle of handles) {
          expect(known.has(handle), `${label} handle ${handle}`).toBe(true);
        }
        // The handles agree with the exact endpoint positions, so this is the
        // same incidence a position-matching derivation would be trying to
        // reconstruct — not a different notion of "meets here".
        const ends = Array.from(kernel.getEdgeVertices(edge));
        expect(
          distance(kernel.getVertexPosition(handles[0]!), ends.slice(0, 3))
        ).toBeLessThan(1e-9);
        expect(
          distance(kernel.getVertexPosition(handles[1]!), ends.slice(3, 6))
        ).toBeLessThan(1e-9);
      }
    }
  });

  it('reports one vertex twice for a closed edge, of three different kinds', () => {
    const kernel = new RemusKernel();
    const closedOf = (solid: number) =>
      Array.from(kernel.getSolidEdges(solid)).filter(
        (edge) => new Set(kernel.getEdgeVertexHandles(edge)).size === 1
      );

    // A cylinder's two rims: a real circle, closing on its seam vertex.
    const cylinder = kernel.makeCylinder(10, 20);
    expect(closedOf(cylinder)).toHaveLength(2);

    // A bore rim, which is the case the fillet dispatcher already keys on.
    const plate = kernel.makeBox(80, 60, 6);
    const bore = kernel.copyAndTransformSolid(
      kernel.makeCylinder(2.25, 6),
      new Float64Array([1, 0, 0, 40, 0, 1, 0, 30, 0, 0, 1, 0, 0, 0, 0, 1])
    );
    const drilled = kernel.cut(plate, bore);
    expect(closedOf(drilled)).toHaveLength(2);

    // A torus, whose two edges are DEGENERATE — closed and of zero length,
    // both naming the solid's single vertex. This is why the published field
    // keeps two entries rather than deduplicating to a set: a torus would
    // otherwise publish a one-element array that reads like a data error.
    const torus = kernel.makeTorus(10, 3, 32);
    const torusEdges = Array.from(kernel.getSolidEdges(torus));
    expect(torusEdges).toHaveLength(2);
    expect(closedOf(torus)).toHaveLength(2);
    expect(Array.from(kernel.getSolidVertices(torus))).toHaveLength(1);
    for (const edge of torusEdges) {
      expect(kernel.edgeLength(edge)).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // Why not quantize positions instead.
  // -------------------------------------------------------------------------

  it('now starts a closed edge at the vertex it owns, which it did not before', () => {
    // THIS TEST WAS FLIPPED by the pin bump to 02bbf81 carrying historical BrepKit #64.
    //
    // It used to assert the opposite, and was described here as "the decisive
    // result": a closed edge's polyline began a QUARTER TURN from the seam, so
    // a derivation that quantized polyline endpoints would place a rim's
    // vertex where no other edge touches. Measured then across the parity
    // corpus: 73 vertices reached from two edges that quantize apart, every
    // one of them on a closed edge.
    //
    // Historical BrepKit #64 fixed exactly that, for an unrelated reason — the offset
    // sheared the CDT's parameter domain and folded a band's triangles back
    // over themselves. Closed rims are now sampled from the edge's own start
    // vertex, so the gap this test measured has gone from 10*sqrt(2) = 14.142
    // to 6.12e-16.
    //
    // WHAT THAT DOES TO THE ARGUMENT, stated plainly rather than left for
    // someone to trip over: the "73 false splits" evidence for publishing
    // `vertexIds` instead of deriving identity from polyline endpoints was
    // measured against the OLD sampler and no longer describes this kernel.
    // That specific number should not be quoted as current. The other reasons
    // `vertexIds` exists are untouched and still sufficient — a closed edge
    // names ONE vertex twice, so endpoints cannot distinguish a rim from a
    // degenerate edge; and the handles are dense per-body integers that a
    // rebuild may renumber, so they are not derivable from geometry at all.
    // Whether endpoint quantization would now succeed on the corpus is simply
    // unmeasured. Do not assume either way from this test.
    const kernel = new RemusKernel();
    const cylinder = kernel.makeCylinder(10, 20);
    const edges = Array.from(kernel.getSolidEdges(cylinder));
    const polylines = displayPolylines(kernel, cylinder);

    let checked = 0;
    edges.forEach((edge, index) => {
      const handles = Array.from(kernel.getEdgeVertexHandles(edge));
      if (new Set(handles).size !== 1) {
        return;
      }
      checked += 1;
      const polyline = polylines[index]!;
      const start = polyline.slice(0, 3);
      const finish = polyline.slice(-3);
      // The polyline still closes on itself...
      expect(distance(start, finish)).toBeLessThan(1e-9);
      // ...and now it also begins at the vertex it owns.
      const vertex = kernel.getVertexPosition(handles[0]!);
      expect(distance(start, vertex)).toBeLessThan(1e-9);
    });
    expect(checked).toBe(2);
  });

  it('quantizes distinct vertices together once a part is small enough', () => {
    // `UnitSystem` includes metres, so a part a couple of microns across is
    // representable. At that size the 1e-6 quantum stops being a rounding
    // step and becomes a feature-sized grid.
    //
    // The vehicle changed with the eca4fd4 pin: it used to be a 2e-6 box with
    // a 3e-7 fillet, whose sixteen vertices merged into eight keys. remus#181
    // made the blend fail closed below tolerance (`trimming-failure: blend`),
    // so the geometry that carried the argument can no longer be built. A
    // 4e-7 box still builds and makes the same point with no feature at all:
    const kernel = new RemusKernel();
    const box = kernel.makeBox(4e-7, 4e-7, 4e-7);
    const vertices = Array.from(kernel.getSolidVertices(box));
    expect(vertices).toHaveLength(8);

    const keys = new Set(
      vertices.map((vertex) =>
        quantizedKey(Array.from(kernel.getVertexPosition(vertex)))
      )
    );
    // Eight distinct kernel vertices, ONE quantized key: a run walked on
    // positions alone could not tell any two corners apart.
    expect(keys.size).toBe(1);
  });

  it('is safe on the sizes the corpus actually contains, which is the trap', () => {
    // The same construction one and two decades larger collides not at all,
    // which is exactly why this needs a written measurement rather than a
    // spot check: nothing in the parity corpus or the STEP fixtures reaches
    // the size where the quantum fails. Measured smallest vertex separation
    // across the whole corpus is 4.67e-2 (samples/parametric-bracket.step),
    // some 47,000 quanta, and collisions there are zero.
    const kernel = new RemusKernel();
    for (const [width, height, radius] of [
      [2e-4, 1e-4, 3e-5],
      [2e-3, 1e-3, 3e-4]
    ]) {
      const box = kernel.makeBox(width!, width!, height!);
      const filleted = kernel.fillet(
        box,
        Uint32Array.from(verticalEdgesOf(kernel, box)),
        radius!
      );
      const vertices = Array.from(kernel.getSolidVertices(filleted));
      expect(vertices).toHaveLength(16);
      const keys = new Set(
        vertices.map((vertex) =>
          quantizedKey(Array.from(kernel.getVertexPosition(vertex)))
        )
      );
      expect(keys.size).toBe(16);
    }
  });
});
