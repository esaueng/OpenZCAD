import { describe, expect, it } from 'vitest';
import { toFeatureId } from '@openzcad/shared';
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
    ).toEqual({ message: 'Union does not fill empty space.' });
  });

  it('does not treat an empty attributed warning as success', () => {
    expect(
      warningForFeature('Join housings', ['Feature "Join housings":'])
    ).toBe('This operation does not produce valid geometry.');
  });

  it('rejects a missing result and a stale document', () => {
    expect(
      validatedFeatureRejection({ ...safe, bodyPresent: false })
    ).toEqual({ message: 'The operation did not produce its result body.' });
    expect(
      validatedFeatureRejection({ ...safe, documentMoved: true })
    ).toEqual({
      message: 'The document changed while the operation validated.'
    });
  });

  it('accepts a warning-free current result', () => {
    expect(validatedFeatureRejection(safe)).toBeNull();
  });
});

/**
 * A name prefix cannot answer "did my feature build?".
 *
 * The rebuild loop writes the same `Feature "<name>":` shape whether a
 * feature FAILED to build or was deliberately SKIPPED for being suppressed —
 * ten lines apart in exact-build-loop.ts, in identical format. And a name
 * repeats: nothing stops two features sharing one. So the gate refused an
 * edit because some unrelated feature was suppressed, and blamed the wrong
 * feature whenever a name collided. Attribution is what decides both.
 */
describe('a verdict with warning attribution', () => {
  const suppressed = {
    featureId: toFeatureId('feat_old'),
    featureName: 'Shell',
    message: 'Feature "Shell": Suppressed; skipped during exact rebuild.',
    kind: 'suppressed' as const
  };

  it('does not read a suppression as a failure', () => {
    expect(
      validatedFeatureRejection({
        featureName: 'Shell',
        featureId: toFeatureId('feat_new'),
        warnings: [suppressed.message],
        featureWarnings: [suppressed],
        bodyPresent: true,
        documentMoved: false
      })
    ).toBeNull();
  });

  it('refused it before, on the string alone', () => {
    // The same inputs with no attribution: this is what every gated commit
    // saw, and why creating a feature named like a suppressed one failed.
    expect(
      validatedFeatureRejection({
        featureName: 'Shell',
        warnings: [suppressed.message],
        bodyPresent: true,
        documentMoved: false
      })?.message
    ).toBe('Suppressed; skipped during exact rebuild.');
  });

  it('blames the feature that actually failed, not the one that shares its name', () => {
    const mine = toFeatureId('feat_mine');
    const theirs = toFeatureId('feat_theirs');
    const verdict = validatedFeatureRejection({
      featureName: 'Shell',
      featureId: mine,
      warnings: [
        'Feature "Shell": Shell wall thickness exceeds the body.',
        'Feature "Shell": Suppressed; skipped during exact rebuild.'
      ],
      featureWarnings: [
        {
          featureId: theirs,
          featureName: 'Shell',
          message: 'Feature "Shell": Shell wall thickness exceeds the body.',
          kind: 'build-failed'
        },
        { ...suppressed, featureId: mine, featureName: 'Shell' }
      ],
      bodyPresent: true,
      documentMoved: false
    });
    // The failure belongs to a different feature; mine was merely suppressed.
    expect(verdict).toBeNull();
  });

  it('still refuses when the failure is genuinely mine', () => {
    const mine = toFeatureId('feat_mine');
    expect(
      validatedFeatureRejection({
        featureName: 'Shell',
        featureId: mine,
        warnings: ['Feature "Shell": Shell wall thickness exceeds the body.'],
        featureWarnings: [
          {
            featureId: mine,
            featureName: 'Shell',
            message:
              'Feature "Shell": Shell wall thickness exceeds the body.',
            kind: 'build-failed'
          }
        ],
        bodyPresent: true,
        documentMoved: false
      })?.message
    ).toBe('Shell wall thickness exceeds the body.');
  });

  it('accepts a classified builder advisory for this feature', () => {
    const mine = toFeatureId('feat_text');
    const message =
      'Feature "Text": Curves reached the kernel as polylines.';
    expect(
      validatedFeatureRejection({
        featureName: 'Text',
        featureId: mine,
        warnings: [message],
        featureWarnings: [
          {
            featureId: mine,
            featureName: 'Text',
            message,
            kind: 'advisory'
          }
        ],
        bodyPresent: true,
        documentMoved: false
      })
    ).toBeNull();
  });

  it('still reads an unclassified builder warning fail closed', () => {
    expect(
      validatedFeatureRejection({
        featureName: 'Subtract',
        featureId: toFeatureId('feat_sub'),
        warnings: ['Feature "Subtract": Subtract refused: the tools overlap.'],
        featureWarnings: [suppressed],
        bodyPresent: true,
        documentMoved: false
      })?.message
    ).toBe('Subtract refused: the tools overlap.');
  });

  it('does not let one advisory hide a duplicate unclassified failure', () => {
    const mine = toFeatureId('feat_mine');
    const theirs = toFeatureId('feat_theirs');
    const message = 'Feature "Pattern": Rebuild returned invalid geometry.';
    expect(
      validatedFeatureRejection({
        featureName: 'Pattern',
        featureId: mine,
        warnings: [message, message],
        featureWarnings: [
          {
            featureId: theirs,
            featureName: 'Pattern',
            message,
            kind: 'advisory'
          }
        ],
        bodyPresent: true,
        documentMoved: false
      })?.message
    ).toBe('Rebuild returned invalid geometry.');
  });
});
