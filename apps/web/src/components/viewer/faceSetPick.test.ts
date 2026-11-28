import { describe, expect, it } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import type { PickCandidate } from '@openzcad/viewport';
import { faceAheadOfLeadEdge, facesAheadOfEdges } from './faceSetPick';

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

describe('faceAheadOfLeadEdge', () => {
  it('puts the face of a leading edge’s body first on a touch, the rest in order', () => {
    const stack = [
      candidate('edge', 'small', 'e1', 10),
      candidate('edge', 'small', 'e2', 10.1),
      candidate('face', 'small', 'top', 10.2),
      candidate('face', 'large', 'side', 40)
    ];
    expect(ids(faceAheadOfLeadEdge(stack, 'touch'))).toEqual([
      'top',
      'e1',
      'e2',
      'side'
    ]);
  });

  it('never reaches past the first surface under the finger', () => {
    // A tap on an insert just beside a U bracket's front lip: the lip's edge
    // band leads, the insert's face is the first surface under the finger,
    // and the bracket's rear face is behind it, hidden.
    const beside = [
      candidate('edge', 'bracket', 'lip-edge', 10),
      candidate('face', 'insert', 'insert-top', 12),
      candidate('face', 'bracket', 'rear-face', 30)
    ];
    expect(faceAheadOfLeadEdge(beside, 'touch')).toBe(beside);
    // Just past a body's outline, the body behind it under the finger.
    const past = [
      candidate('edge', 'small', 'e1', 10),
      candidate('face', 'large', 'side', 40)
    ];
    expect(faceAheadOfLeadEdge(past, 'touch')).toBe(past);
    // A whole body with no face topology is a surface too.
    const body = [
      candidate('edge', 'bracket', 'lip-edge', 10),
      candidate('body', 'insert', 'insert', 12),
      candidate('face', 'bracket', 'rear-face', 30)
    ];
    expect(faceAheadOfLeadEdge(body, 'touch')).toBe(body);
    const faceFirst = [past[1]!, past[0]!];
    expect(faceAheadOfLeadEdge(faceFirst, 'touch')).toBe(faceFirst);
    expect(faceAheadOfLeadEdge([], 'touch')).toEqual([]);
  });

  it('leaves a mouse’s and a pen’s stack as the pick service ordered it', () => {
    // Their edge band is half a finger's: picking stays as it was.
    const stack = [
      candidate('edge', 'small', 'e1', 10),
      candidate('face', 'small', 'top', 10.2)
    ];
    for (const pointerType of ['mouse', 'pen', '', undefined]) {
      expect(faceAheadOfLeadEdge(stack, pointerType)).toBe(stack);
    }
    expect(ids(faceAheadOfLeadEdge(stack, 'touch'))).toEqual(['top', 'e1']);
  });
});
