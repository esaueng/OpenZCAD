import { describe, expect, it } from 'vitest';
import {
  validatedFeatureRejection,
  warningForFeature
} from './featureValidation';

const safe = {
  featureName: 'Join housings',
  warnings: [] as string[],
  bodyPresent: true,
  documentMoved: false
};

describe('validated feature warnings', () => {
  it('extracts only the warning for the candidate feature', () => {
    const warnings = [
      'Feature "Other feature": unrelated',
      'Feature "Join housings": Union does not fill empty space.'
    ];
    expect(warningForFeature('Join housings', warnings)).toBe(
      'Union does not fill empty space.'
    );
  });

  it('rejects the kernel warning before committing', () => {
    expect(
      validatedFeatureRejection({
        ...safe,
        warnings: ['Feature "Join housings": Union does not fill empty space.']
      })
    ).toBe('Union does not fill empty space.');
  });

  it('does not treat an empty attributed warning as success', () => {
    expect(
      warningForFeature('Join housings', ['Feature "Join housings":'])
    ).toBe('This operation does not produce valid geometry.');
  });

  it('rejects a missing result and a stale document', () => {
    expect(validatedFeatureRejection({ ...safe, bodyPresent: false })).toBe(
      'The operation did not produce its result body.'
    );
    expect(validatedFeatureRejection({ ...safe, documentMoved: true })).toBe(
      'The document changed while the operation validated.'
    );
  });

  it('accepts a warning-free current result', () => {
    expect(validatedFeatureRejection(safe)).toBeNull();
  });
});
