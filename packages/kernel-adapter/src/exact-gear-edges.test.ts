import { describe, expect, it } from 'vitest';
import type { EdgeWitnessV1, QuantizedTopologyPoint } from '@openzcad/shared';

import {
  gearEdgeAssignments,
  gearEdgeFrame,
  orderGearEdgePieces,
  type GearEdgeFrame
} from './exact-gear-edges';
import type { RemusTopologyCandidate } from './remus-lineage';

const QUANTUM = 1_000_000;

function point(x: number, y: number, z: number): QuantizedTopologyPoint {
  return [Math.round(x * QUANTUM), Math.round(y * QUANTUM), Math.round(z * QUANTUM)];
}

/** An open edge between two points, as its exact witness. */
function open(
  a: [number, number, number],
  b: [number, number, number],
  curveType = 'LINE'
): EdgeWitnessV1 {
  const ends = [point(...a), point(...b)].sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index]! - right[index]!;
    }
    return 0;
  }) as [QuantizedTopologyPoint, QuantizedTopologyPoint];
  return {
    curveType,
    length: Math.round(
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * QUANTUM
    ),
    closed: false,
    endpoints: ends,
    midpoint: point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
  };
}

/** A circle about the Z axis at height `z`. */
function circle(radius: number, z: number, curveType = 'CIRCLE'): EdgeWitnessV1 {
  return {
    curveType,
    length: Math.round(2 * Math.PI * radius * QUANTUM),
    closed: true,
    center: point(0, 0, z),
    axis: [0, 0, 1_000_000_000]
  };
}

/** An arc of `radius` about Z at height `z`, between two angles in degrees. */
function arc(radius: number, z: number, from: number, to: number): EdgeWitnessV1 {
  const at = (degrees: number): [number, number, number] => [
    radius * Math.cos((degrees * Math.PI) / 180),
    radius * Math.sin((degrees * Math.PI) / 180),
    z
  ];
  return open(at(from), at(to), 'CIRCLE');
}

const frame = gearEdgeFrame([0, 0, 0], [0, 0, 2])!;

function edge(handle: number, witness: EdgeWitnessV1): RemusTopologyCandidate {
  return { handle, kind: 'edge', witness };
}

function names(
  edges: readonly RemusTopologyCandidate[],
  facesOfEdge: Record<number, number[]>,
  faceNames: Record<number, string>,
  useFrame: GearEdgeFrame | null = frame
): Record<number, string> {
  return Object.fromEntries(
    gearEdgeAssignments({
      edges,
      facesOfEdge: new Map(
        Object.entries(facesOfEdge).map(([key, faces]) => [Number(key), faces])
      ),
      faceNames: new Map(
        Object.entries(faceNames).map(([key, name]) => [Number(key), name])
      ),
      frame: useFrame
    }).map((assignment) => [assignment.handle, assignment.lineageName])
  );
}

describe('gear edge names (M14)', () => {
  const faces = {
    1: 'gear.face.cap.start',
    2: 'gear.face.collar.start',
    3: 'gear.face.shoulder.start',
    4: 'gear.face.tooth[3].tip'
  };

  it('names an edge from its two faces, in string order whichever way they are listed', () => {
    const rim = edge(10, circle(11, 0));
    const expected = {
      10: 'gear.edge.between.gear.face.cap.start|gear.face.collar.start'
    };
    expect(names([rim], { 10: [1, 2] }, faces)).toEqual(expected);
    expect(names([rim], { 10: [2, 1] }, faces)).toEqual(expected);
    // The name needs no frame: only several edges of one pair are counted.
    expect(names([rim], { 10: [1, 2] }, faces, null)).toEqual(expected);
  });

  it('gives the same names whatever order the kernel lists edges and faces in', () => {
    const edges = [
      edge(10, circle(11, 0)),
      edge(11, circle(11, 3)),
      edge(12, arc(9.9, 3, 50, 60)),
      edge(13, arc(11, 9, 10, 20)),
      edge(14, arc(11, 3, 10, 20))
    ];
    const bounds = {
      10: [1, 2],
      11: [2, 3],
      12: [3, 4],
      13: [2, 4],
      14: [4, 2]
    };
    const forward = names(edges, bounds, faces);
    const backward = names(
      [...edges].reverse(),
      Object.fromEntries(
        Object.entries(bounds)
          .reverse()
          .map(([key, value]) => [key, [...value].reverse()])
      ),
      Object.fromEntries(Object.entries(faces).reverse())
    );
    expect(backward).toEqual(forward);
    expect(new Set(Object.values(forward)).size).toBe(5);
    expect(forward[12]).toBe(
      'gear.edge.between.gear.face.shoulder.start|gear.face.tooth[3].tip'
    );
  });

  it('indexes several edges between one pair, and only those, along the axis', () => {
    const lower = edge(13, arc(11, 3, 10, 20));
    const upper = edge(14, arc(11, 9, 200, 210));
    const pair = 'gear.edge.between.gear.face.collar.start|gear.face.tooth[3].tip';
    for (const edges of [
      [lower, upper],
      [upper, lower]
    ]) {
      expect(names(edges, { 13: [2, 4], 14: [2, 4] }, faces)).toEqual({
        13: `${pair}.piece.0.of.2`,
        14: `${pair}.piece.1.of.2`
      });
    }
    // One edge between the pair carries no index.
    expect(names([upper], { 14: [2, 4] }, faces)).toEqual({ 14: pair });
    // The axis the other way counts from the other end.
    expect(
      names(
        [lower, upper],
        { 13: [2, 4], 14: [2, 4] },
        faces,
        gearEdgeFrame([0, 0, 12], [0, 0, -1])
      )
    ).toEqual({
      14: `${pair}.piece.0.of.2`,
      13: `${pair}.piece.1.of.2`
    });
  });

  it('orders pieces by where they stand along the axis, whatever their angle', () => {
    expect(
      orderGearEdgePieces(
        [arc(11, 9, 100, 110), arc(11, 3, 200, 210), arc(11, 6, 20, 30)],
        frame
      )
    ).toEqual([1, 2, 0]);
    // Two rings between one pair of faces, one above the other.
    expect(orderGearEdgePieces([circle(11, 9), circle(11, 3)], frame)).toEqual(
      [1, 0]
    );
    // An arc stands half way between its ends, not at the witness's
    // midpoint, which the kernel puts across the circle for an arc that ends
    // on a seam.
    const onSeam = arc(11, 3, 0, 1);
    const skewed: EdgeWitnessV1 = onSeam.closed
      ? onSeam
      : { ...onSeam, midpoint: point(-11, 0, 30) };
    expect(orderGearEdgePieces([arc(11, 6, 0, 1), skewed], frame)).toEqual([
      1, 0
    ]);
  });

  it('names no piece when two stand at one height', () => {
    // A collar's seam cuts the arc it shares with a flush tip in two. Around
    // the axis nothing fixed tells the halves apart, so neither is named.
    const halves = [arc(11, 3, -1, 0), arc(11, 3, 0, 1)];
    expect(orderGearEdgePieces(halves, frame)).toBeNull();
    expect(orderGearEdgePieces([circle(11, 3), circle(9, 3)], frame)).toBeNull();
    // One tie leaves the whole pair uncounted.
    expect(
      orderGearEdgePieces([...halves, arc(11, 9, 0, 1)], frame)
    ).toBeNull();
    // No frame to count along.
    expect(
      orderGearEdgePieces([arc(11, 3, 0, 1), arc(11, 9, 0, 1)], null)
    ).toBeNull();
    expect(
      names(
        [edge(13, halves[0]!), edge(14, halves[1]!)],
        { 13: [2, 4], 14: [2, 4] },
        faces
      )
    ).toEqual({});
  });

  it('leaves out seams, open or shared edges, and edges beside an unnamed or twice-named face', () => {
    const line = open([11, 0, 0], [11, 0, 3]);
    // A seam bounds one face twice; the solid lists that face once.
    expect(names([edge(20, line)], { 20: [2] }, faces)).toEqual({});
    expect(names([edge(20, line)], { 20: [1, 2, 3] }, faces)).toEqual({});
    expect(names([edge(20, line)], {}, faces)).toEqual({});
    expect(names([edge(20, line)], { 20: [2, 9] }, faces)).toEqual({});
    expect(
      names([edge(20, line)], { 20: [1, 2] }, { ...faces, 5: faces[2] })
    ).toEqual({});
  });

  it('leaves out an edge whose witness cannot carry a name', () => {
    expect(
      names([edge(10, circle(11, 0, 'BSPLINE'))], { 10: [1, 2] }, faces)
    ).toEqual({});
    // One unreadable piece leaves the rest uncounted.
    expect(
      names(
        [edge(10, circle(11, 0, 'BSPLINE')), edge(11, circle(11, 3))],
        { 10: [1, 2], 11: [1, 2] },
        faces
      )
    ).toEqual({});
  });

  it('builds a frame from any axis that has a direction', () => {
    expect(gearEdgeFrame([1, 2, 3], [0, 3, 4])).toEqual({
      origin: [1, 2, 3],
      axis: [0, 0.6, 0.8]
    });
    expect(gearEdgeFrame([0, 0, 0], [0, 0, 0])).toBeNull();
    expect(gearEdgeFrame([0, 0, 0], [0, Number.NaN, 1])).toBeNull();
  });
});
