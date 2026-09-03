import { describe, expect, it } from 'vitest';
import { inspectorHeadingForFeature } from './inspectorHeading';

const offsetFace = {
  featureName: 'Offset face',
  featureKindLabel: 'Direct edit'
};

describe('inspector heading', () => {
  it('names the panel after a feature the user picked in the tree', () => {
    expect(
      inspectorHeadingForFeature({
        ...offsetFace,
        featureSelectionSource: 'pinned',
        commandSession: { title: 'Fillet' }
      })
    ).toEqual({ eyebrow: 'Direct edit', title: 'Offset face', demoted: false });
  });

  it('names a demoted feature panel after the selected object', () => {
    const heading = inspectorHeadingForFeature({
      ...offsetFace,
      selectionLabel: 'Front face',
      selectionBodyName: 'Bracket',
      featureSelectionSource: 'inferred',
      commandSession: { title: 'Fillet' }
    });
    expect(heading).toEqual({
      eyebrow: 'Bracket',
      title: 'Front face',
      demoted: true
    });
    expect(heading.title).not.toBe(offsetFace.featureName);
    expect(heading.title).not.toBe('Fillet');
  });

  it('falls back to the defining feature when no selection label is available', () => {
    expect(
      inspectorHeadingForFeature({
        ...offsetFace,
        featureSelectionSource: 'inferred',
        commandSession: { title: 'Fillet' }
      })
    ).toEqual({
      eyebrow: 'Direct edit',
      title: 'Offset face',
      demoted: true
    });
  });

  it('keeps an inferred feature as the subject when no command is running', () => {
    // Selecting a body with nothing armed is still "show me what made this",
    // and its edit form is the point of the panel.
    expect(
      inspectorHeadingForFeature({
        ...offsetFace,
        featureSelectionSource: 'inferred',
        commandSession: null
      })
    ).toEqual({ eyebrow: 'Direct edit', title: 'Offset face', demoted: false });
  });

  it('keeps the feature as the subject when its provenance is unknown', () => {
    expect(
      inspectorHeadingForFeature({
        ...offsetFace,
        featureSelectionSource: null,
        commandSession: { title: 'Fillet' }
      }).title
    ).toBe('Offset face');
  });
});
