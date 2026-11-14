import { describe, expect, it } from 'vitest';
import type { BodyId, TopologySelection } from '@openzcad/shared';
import { sameFacePick, toggleFaceInSet } from './faceSetSelection';

const body = 'body_a' as BodyId;
const face = (topologyId: string, hash: number): TopologySelection => ({
  bodyId: body,
  kind: 'face',
  topologyId,
  hash
});

describe('toggleFaceInSet', () => {
  it('adds a new face to the end and takes a held face back out', () => {
    const first = face('f1', 1);
    const second = face('f2', 2);
    const added = toggleFaceInSet([first], second);
    expect(added).toEqual([first, second]);
    expect(added[1]).not.toBe(second);
    expect(toggleFaceInSet(added, face('f1', 1))).toEqual([second]);
    expect(toggleFaceInSet([first], face('f1', 1))).toEqual([]);
  });

  it('matches by topology id first, then by hash', () => {
    expect(sameFacePick(face('f1', 1), face('f1', 9))).toBe(true);
    expect(sameFacePick(face('f1', 1), face('f2', 1))).toBe(false);
    expect(
      sameFacePick(
        { bodyId: body, kind: 'face', hash: 4 },
        { bodyId: body, kind: 'face', topologyId: 'f4', hash: 4 }
      )
    ).toBe(true);
    expect(
      sameFacePick(face('f1', 1), { ...face('f1', 1), bodyId: 'b' as BodyId })
    ).toBe(false);
  });
});
