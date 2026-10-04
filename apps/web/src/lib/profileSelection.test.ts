import { describe, expect, it } from 'vitest';
import type { RegionPickData } from '@openzcad/viewport';
import { updateProfileSelection } from './profileSelection';

function profile(profileId: string, sketchId = 'sketch-a'): RegionPickData {
  return {
    sketchId,
    profileId,
    regionFingerprint: profileId.length,
    samplePoint: { x: 0, y: 0 },
    centroid: { x: 0, y: 0 },
    boundingBox: {
      min: { x: -1, y: -1 },
      max: { x: 1, y: 1 }
    },
    sourceEntityIds: [`entity-${profileId}`],
    area: 4
  };
}

describe('updateProfileSelection', () => {
  it('plain-clicks one profile without requiring a modifier', () => {
    expect(
      updateProfileSelection([profile('a'), profile('b')], profile('c'), {
        additive: false,
        toggle: false
      }).map((item) => item.profileId)
    ).toEqual(['c']);
  });

  it('Shift adds, and Shift on a selected profile takes it back out', () => {
    const selected = updateProfileSelection([profile('a')], profile('b'), {
      additive: true,
      toggle: false
    });
    expect(selected.map((item) => item.profileId)).toEqual(['a', 'b']);
    expect(
      updateProfileSelection(selected, profile('b'), {
        additive: true,
        toggle: false
      }).map((item) => item.profileId)
    ).toEqual(['a']);
  });

  it('selects and removes a whole group for a pick that stands for one', () => {
    const word = [profile('g1'), profile('g2'), profile('g3')];
    const picked = updateProfileSelection(
      [profile('a')],
      word[1]!,
      { additive: false, toggle: false },
      word
    );
    expect(picked.map((item) => item.profileId)).toEqual(['g1', 'g2', 'g3']);
    const added = updateProfileSelection(
      [profile('a')],
      word[2]!,
      { additive: true, toggle: false },
      word
    );
    expect(added.map((item) => item.profileId)).toEqual([
      'a',
      'g1',
      'g2',
      'g3'
    ]);
    expect(
      updateProfileSelection(
        added,
        word[0]!,
        { additive: true, toggle: false },
        word
      ).map((item) => item.profileId)
    ).toEqual(['a']);
  });

  it('Ctrl or Cmd toggles a profile in and back out', () => {
    const added = updateProfileSelection([profile('a')], profile('b'), {
      additive: false,
      toggle: true
    });
    expect(added.map((item) => item.profileId)).toEqual(['a', 'b']);
    expect(
      updateProfileSelection(added, profile('a'), {
        additive: false,
        toggle: true
      }).map((item) => item.profileId)
    ).toEqual(['b']);
  });

  it('never combines profiles from different sketches', () => {
    expect(
      updateProfileSelection(
        [profile('a', 'sketch-a')],
        profile('b', 'sketch-b'),
        { additive: true, toggle: false }
      )
    ).toEqual([profile('b', 'sketch-b')]);
  });
});
