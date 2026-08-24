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

  it('lets the running command name the panel over an inferred feature', () => {
    // The recorded defect: filleting an edge on a body whose last operation
    // was an offset titled the panel "Offset face" while the command card
    // said "Fillet".
    const heading = inspectorHeadingForFeature({
      ...offsetFace,
      featureSelectionSource: 'inferred',
      commandSession: { title: 'Fillet' }
    });
    expect(heading.title).toBe('Fillet');
    expect(heading.title).not.toBe(offsetFace.featureName);
    expect(heading.demoted).toBe(true);
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
