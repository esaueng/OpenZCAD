import { describe, expect, it } from 'vitest';
import { faceSweepProfile } from './faceSweepProfile';

/** A unit square in the z = 1 plane, two triangles, four shared corners. */
const squareVertices = new Float32Array([0, 0, 1, 2, 0, 1, 2, 2, 1, 0, 2, 1]);
const squareIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);

function loopPoints(loop: { x: number; y: number; z: number }[]) {
  return loop.map((p) => [p.x, p.y, p.z]);
}

describe('faceSweepProfile', () => {
  it('recovers a single outline loop from a face with shared corners', () => {
    const profile = faceSweepProfile(squareVertices, squareIndices, 0, 2);
    expect(profile).not.toBeNull();
    expect(profile!.cap.positions).toHaveLength(4 * 3);
    expect(Array.from(profile!.cap.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(profile!.loops).toHaveLength(1);
    // Wound the way the triangles are, starting anywhere on the boundary.
    expect(loopPoints(profile!.loops[0]!)).toEqual([
      [0, 0, 1],
      [2, 0, 1],
      [2, 2, 1],
      [0, 2, 1]
    ]);
  });

  it('welds corners a tessellation repeated per triangle', () => {
    // The same square with every triangle carrying its own three vertices.
    const split = new Float32Array([
      0, 0, 1, 2, 0, 1, 2, 2, 1, 0, 0, 1, 2, 2, 1, 0, 2, 1
    ]);
    const profile = faceSweepProfile(
      split,
      new Uint32Array([0, 1, 2, 3, 4, 5]),
      0,
      2
    );
    expect(profile).not.toBeNull();
    expect(profile!.cap.positions).toHaveLength(4 * 3);
    expect(profile!.loops).toHaveLength(1);
    expect(profile!.loops[0]).toHaveLength(4);
  });

  it('only reads the requested triangle range of a larger mesh', () => {
    // Two squares in one buffer: the second face's range must not leak into
    // the first face's outline.
    const vertices = new Float32Array([
      ...squareVertices,
      5,
      0,
      1,
      7,
      0,
      1,
      7,
      2,
      1,
      5,
      2,
      1
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const second = faceSweepProfile(vertices, indices, 2, 2);
    expect(second!.loops).toHaveLength(1);
    expect(loopPoints(second!.loops[0]!).every(([x]) => x! >= 5)).toBe(true);
  });

  it('puts the outer loop first and a hole after it', () => {
    // A 4x4 square with a 2x2 hole, as an 8-triangle ring.
    const ring: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4], // outer
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3] // hole
    ];
    const vertices = new Float32Array(ring.flatMap(([x, y]) => [x, y, 0]));
    const indices = new Uint32Array([
      0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7
    ]);
    const profile = faceSweepProfile(vertices, indices, 0, 8);
    expect(profile).not.toBeNull();
    expect(profile!.loops).toHaveLength(2);
    expect(profile!.loops[0]).toHaveLength(4);
    expect(profile!.loops[0]!.every((p) => p.x === 0 || p.x === 4)).toBe(true);
    expect(profile!.loops[1]!.every((p) => p.x === 1 || p.x === 3)).toBe(true);
  });

  it('fails closed on a range whose boundary does not close', () => {
    // A single triangle is a closed loop; a triangle plus a stray triangle
    // sharing one corner only has two outgoing boundary edges at that corner.
    const vertices = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 2, 0, 3, 2, 0
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 3, 4]);
    expect(faceSweepProfile(vertices, indices, 0, 2)).toBeNull();
    expect(faceSweepProfile(vertices, indices, 0, 0)).toBeNull();
    // Degenerate triangles carry no boundary at all.
    expect(
      faceSweepProfile(vertices, new Uint32Array([0, 0, 1]), 0, 1)
    ).toBeNull();
  });
});
