import { describe, expect, it } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import type { PickCandidate } from '@openzcad/viewport';
import { facesAheadOfEdges } from './faceSetPick';

const candidate = (
  kind: 'edge' | 'face' | 'body',
  bodyId: string,
  topologyId: string,
  distance: number
): PickCandidate => ({
  kind,
  distance,
  hit: {} as PickCandidate['hit'],
  selection: { bodyId: bodyId as BodyId, kind, topologyId }
});

const ids = (stack: readonly PickCandidate[]) =>
  stack.map((entry) => entry.selection?.topologyId);

describe('facesAheadOfEdges', () => {
  it('puts the face under the pointer ahead of its edge on the held body', () => {
    const stack = [
      candidate('edge', 'a', 'e1', 10),
      candidate('edge', 'a', 'e2', 10.1),
      candidate('face', 'a', 'f1', 10.2),
      candidate('face', 'a', 'f2', 30)
    ];
    // The edges keep their order behind it: a second click steps to e1.
    expect(ids(facesAheadOfEdges(stack, 'a'))).toEqual([
      'f1',
      'e1',
      'e2',
      'f2'
    ]);
  });

  it('leaves every other stack as the pick service ordered it', () => {
    const edgeFirst = [
      candidate('edge', 'a', 'e1', 10),
      candidate('face', 'a', 'f1', 10.2)
    ];
    // No face set held.
    expect(facesAheadOfEdges(edgeFirst, null)).toBe(edgeFirst);
    // Faces held on another body: that Shift pick selects bodies.
    expect(facesAheadOfEdges(edgeFirst, 'b')).toBe(edgeFirst);
    // A face already leads.
    const faceFirst = [edgeFirst[1]!, edgeFirst[0]!];
    expect(facesAheadOfEdges(faceFirst, 'a')).toBe(faceFirst);
    // An edge of the held body with no face of it under the pointer.
    const bare = [
      candidate('edge', 'a', 'e1', 10),
      candidate('face', 'b', 'g1', 12)
    ];
    expect(facesAheadOfEdges(bare, 'a')).toBe(bare);
    expect(facesAheadOfEdges([], 'a')).toEqual([]);
  });
});
