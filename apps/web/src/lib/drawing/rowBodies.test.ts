import { describe, expect, it } from 'vitest';
import type { BodyId, BodyRepresentation } from '@openzcad/shared';
import {
  rowBodiesBytes,
  rowBodiesCover,
  rowBodiesEvictions,
  rowBodiesScope,
  scopedRowBodies,
  type RowBodies
} from './rowBodies';

/** A body of `triangles` triangles and `edges` two-point edges. */
function body(id: string, triangles: number, edges = 0): BodyRepresentation {
  return {
    bodyId: id as BodyId,
    name: id,
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(triangles * 9),
      indices: new Uint32Array(triangles * 3)
    },
    faceCount: 0,
    color: '#888888',
    exportableStep: true,
    consumed: false,
    volume: 0,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    topology: {
      faces: [],
      edges: Array.from({ length: edges }, (_unused, index) => ({
        topologyId: `e${index}`,
        hash: index,
        points: [0, 0, 0, 1, 0, 0]
      }))
    }
  };
}

describe('F06 row bodies: what a drawing keeps of a row’s build', () => {
  it('keeps only the bodies its views draw', () => {
    const built: RowBodies = {
      a: body('a', 1),
      b: body('b', 1),
      c: body('c', 1)
    };
    const scope = rowBodiesScope(['b', 'a', 'b']);
    const kept = scopedRowBodies(built, scope);
    expect(Object.keys(kept).sort()).toEqual(['a', 'b']);
    expect(kept.a).toBe(built.a);
    // A body the row does not build is simply absent.
    expect(
      Object.keys(scopedRowBodies(built, rowBodiesScope(['a', 'gone'])))
    ).toEqual(['a']);
    expect(scopedRowBodies(built, rowBodiesScope([]))).toEqual({});
  });

  it('knows when a kept build no longer covers what its views draw', () => {
    const scope = rowBodiesScope(['a', 'b']);
    expect(rowBodiesCover(scope, rowBodiesScope(['a']))).toBe(true);
    expect(rowBodiesCover(scope, rowBodiesScope(['b', 'a']))).toBe(true);
    expect(rowBodiesCover(scope, rowBodiesScope(['a', 'c']))).toBe(false);
    expect(rowBodiesCover(rowBodiesScope([]), rowBodiesScope([]))).toBe(true);
    expect(rowBodiesCover(rowBodiesScope([]), rowBodiesScope(['a']))).toBe(
      false
    );
  });

  it('sizes a build by its buffers and topology', () => {
    // 2 triangles: 18 floats and 6 indices, 4 bytes each.
    expect(rowBodiesBytes({ a: body('a', 2) })).toBe(96);
    // An edge: its record's allowance and six numbers of polyline.
    expect(rowBodiesBytes({ a: body('a', 2, 1) })).toBe(96 + 256 + 48);
    expect(rowBodiesBytes({ a: undefined })).toBe(0);
  });
});

describe('F06 row bodies: the inactive budget', () => {
  const sized = (bytes: number): RowBodies => ({
    a: body('a', bytes / 48)
  });
  const holder = (
    name: string,
    records: RowBodies[],
    active = false
  ): { holder: string; records: RowBodies[]; active: boolean } => ({
    holder: name,
    records,
    active
  });

  it('lets the oldest go until the rest fit', () => {
    const [one, two, three] = [sized(480), sized(480), sized(480)];
    const holders = [
      holder('oldest', [one]),
      holder('middle', [two]),
      holder('newest', [three])
    ];
    expect(rowBodiesEvictions(holders, 1440)).toEqual([]);
    expect(rowBodiesEvictions(holders, 960)).toEqual(['oldest']);
    expect(rowBodiesEvictions(holders, 500)).toEqual(['oldest', 'middle']);
    expect(rowBodiesEvictions(holders, 0)).toEqual([
      'oldest',
      'middle',
      'newest'
    ]);
  });

  it('never lets the active holder go, and counts what it holds as free', () => {
    const [shared, own] = [sized(480), sized(480)];
    const holders = [
      holder('older', [shared]),
      holder('shown', [shared, own], true)
    ];
    // What `older` holds the shown drawing holds anyway: nothing to free.
    expect(rowBodiesEvictions(holders, 0)).toEqual([]);
    // A build held elsewhere (the row cache) is free as well.
    expect(
      rowBodiesEvictions([holder('older', [own])], 0, new Set([own]))
    ).toEqual([]);
  });

  it('counts a build two holders share once, freed with the last of them', () => {
    const [shared, own] = [sized(480), sized(480)];
    const holders = [
      holder('first', [shared]),
      holder('second', [shared]),
      holder('third', [own])
    ];
    // 960 bytes in all: within budget, although three holders hold 1440.
    expect(rowBodiesEvictions(holders, 960)).toEqual([]);
    // Letting `first` go frees nothing, so `second` goes too.
    expect(rowBodiesEvictions(holders, 480)).toEqual(['first', 'second']);
  });

  it('leaves a holder with no row bodies alone', () => {
    expect(
      rowBodiesEvictions([holder('plain', []), holder('rows', [sized(480)])], 0)
    ).toEqual(['rows']);
  });
});
