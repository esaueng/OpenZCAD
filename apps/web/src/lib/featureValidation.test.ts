import { describe, expect, it } from 'vitest';
import { toFeatureId } from '@openzcad/shared';
import {
  splitRefusal,
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

  it('shows the sentence before a newline and keeps the rest as detail', () => {
    expect(
      splitRefusal(
        'This offset was refused and the body left unchanged.\n5 source faces (2 curved) became 80 result faces (0 curved)'
      )
    ).toEqual({
      message: 'This offset was refused and the body left unchanged.',
      detail: '5 source faces (2 curved) became 80 result faces (0 curved)'
    });
    expect(splitRefusal('Radius must be greater than zero.')).toEqual({
      message: 'Radius must be greater than zero.'
    });
    // A trailing newline with nothing after it is not a detail.
    expect(splitRefusal('Nothing more to say.\n  ')).toEqual({
      message: 'Nothing more to say.'
    });
  });

  it('carries kernel detail on a refused feature without putting it in the sentence', () => {
    const rejection = validatedFeatureRejection({
      featureName: 'Deepen bore',
      featureId: toFeatureId('feature_bore'),
      warnings: [
        'Feature "Deepen bore": This offset was refused.\n5 source faces became 80 result faces'
      ],
      featureWarnings: [
        {
          featureId: toFeatureId('feature_bore'),
          featureName: 'Deepen bore',
          message:
            'Feature "Deepen bore": This offset was refused.\n5 source faces became 80 result faces',
          kind: 'refusal'
        }
      ],
      bodyPresent: true,
      documentMoved: false
    });
    expect(rejection).toMatchObject({
      message: 'This offset was refused.',
      detail: '5 source faces became 80 result faces',
      culprit: { featureId: 'feature_bore', featureName: 'Deepen bore' }
    });
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
    expect(validatedFeatureRejection({ ...safe, bodyPresent: false })).toEqual({
      message: 'The operation did not produce its result body.'
    });
    expect(validatedFeatureRejection({ ...safe, documentMoved: true })).toEqual(
      {
        message: 'The document changed while the operation validated.'
      }
    );
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
            message: 'Feature "Shell": Shell wall thickness exceeds the body.',
            kind: 'build-failed'
          }
        ],
        bodyPresent: true,
        documentMoved: false
      })?.message
    ).toBe('Shell wall thickness exceeds the body.');
  });

  it('uses a present provenance channel as the complete gate input', () => {
    // A modern exact rebuild supplies this channel even when it is empty.
    // Display strings stay visible, but an unclassified string is not proof
    // that the kernel refused the feature.
    expect(
      validatedFeatureRejection({
        featureName: 'Subtract',
        featureId: toFeatureId('feat_sub'),
        warnings: ['Feature "Subtract": Subtract refused: the tools overlap.'],
        featureWarnings: [],
        bodyPresent: true,
        documentMoved: false
      })
    ).toBeNull();
  });

  it('accepts a builder advisory and refuses a builder failure', () => {
    const featureId = toFeatureId('feat_text');
    const advisory = {
      featureId,
      featureName: 'Text',
      message:
        'Feature "Text": glyph outlines reached the kernel as polylines.',
      kind: 'advisory' as const
    };
    const refusal = {
      featureId,
      featureName: 'Text',
      message: 'Feature "Text": exact result dropped a requested operand.',
      kind: 'refusal' as const
    };

    expect(
      validatedFeatureRejection({
        featureName: 'Text',
        featureId,
        warnings: [advisory.message],
        featureWarnings: [advisory],
        bodyPresent: true,
        documentMoved: false
      })
    ).toBeNull();
    expect(
      validatedFeatureRejection({
        featureName: 'Text',
        featureId,
        warnings: [advisory.message, refusal.message],
        featureWarnings: [advisory, refusal],
        bodyPresent: true,
        documentMoved: false
      })?.message
    ).toBe('exact result dropped a requested operand.');
  });

  it('keeps an imported-STEP validation warning visible without refusing it', () => {
    const warning =
      'Body "Imported part" imported and rendered, but its STEP solid has ' +
      'Remus B-rep validity issues. Exact edits or booleans involving the ' +
      'affected solid may fail.';
    const warnings = [warning];

    expect(
      validatedFeatureRejection({
        featureName: 'Imported part',
        featureId: toFeatureId('feat_import'),
        warnings,
        featureWarnings: [],
        bodyPresent: true,
        documentMoved: false
      })
    ).toBeNull();
    expect(warnings).toEqual([warning]);
  });
});
