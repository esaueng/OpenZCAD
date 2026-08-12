/**
 * What `edgeRunFrom` does, on bodies the real kernel produced.
 *
 * A double click selects a "run" of edges so that filleting a rim does not
 * mean picking eight edges by hand. The walk deciding what belongs to a run
 * used to be geometric throughout: two edges continued each other if their
 * sampled ends coincided within an absolute tolerance and their directions
 * agreed inside a 50 degree cone.
 *
 * M3/W4 replaced the incidence half of that with topology — `vertexIds` names
 * the kernel's own vertices, so "these two edges meet" is an integer
 * comparison rather than a distance. The continuation half is still the cone,
 * for the product reason the chamfer case below records.
 *
 * This file is the record of what that costs and what it buys, measured on
 * real kernel topology rather than hand-built polylines. Every case says
 * whether its answer is the behaviour to keep, a defect that has now been
 * fixed, or a defect that cannot be fixed without answering a product question
 * this lane was told not to answer.
 */

import { describe, expect, it } from 'vitest';
import { BrepKernel } from '../packages/kernel-adapter/node_modules/brepkit-wasm/brepkit_wasm.js';
import { brepEdgeCurve } from '@openzcad/kernel-adapter/exact';
import {
  edgeRunFrom,
  type EdgeChainOptions
} from '../packages/viewport/src/pick/edgeChain';
import type { EdgeTopology } from '@openzcad/shared';

/**
 * The edges of some solids as the viewport receives them: display polylines at
 * the app's own deflection, with seams marked the way `brepEdgeDisplayRole`
 * marks them, and the three topology fields `exact.ts` publishes alongside
 * them. Several solids can be passed to model one multi-solid body.
 *
 * Face hashes and vertex ids are dense counters here rather than ADR-011
 * witness hashes, exactly as `topologyId` already is. What matters to the walk
 * is the scoping, and that is reproduced faithfully: the vertex counter runs
 * body-wide while the handle map is rebuilt per solid, so two solids that
 * touch exactly still share no vertex id.
 */
function publishedEdges(kernel: BrepKernel, solids: number[]): EdgeTopology[] {
  const edges: EdgeTopology[] = [];
  let hash = 1;
  let nextVertexId = 0;
  let nextFaceHash = 1;
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
    const faceHashByHandle = new Map<number, number>();
    for (const face of kernel.getSolidFaces(solid)) {
      if (!faceHashByHandle.has(face)) {
        faceHashByHandle.set(face, nextFaceHash);
        nextFaceHash += 1;
      }
    }
    const vertexIdByHandle = new Map<number, number>();
    for (const vertex of kernel.getSolidVertices(solid)) {
      if (!vertexIdByHandle.has(vertex)) {
        vertexIdByHandle.set(vertex, nextVertexId);
        nextVertexId += 1;
      }
    }
    // Mirrors `displayTessellationForExtents` — size-relative, so the sampling
    // below is what the app would really ask for on a body this size.
    const mesh = kernel.meshEdgesAll(solid, Math.max(1e-5, scale * 2e-4), 0.06);
    try {
      const values = Array.from(mesh.positions);
      const offsets = [...Array.from(mesh.offsets), values.length];
      handles.forEach((handle, index) => {
        const owners = edgeToFaces[String(handle)] ?? [];
        const vertexHandles = Array.from(kernel.getEdgeVertexHandles(handle));
        const points = values.slice(offsets[index], offsets[index + 1]);
        edges.push({
          topologyId: `edge:${hash}`,
          hash,
          displayRole:
            owners.length === 2 && owners[0] === owners[1] ? 'seam' : 'feature',
          adjacentFaceHashes:
            owners.length > 0
              ? owners
                  .map((owner) => faceHashByHandle.get(owner)!)
                  .sort((left, right) => left - right)
              : undefined,
          curve: brepEdgeCurve(kernel, handle, points),
          vertexIds:
            vertexHandles.length === 2
              ? [
                  vertexIdByHandle.get(vertexHandles[0]!)!,
                  vertexIdByHandle.get(vertexHandles[1]!)!
                ]
              : undefined,
          points
        });
        hash += 1;
      });
    } finally {
      mesh.free();
    }
  }
  return edges;
}

/**
 * The same edges as a payload written before the topology fields existed: a
 * `derived` record restored from IndexedDB, which is the case the geometric
 * fallback is kept for.
 */
function withoutTopology(edges: EdgeTopology[]): EdgeTopology[] {
  return edges.map((edge) => ({
    topologyId: edge.topologyId,
    hash: edge.hash,
    displayRole: edge.displayRole,
    points: edge.points
  }));
}

/** Edges lying wholly at height `z` — a top rim, without picking by index. */
function atHeight(
  edges: EdgeTopology[],
  z: number,
  tolerance = 1e-7
): EdgeTopology[] {
  return edges.filter(
    (edge) =>
      edge.displayRole !== 'seam' &&
      edge.points.length >= 6 &&
      edge.points.every(
        (value, index) => index % 3 !== 2 || Math.abs(value - z) < tolerance
      )
  );
}

function runLengths(
  edges: EdgeTopology[],
  seeds: EdgeTopology[],
  options?: EdgeChainOptions
): number[] {
  return seeds.map(
    (seed) => edgeRunFrom(edges, seed.topologyId, options).length
  );
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

/** A 20 x 20 x 10 box with its four vertical edges filleted, scaled by `k`. */
function filletedBox(kernel: BrepKernel, k: number): number {
  const box = kernel.makeBox(20 * k, 20 * k, 10 * k);
  return kernel.fillet(
    box,
    Uint32Array.from(verticalEdgesOf(kernel, box)),
    3 * k
  );
}

function sharesFace(left: EdgeTopology, right: EdgeTopology): boolean {
  const owners = new Set(left.adjacentFaceHashes ?? []);
  return (right.adjacentFaceHashes ?? []).some((hash) => owners.has(hash));
}

describe('what the edge walk does', { timeout: 120_000 }, () => {
  // One kernel for the file. Every case builds its own solids from it, and a
  // BrepKit instance is a large WASM module: standing eleven of them up in one
  // worker is what turns unrelated kernel suites into timeouts under CI's
  // bounded file parallelism.
  const kernel = new BrepKernel();

  it('takes a whole boss rim or one edge of it, depending on the side count', () => {
    // PINNED, and not fixable here. Nothing about a boss rim changes at eight
    // sides; the answer changes because a regular n-gon's exterior turn
    // crosses the 50 degree cone between six sides (60 degrees) and eight
    // (45). A user who draws a hex boss and an octagonal boss gets two
    // different tools.
    //
    // This was filed as a defect for the topological rewrite to fix, and the
    // rewrite cannot fix it. An octagonal boss rim and the chamfer band below
    // are the same walk problem: n quadrilateral side faces around one top
    // face, consecutive rim edges sharing that face and one vertex, turning
    // 45.000000 degrees. No fact in the topology payload separates them, so
    // any rule that keeps the chamfer band whole keeps the octagon whole, and
    // any threshold placed to include the hexagon's 60 degrees would have to
    // sit between 60 and the 90 of a square boss — moving the cliff rather
    // than removing it. Removing it means deciding what a run is for, which is
    // the product question the chamfer case records.
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
    const edges = publishedEdges(kernel, [filletedBox(kernel, 1)]);
    expect(edges).toHaveLength(24);
    const rim = atHeight(edges, 10);
    expect(rim).toHaveLength(8);
    expect(runLengths(edges, rim)).toEqual(Array(8).fill(8));
    // And the walk stays on the rim: the eight vertical wall edges are runs of
    // one, so it does not fall off the lip onto the side of the box.
    const vertical = edges.filter(
      (edge) => Math.abs(edge.points[2]! - edge.points.at(-1)!) > 1
    );
    expect(vertical).toHaveLength(8);
    expect(runLengths(edges, vertical)).toEqual(Array(8).fill(1));
  });

  it('answers the same on the same rim across six decades of size', () => {
    // FIXED, was a defect. The walk used to weld ends at an absolute 1e-4, so
    // the identical body 1/100,000 the size answered 16 of its 24 edges
    // instead of 8: every corner of a part 2e-4 across was inside one weld
    // radius and the run wandered off the rim. `UnitSystem` includes metres,
    // so that part is representable.
    //
    // Incidence is now vertex identity, which has no length in it at all.
    for (const k of [1000, 1, 1e-5]) {
      const edges = publishedEdges(kernel, [filletedBox(kernel, k)]);
      expect(edges, `${k}x`).toHaveLength(24);
      const rim = atHeight(edges, 10 * k, 1e-7 * Math.max(k, 1));
      expect(rim, `${k}x`).toHaveLength(8);
      expect(runLengths(edges, rim), `${k}x`).toEqual(Array(8).fill(8));
    }
  });

  it('will not walk from one solid to another that merely touches it', () => {
    // FIXED, was a defect, and the one `vertexIds` was published for. A linear
    // pattern whose spacing equals its extent leaves two solids sharing a
    // plane. They have no face in common and no vertex in common — the kernel
    // considers them separate topology that happens to be coincident — but
    // their edges meet in space and continue straight, so the geometric walk
    // joined them: eight of the twenty-four edges came back as runs of two
    // spanning both solids.
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
    const runs = edges.map((edge) => edgeRunFrom(edges, edge.topologyId));
    expect(runs.filter((run) => new Set(run.map(solidOf)).size > 1)).toEqual([]);
    // Two plain boxes: every edge is a run of one, as it is on one box alone.
    expect(runs.map((run) => run.length)).toEqual(Array(24).fill(1));

    // The vertex ids are what does it. The same body without them — a payload
    // written before the fields existed — still crosses, because positions are
    // all it has to go on. The fallback is honest about being geometric.
    const legacy = withoutTopology(edges);
    const crossing = legacy
      .map((edge) => edgeRunFrom(legacy, edge.topologyId))
      .filter((run) => new Set(run.map(solidOf)).size > 1);
    expect(crossing).toHaveLength(8);
    for (const run of crossing) {
      expect(run).toHaveLength(2);
    }
  });

  it('gives four symmetric edges of a sheared box two different answers', () => {
    // PINNED, and not fixable here either, for the same reason as the boss rim
    // above. Shearing x by z leans the four vertical edges by 45 degrees. The
    // top face is still a square and its four edges are still related by
    // symmetry, but two of them now continue into a leaning wall edge inside
    // the cone and two do not.
    //
    // The join the walk takes here is congruent to the one that holds a
    // chamfer band together: two edges of one planar face, meeting at one
    // vertex, turning 45.000000 degrees, with the third edge at that vertex 90
    // degrees away. Same topology, same angle — so the cone cannot admit the
    // chamfer and refuse this. The second assertion shows the whole of it: at
    // 45 degrees these four edges do answer symmetrically, and that is exactly
    // the setting at which the chamfer band below falls apart.
    const sheared = kernel.copyAndTransformSolid(
      kernel.makeBox(20, 20, 10),
      new Float64Array([1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    );
    const edges = publishedEdges(kernel, [sheared]);
    const bounds = Array.from(kernel.boundingBox(sheared));
    const top = atHeight(edges, bounds[5]!);
    expect(top).toHaveLength(4);
    expect(runLengths(edges, top)).toEqual([2, 1, 2, 1]);
    expect(runLengths(edges, top, { tangentToleranceDeg: 45 })).toEqual([
      1, 1, 1, 1
    ]);

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
    // the cliff is at exactly 45. Two cases above ride on the same cliff.
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
    // size-relative, so that count barely moves across three decades of
    // radius.
    //
    // The 50 degree cone therefore has nothing to do with chord error. What it
    // is actually doing is the chamfer case above.
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
        // And every one of them publishes the circle it lies on, so the walk
        // reads its end directions off exact geometry rather than off the
        // first and last of those 28 chords.
        expect(arc.curve?.type, `r=${radius}`).toBe('CIRCLE');
        expect(arc.curve?.circle?.radius, `r=${radius}`).toBeCloseTo(radius, 12);
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
    // the default radius 2, which leaves 48 edges. Every edge answers 8, so
    // the e2e's probe can land anywhere.
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
    // Forty-eight edges answering eight are six runs, not forty-eight: each
    // edge belongs to exactly one, and every seed on it gives the same set.
    const distinct = new Set(
      edges.map((edge) =>
        [...edgeRunFrom(edges, edge.topologyId)].sort().join(' ')
      )
    );
    expect(distinct.size).toBe(6);
  });

  it('runs across faces, not along them, on that same body', () => {
    // Why `edgeChain.ts` does not consult `adjacentFaceHashes`, pinned so the
    // obvious-looking rule cannot be added back as a cleanup.
    //
    // "Two edges continue each other only if they share a face" is the first
    // thing a topological rewrite reaches for, and on the app's own default
    // body it is exactly backwards. Each of these runs is a tangent-continuous
    // loop threading across the fillet patches, and it turns at four-valent
    // vertices where the continuing edge is the diagonally opposite one — the
    // one edge of the four that shares no face with it. All 336 consecutive
    // pairs, in all 48 runs, share nothing.
    //
    // Requiring face continuity would therefore not tighten these runs. It
    // would reject every join they are made of, and the e2e above is asserting
    // the eight those joins add up to.
    const box = kernel.makeBox(30, 18, 24);
    const filleted = kernel.fillet(
      box,
      Uint32Array.from(kernel.getSolidEdges(box)),
      2
    );
    const edges = publishedEdges(kernel, [filleted]);
    const byId = new Map(edges.map((edge) => [edge.topologyId, edge]));
    let pairs = 0;
    let sharing = 0;
    for (const edge of edges) {
      const run = edgeRunFrom(edges, edge.topologyId);
      for (let index = 0; index + 1 < run.length; index += 1) {
        pairs += 1;
        if (sharesFace(byId.get(run[index]!)!, byId.get(run[index + 1]!)!)) {
          sharing += 1;
        }
      }
    }
    expect(pairs).toBe(336);
    expect(sharing).toBe(0);
    // Not because the field is empty: every edge names the two faces it
    // bounds.
    expect(edges.every((edge) => edge.adjacentFaceHashes?.length === 2)).toBe(
      true
    );
  });

  it('leaves a bore rim whole and keeps the bore seam unselectable', () => {
    // A closed edge is its own run. It leaves a vertex and returns to it, so
    // there is nowhere for a run to continue to, and the payload cannot even
    // say which way it leaves: the sampler starts a circular rim's polyline
    // wherever it likes — a quarter turn from the rim's own vertex here — so
    // the polyline ends the geometric walk used to key on are not at the
    // vertex at all.
    const plate = kernel.makeBox(40, 40, 10);
    const tool = kernel.copyAndTransformSolid(
      kernel.makeCylinder(5, 10),
      new Float64Array([1, 0, 0, 20, 0, 1, 0, 20, 0, 0, 1, 0, 0, 0, 0, 1])
    );
    const edges = publishedEdges(kernel, [kernel.cut(plate, tool)]);
    const rims = edges.filter((edge) => edge.curve?.type === 'CIRCLE');
    expect(rims).toHaveLength(2);
    for (const rim of rims) {
      // One vertex, named twice, and a polyline that starts elsewhere on it.
      expect(new Set(rim.vertexIds).size).toBe(1);
      expect(edgeRunFrom(edges, rim.topologyId)).toEqual([rim.topologyId]);
    }
    const seams = edges.filter((edge) => edge.displayRole === 'seam');
    expect(seams).toHaveLength(1);
    expect(edgeRunFrom(edges, seams[0]!.topologyId)).toEqual([]);
    // The fallback reaches the same answer from the polyline alone: a closed
    // edge's first and last sample are the same point, whatever point that is.
    const legacy = withoutTopology(edges);
    expect(runLengths(legacy, legacy)).toEqual(runLengths(edges, edges));
    // The plate's own twelve edges are unaffected by the bore.
    expect(
      edges
        .filter((edge) => edge.displayRole !== 'seam' && !rims.includes(edge))
        .map((edge) => edgeRunFrom(edges, edge.topologyId).length)
    ).toEqual(Array(12).fill(1));
  });

  it('answers the same with and without the topology fields, where geometry can', () => {
    // The fallback is not a stub. On a body whose edges publish no
    // `vertexIds` — a `derived` payload restored from IndexedDB, written
    // before the fields existed — the walk welds polyline ends as it always
    // did, and agrees with the topological answer everywhere the geometry is
    // not lying to it.
    //
    // The two places it cannot agree are recorded rather than hidden: two
    // coincident solids, above, where positions cannot tell topology apart;
    // and nothing else. In particular the weld is now relative to the body, so
    // the small-part case agrees too.
    for (const k of [1, 1e-5]) {
      const edges = publishedEdges(kernel, [filletedBox(kernel, k)]);
      const legacy = withoutTopology(edges);
      expect(legacy.every((edge) => edge.vertexIds === undefined)).toBe(true);
      expect(runLengths(legacy, legacy), `${k}x`).toEqual(
        runLengths(edges, edges)
      );
    }
    const chamferBox = kernel.makeBox(20, 20, 10);
    const chamfered = kernel.chamfer(
      chamferBox,
      Uint32Array.from(verticalEdgesOf(kernel, chamferBox)),
      3
    );
    const chamferEdges = publishedEdges(kernel, [chamfered]);
    expect(runLengths(withoutTopology(chamferEdges), chamferEdges)).toEqual(
      runLengths(chamferEdges, chamferEdges)
    );
  });
});
