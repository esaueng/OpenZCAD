import { describe, expect, it } from 'vitest';
import { inspectorHeadingForFeature } from './inspectorHeading';

const offsetFace = {
  featureName: 'Offset face',
  featureKindLabel: 'Direct edit',
  directEdit: true
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

  it('keeps inferred objects as readouts when no command is running', () => {
    expect(
      inspectorHeadingForFeature({
        ...offsetFace,
        selectionLabel: 'Front face',
        selectionBodyName: 'Bracket',
        featureSelectionSource: 'inferred',
        commandSession: null
      })
    ).toEqual({ eyebrow: 'Bracket', title: 'Front face', demoted: true });
  });

  it('uses the body name for an inferred whole-body readout', () => {
    expect(
      inspectorHeadingForFeature({
        ...offsetFace,
        selectionLabel: 'Bracket',
        selectionBodyName: 'Bracket',
        featureSelectionSource: 'inferred',
        commandSession: null
      })
    ).toEqual({ eyebrow: 'Bracket', title: 'Bracket', demoted: true });
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

  it('says Edit feature for a history feature, whatever its kind', () => {
    expect(
      inspectorHeadingForFeature({
        featureName: 'Box 1',
        featureKindLabel: 'Primitive',
        featureSelectionSource: 'pinned',
        commandSession: null
      })
    ).toEqual({ eyebrow: 'Edit feature', title: 'Box 1', demoted: false });
  });
});
