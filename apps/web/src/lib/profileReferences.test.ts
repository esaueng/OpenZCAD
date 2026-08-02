import { describe, expect, it } from 'vitest';
import type { RegionPickData } from '@openzcad/viewport';
import {
  isEntityWideProfileSource,
  profileReferencesForSelection
} from './profileReferences';

function pick(
  profileId: string,
  sourceEntityIds: string[],
  overrides: Partial<RegionPickData> = {}
): RegionPickData {
  return {
    sketchId: 'sketch_1',
    profileId,
    regionFingerprint: 1234,
    samplePoint: { x: 1, y: 2 },
    centroid: { x: 1, y: 2 },
    boundingBox: { min: { x: 0, y: 0 }, max: { x: 2, y: 4 } },
    sourceEntityIds,
    area: 12.5,
    ...overrides
  };
}

const textEntities = new Set(['text_1', 'text_2']);
const isText = (entityId: string): boolean => textEntities.has(entityId);

describe('profileReferencesForSelection', () => {
  it('stores an ordinary region selection exactly as before', () => {
    expect(
      profileReferencesForSelection([pick('profile_a', ['circle_1'])], isText)
    ).toEqual([
      {
        profileId: 'profile_a',
        regionFingerprint: 1234,
        samplePoint: { x: 1, y: 2 },
        sourceArea: 12.5,
        sourceEntityIds: ['circle_1']
      }
    ]);
  });

  it('omits a synthesized legacy id rather than persisting it', () => {
    const references = profileReferencesForSelection(
      [pick('legacy_1234', [])],
      isText
    );
    expect(references[0]).not.toHaveProperty('profileId');
    expect(references[0]).not.toHaveProperty('sourceEntityIds');
  });

  it('stores a text selection as an entity-wide reference', () => {
    // The point of the whole mechanism: no fingerprint, no area, no sample
    // point — those are the fields that change when the string does.
    expect(
      profileReferencesForSelection(
        [pick('profile_text_a', ['text_1'])],
        isText
      )
    ).toEqual([{ all: true, sourceEntityIds: ['text_1'] }]);
  });

  it('collapses every picked glyph of one text object into one reference', () => {
    // "HELLO" is five regions of one entity. Five entity-wide references to
    // the same entity would each resolve to all five profiles, and
    // `resolveRegionProfiles` rejects the duplicate profile ids that follow.
    const references = profileReferencesForSelection(
      [
        pick('profile_text_h', ['text_1']),
        pick('profile_text_e', ['text_1']),
        pick('profile_text_l', ['text_1'])
      ],
      isText
    );
    expect(references).toEqual([{ all: true, sourceEntityIds: ['text_1'] }]);
  });

  it('keeps two different text objects apart', () => {
    const references = profileReferencesForSelection(
      [pick('profile_text_a', ['text_1']), pick('profile_text_b', ['text_2'])],
      isText
    );
    expect(references).toEqual([
      { all: true, sourceEntityIds: ['text_1'] },
      { all: true, sourceEntityIds: ['text_2'] }
    ]);
  });

  it('mixes both modes in one selection', () => {
    const references = profileReferencesForSelection(
      [pick('profile_text_a', ['text_1']), pick('profile_rect', ['rect_1'])],
      isText
    );
    expect(references).toHaveLength(2);
    expect(references[0]).toEqual({ all: true, sourceEntityIds: ['text_1'] });
    expect(references[1]).toMatchObject({ profileId: 'profile_rect' });
  });

  it('does not take the entity-wide path for a mixed-source region', () => {
    // A cell bounded partly by text and partly by a drawn curve is not a
    // text object's own region, so entity identity would over-select.
    const references = profileReferencesForSelection(
      [pick('profile_mixed', ['text_1', 'circle_1'])],
      isText
    );
    expect(references[0]).toMatchObject({ profileId: 'profile_mixed' });
  });
});

describe('isEntityWideProfileSource', () => {
  it('is true for text and false for drawn geometry', () => {
    expect(
      isEntityWideProfileSource({
        objectKind: 'text',
        text: 'HI',
        fontFamily: 'open-sans',
        fontStyle: 'regular',
        size: 10,
        x: 0,
        y: 0
      })
    ).toBe(true);
    expect(
      isEntityWideProfileSource({
        objectKind: 'circle',
        radius: 5,
        centerX: 0,
        centerY: 0
      })
    ).toBe(false);
    expect(isEntityWideProfileSource(undefined)).toBe(false);
  });
});
