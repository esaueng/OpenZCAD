import { describe, expect, it } from 'vitest';
import type { PlaneBasis } from '@openzcad/geometry';
import type { BodyId, EdgeTopology } from '@openzcad/shared';
import {
  projectionPickEdges,
  projectionPickProjects,
  projectionRepickAccepts
} from './projectionPickEdges';

/** The XY plane: u = x, v = y. */
const XY: PlaneBasis = {
  origin: { x: 0, y: 0, z: 0 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 }
};

const FACE_HASH = {
  top: 1,
  front: 2,
  right: 3,
  back: 4,
  left: 5,
  cap: 6
} as const;
type Face = keyof typeof FACE_HASH;

const line = (
  topologyId: string,
  from: [number, number, number],
  to: [number, number, number],
  faces: Face[],
  extra: Partial<EdgeTopology> = {}
): EdgeTopology => ({
  topologyId,
  hash: topologyId.length * 1000 + topologyId.charCodeAt(topologyId.length - 1),
  points: [...from, ...to],
  curve: { type: 'LINE' },
  adjacentFaceHashes: faces.map((name) => FACE_HASH[name]),
  ...extra
});

/** A synthetic 20 x 10 x 5 block's top face (hash `top`) and one riser. */
const edges: EdgeTopology[] = [
  line('e1', [0, 0, 5], [20, 0, 5], ['top', 'front']),
  line('e2', [20, 0, 5], [20, 10, 5], ['top', 'right']),
  line('e3', [20, 10, 5], [0, 10, 5], ['top', 'back']),
  line('e4', [0, 10, 5], [0, 0, 5], ['top', 'left']),
  line('riser', [0, 0, 0], [0, 0, 5], ['front', 'left']),
  line('seam', [5, 0, 5], [5, 10, 5], ['top'], { displayRole: 'seam' })
];
const body = 'b' as BodyId;
const edge = (topologyId: string) =>
  ({ bodyId: body, kind: 'edge', topologyId }) as const;
const face = (name: Face) =>
  ({
    bodyId: body,
    kind: 'face',
    topologyId: `f-${name}`,
    hash: FACE_HASH[name]
  }) as const;

describe('projectionPickEdges', () => {
  it('names one edge, or a face boundary without its seams', () => {
    expect(
      projectionPickEdges(edges, edge('e2')).map((e) => e.topologyId)
    ).toEqual(['e2']);
    expect(
      projectionPickEdges(edges, face('top')).map((e) => e.topologyId)
    ).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(projectionPickEdges(edges, edge('gone'))).toEqual([]);
    expect(projectionPickEdges(edges, { kind: 'body' })).toEqual([]);
  });
});

describe('projectionPickProjects', () => {
  it('takes an edge or face that shows on the plane', () => {
    const basis = XY;
    expect(
      projectionPickProjects({ edges, selection: edge('e1'), basis })
    ).toBe(true);
    expect(
      projectionPickProjects({ edges, selection: face('top'), basis })
    ).toBe(true);
  });

  it('refuses an edge seen end-on, which projects to a point', () => {
    expect(
      projectionPickProjects({ edges, selection: edge('riser'), basis: XY })
    ).toBe(false);
  });
});

describe('projectionRepickAccepts', () => {
  const accepts = (
    selection: Parameters<typeof projectionRepickAccepts>[0]['selection'],
    objectKind: 'line' | 'circle' | 'arc' = 'line'
  ) => projectionRepickAccepts({ edges, selection, basis: XY, objectKind });

  it('takes one edge that projects to the same kind of curve', () => {
    expect(accepts(edge('e1'))).toBe(true);
  });

  it('refuses a face with several boundary edges', () => {
    expect(accepts(face('top'))).toBe(false);
  });

  it('refuses an edge of another curve kind or one seen end-on', () => {
    expect(accepts(edge('e1'), 'circle')).toBe(false);
    expect(accepts(edge('riser'))).toBe(false);
  });

  it('takes a face bounded by a single edge', () => {
    const disc: EdgeTopology[] = [line('rim', [0, 0, 5], [4, 0, 5], ['cap'])];
    expect(
      projectionRepickAccepts({
        edges: disc,
        selection: face('cap'),
        basis: XY,
        objectKind: 'line'
      })
    ).toBe(true);
  });
});
