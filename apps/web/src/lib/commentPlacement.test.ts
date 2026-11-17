import { describe, expect, it } from 'vitest';
import { commentPlacementTarget } from './commentPlacement';

describe('commentPlacementTarget', () => {
  it('takes the nearest body surface, past sketch profiles and regions', () => {
    const face = { selection: { kind: 'face', bodyId: 'b1' }, depth: 3 };
    expect(
      commentPlacementTarget([
        { selection: null, region: { profileId: 'p' }, depth: 1 },
        { selection: { kind: 'edge' }, sketchId: 'sk_1', depth: 2 },
        face,
        { selection: { kind: 'face', bodyId: 'b2' }, depth: 4 }
      ])
    ).toBe(face);
  });

  it('places nothing where only sketch geometry or empty space is', () => {
    expect(
      commentPlacementTarget([{ selection: null, region: { profileId: 'p' } }])
    ).toBeNull();
    expect(commentPlacementTarget([])).toBeNull();
  });
});
