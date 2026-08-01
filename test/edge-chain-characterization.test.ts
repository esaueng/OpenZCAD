/**
 * What `edgeRunFrom` does today, on bodies the real kernel produced.
 *
 * A double click selects a "run" of edges so that filleting a rim does not
 * mean picking eight edges by hand. The walk deciding what belongs to a run is
 * geometric: two edges continue each other if their ends coincide and their
 * directions agree inside a 50 degree cone.
 *
 * M3/W4 replaces that walk with a topological one, now that
 * `adjacentFaceHashes` and `vertexIds` publish the facts it needs. Before the
 * rewrite, a correct version and a broken one both produce a green suite,
 * because `edgeChain.test.ts` only exercises hand-built polylines. This file is
 * the missing net: every assertion here records what the CURRENT walk answers
 * on real kernel topology, including the answers that are wrong.
 *
 * So a failure here after the rewrite is not automatically a regression. Each
 * case says whether the pinned answer is the behaviour to keep or the defect
 * to fix, and the rewrite should flip the marked ones deliberately rather than
 * discover them.
 */

import { describe, expect, it } from 'vitest';
import { BrepKernel } from '../packages/kernel-adapter/node_modules/brepkit-wasm/brepkit_wasm.js';
import { edgeRunFrom } from '../packages/viewport/src/pick/edgeChain';
import type { EdgeTopology } from '@openzcad/shared';

/**
 * The edges of some solids as the viewport receives them: display polylines at
 * the app's own deflection, with seams marked the way `brepEdgeDisplayRole`
 * marks them. Several solids can be passed to model one multi-solid body.
 */
function publishedEdges(kernel: BrepKernel, solids: number[]): EdgeTopology[] {
  const edges: EdgeTopology[] = [];
  let hash = 1;
  for (const solid of solids) {
    const bounds = Array.from(kernel.boundingBox(solid));
    const scale = Math.max(
      bounds[3]! - bounds[0]!,
      bounds[4]! - bounds[1]!,
      bounds[5]! - bounds[2]!
    );
    const edgeToFaces = JSON.parse(kernel.edgeToFaceMap(solid)) as Record<
      string,
      number[]
    >;
    const handles = Array.from(kernel.getSolidEdges(solid));
    // Mirrors `displayTessellationForExtents` — size-relative, so the sampling
    // below is what the app would really ask for on a body this size.
    const mesh = kernel.meshEdgesAll(solid, Math.max(1e-5, scale * 2e-4), 0.06);
    try {
      const values = Array.from(mesh.positions);
      const offsets = [...Array.from(mesh.offsets), values.length];
      handles.forEach((handle, index) => {
        const owners = edgeToFaces[String(handle)] ?? [];
        edges.push({
          topologyId: `edge:${hash}`,
          hash,
          displayRole:
            owners.length === 2 && owners[0] === owners[1] ? 'seam' : 'feature',
          points: values.slice(offsets[index], offsets[index + 1])
        });
        hash += 1;
      });
    } finally {
      mesh.free();
    }
  }
  return edges;
}

/** Edges lying wholly at height `z` — a top rim, without picking by index. */
function atHeight(edges: EdgeTopology[], z: number): EdgeTopology[] {
  return edges.filter(
    (edge) =>
      edge.displayRole !== 'seam' &&
      edge.points.length >= 6 &&
      edge.points.every(
        (value, index) => index % 3 !== 2 || Math.abs(value - z) < 1e-7
      )
  );
}

function runLengths(edges: EdgeTopology[], seeds: EdgeTopology[]): number[] {
  return seeds.map((seed) => edgeRunFrom(edges, seed.topologyId).length);
}

function verticalEdgesOf(kernel: BrepKernel, solid: number): number[] {
  return Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
    const ends = Array.from(kernel.getEdgeVertices(edge));
    return Math.abs(ends[2]! - ends[5]!) > 1e-12;
  });
}

function regularPrism(
  kernel: BrepKernel,
  sides: number,
  radius: number,
  height: number
): number {
  const wire = kernel.makeRegularPolygonWire(radius, sides);
  return kernel.extrude(kernel.makeFaceFromWire(wire), 0, 0, 1, height);
}

describe('what the geometric edge walk does today', { timeout: 120_000 }, () => {
  it('takes a whole boss rim or one edge of it, depending on the side count', () => {
    // DEFECT, pinned. Nothing about a boss rim changes at eight sides; the
    // answer changes because a regular n-gon's exterior turn crosses the 50
    // degree cone between six sides (60 degrees) and eight (45). A user who
    // draws a hex boss and an octagonal boss gets two different tools.
    const kernel = new BrepKernel();
    const answers: Record<number, number[]> = {};
    for (const sides of [4, 6, 8, 12]) {
      const solid = regularPrism(kernel, sides, 10, 8);
      const edges = publishedEdges(kernel, [solid]);
      const rim = atHeight(edges, 8);
      expect(rim, `${sides}-sided rim`).toHaveLength(sides);
      answers[sides] = runLengths(edges, rim);
    }
    // Square and hexagonal bosses: the run is the seed alone.
    expect(answers[4]).toEqual([1, 1, 1, 1]);
    expect(answers[6]).toEqual([1, 1, 1, 1, 1, 1]);
    // Octagonal and twelve-sided: the whole rim, every edge of it.
    expect(answers[8]).toEqual(Array(8).fill(8));
    expect(answers[12]).toEqual(Array(12).fill(12));
  });

  it('takes the whole rim of a filleted box, which is the point of the feature', () => {
    // CORRECT, pinned. This is the behaviour the rewrite must not lose: a
    // filleted rim is four straight edges and four arcs, and a double click on
    // any of them takes all eight.
    const kernel = new BrepKernel();
    const box = kernel.makeBox(20, 20, 10);
    const filleted = kernel.fillet(
      box,
      Uint32Array.from(verticalEdgesOf(kernel, box)),
      3
    );
    const edges = publishedEdges(kernel, [filleted]);
    expect(edges).toHaveLength(24);
    const rim = atHeight(edges, 10);
    expect(rim).toHaveLength(8);
    expect(runLengths(edges, rim)).toEqual(Array(8).fill(8));
    // And the walk stays on the rim: the eight vertical wall edges are runs of
    // one, so it does not fall off the lip onto the side of the box.
    const vertical = edges.filter(
      (edge) =>
        Math.abs(edge.points[2]! - edge.points.at(-1)!) > 1
    );
    expect(vertical).toHaveLength(8);
    expect(runLengths(edges, vertical)).toEqual(Array(8).fill(1));
  });

  it('doubles the same rim when the part is small enough', () => {
    // DEFECT, pinned. Identical construction, 1/100,000 the size: the run goes
    // from eight edges to sixteen of the body's twenty-four. The walk has an
    // absolute `WELD_TOLERANCE` of 1e-4, so on a part 2e-4 across every corner
    // of the body is "the same vertex" and the run wanders off the rim.
    // `UnitSystem` includes metres, so this part is representable.
    const kernel = new BrepKernel();
    const box = kernel.makeBox(2e-4, 2e-4, 1e-4);
    const filleted = kernel.fillet(
      box,
      Uint32Array.from(verticalEdgesOf(kernel, box)),
      3e-5
    );
    const edges = publishedEdges(kernel, [filleted]);
    expect(edges).toHaveLength(24);
    const rim = atHeight(edges, 1e-4);
    expect(rim).toHaveLength(8);
    expect(runLengths(edges, rim)).toEqual(Array(8).fill(16));
  });

  it('walks from one solid to another that merely touches it', () => {
    // DEFECT, pinned, and the one `vertexIds` was published to fix. A linear
    // pattern whose spacing equals its extent leaves two solids sharing a
    // plane. They have no face in common and no vertex in common — the kernel
    // considers them separate topology that happens to be coincident — but
    // their edges meet in space and continue straight, so the walk joins them.
    const kernel = new BrepKernel();
    const first = kernel.makeBox(10, 10, 10);
    const second = kernel.copyAndTransformSolid(
      kernel.makeBox(10, 10, 10),
      new Float64Array([1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    );
    const edges = publishedEdges(kernel, [first, second]);
    expect(edges).toHaveLength(24);
    // Edges 1..12 are the first solid's, 13..24 the second's.
    const solidOf = (topologyId: string) =>
      Number(topologyId.split(':')[1]) <= 12 ? 0 : 1;
    const crossing = edges
      .map((edge) => edgeRunFrom(edges, edge.topologyId))
      .filter((run) => new Set(run.map(solidOf)).size > 1);
    expect(crossing).toHaveLength(8);
    for (const run of crossing) {
      expect(run).toHaveLength(2);
    }
  });

  it('gives four symmetric edges of a sheared box two different answers', () => {
    // DEFECT, pinned. Shearing x by z leans the four vertical edges by 45
    // degrees. The top face is still a square and its four edges are still
    // related by symmetry, but two of them now continue into a leaning wall
    // edge inside the cone and two do not, so the same gesture on symmetric
    // geometry returns runs of two and runs of one.
    //
    // Reported to this lane as "three different answers depending which way
    // the taper leans". Two is what reproduces here, on a shear rather than a
    // taper; the underlying defect — symmetric edges answering asymmetrically,
    // and the run leaving the rim for the wall — is real either way.
    const kernel = new BrepKernel();
    const sheared = kernel.copyAndTransformSolid(
      kernel.makeBox(20, 20, 10),
      new Float64Array([1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    );
    const edges = publishedEdges(kernel, [sheared]);
    const bounds = Array.from(kernel.boundingBox(sheared));
    const top = atHeight(edges, bounds[5]!);
    expect(top).toHaveLength(4);
    expect(runLengths(edges, top)).toEqual([2, 1, 2, 1]);

    // Unsheared, the same four edges all answer 1.
    const upright = publishedEdges(kernel, [kernel.makeBox(20, 20, 10)]);
    expect(runLengths(upright, atHeight(upright, 10))).toEqual([1, 1, 1, 1]);
  });

  it('holds a chamfer band together only because the cone is wider than 45 degrees', () => {
    // THE PRODUCT QUESTION, pinned so it cannot be tightened away by accident.
    //
    // A 20x20x10 box chamfered 3 mm on its four vertical edges has a top rim of
    // eight edges whose worst kink is exactly 45.000000 degrees — a real
    // corner, not a sampling artefact, because a chamfer is not tangent to
    // anything. The 50 degree cone is what keeps that rim one run, and App.tsx
    // tells the user "Fillet or chamfer applies to all of them".
    //
    // So tightening the cone toward true tangency silently removes chamfer-band
    // selection. Whether a chamfer band should be one run is a product call,
    // not a refactor: this test only records that 50 is load-bearing and that
    // the cliff is at exactly 45.
    const kernel = new BrepKernel();
    const box = kernel.makeBox(20, 20, 10);
    const chamfered = kernel.chamfer(
      box,
      Uint32Array.from(verticalEdgesOf(kernel, box)),
      3
    );
    const edges = publishedEdges(kernel, [chamfered]);
    const rim = atHeight(edges, 10);
    expect(rim).toHaveLength(8);
    const seed = rim[0]!.topologyId;
    // Above the kink: the whole band. At or below it: the seed alone.
    expect(edgeRunFrom(edges, seed, { tangentToleranceDeg: 50 })).toHaveLength(8);
    expect(edgeRunFrom(edges, seed, { tangentToleranceDeg: 45.5 })).toHaveLength(
      8
    );
    expect(edgeRunFrom(edges, seed, { tangentToleranceDeg: 45 })).toHaveLength(1);
    expect(edgeRunFrom(edges, seed, { tangentToleranceDeg: 44 })).toHaveLength(1);
    expect(edgeRunFrom(edges, seed, { tangentToleranceDeg: 12 })).toHaveLength(1);
  });

  it('receives arcs as sampled curves, not as the single chord the docs claimed', () => {
    // The premise `edgeChain.ts` used to justify its 50 degree cone, and which
    // `edgeChain.test.ts` had a test pinning, was that the kernel hands the
    // viewport a fillet arc as a two-point polyline whose chord is 45 degrees
    // off the true tangent. It does not. At the app's real display deflection
    // a quarter arc arrives with 28 points, and the deflection is
    // size-relative, so that count barely moves across three decades of radius.
    //
    // The 50 degree cone therefore has nothing to do with chord error. What it
    // is actually doing is the chamfer case above.
    const kernel = new BrepKernel();
    for (const radius of [3, 1, 0.5]) {
      const box = kernel.makeBox(20, 20, 10);
      const filleted = kernel.fillet(
        box,
        Uint32Array.from(verticalEdgesOf(kernel, box)),
        radius
      );
      const edges = publishedEdges(kernel, [filleted]);
      const arcs = edges.filter((edge) => edge.points.length / 3 > 2);
      expect(arcs, `r=${radius}`).toHaveLength(8);
      for (const arc of arcs) {
        expect(arc.points.length / 3, `r=${radius}`).toBe(28);
      }
    }
    // A cylinder's rim, which the old docstring held up as the well-sampled
    // counter-example, is 113 points for a full turn — the same sampling rate,
    // not a different one.
    const cylinder = kernel.makeCylinder(10, 20);
    const rimPointCounts = publishedEdges(kernel, [cylinder])
      .filter((edge) => edge.points.length / 3 > 2)
      .map((edge) => edge.points.length / 3);
    expect(rimPointCounts).toEqual([113, 113]);
  });

  it('takes a run of eight on the body the viewport e2e double-clicks', () => {
    // Pins the exact number `test/e2e/viewport.spec.ts` asserts. The e2e body
    // is the app's default 30 x 18 x 24 box with all twelve edges filleted at
    // the default radius 2, which leaves 48 edges in twelve runs of eight —
    // one per original box edge, each the fillet band plus what continues from
    // it. Every edge answers 8, so the e2e's probe can land anywhere.
    const kernel = new BrepKernel();
    const box = kernel.makeBox(30, 18, 24);
    const filleted = kernel.fillet(
      box,
      Uint32Array.from(kernel.getSolidEdges(box)),
      2
    );
    const edges = publishedEdges(kernel, [filleted]);
    expect(edges).toHaveLength(48);
    expect(edges.every((edge) => edge.displayRole === 'feature')).toBe(true);
    expect(runLengths(edges, edges)).toEqual(Array(48).fill(8));
  });
});
