import { describe, expect, it } from 'vitest';
import { toFeatureId } from '@openzcad/shared';
import {
  PreviewRefusalError,
  refusingWarningDetail,
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
  it('preserves a typed diameter refusal across preview failure', () => {
    const diagnostic = validatedFeatureRejection({
      ...safe,
      featureWarnings: [
        {
          kind: 'refusal',
          featureId: toFeatureId('resize'),
          featureName: safe.featureName,
          message: 'opaque diagnostic',
          kernelRefusal: {
            family: 'direct-edit',
            category: 'unsupported',
            code: 'cylinder-diameter-unbuildable'
          }
        }
      ]
    })!;
    const failure = new PreviewRefusalError(diagnostic);
    expect(failure.diagnostic.headline).toContain('smaller diameter');
    expect(failure.diagnostic.detail).toBe('opaque diagnostic');
  });
  it.each([
    [undefined, 'Try a smaller diameter.'],
    ['wall_meets_face', 'Try a smaller diameter.'],
    [
      'group_reblend_failed',
      'Change or remove those fillets in History, then resize the wall.'
    ]
  ])(
    'carries the kernel cause of a diameter refusal to the card (%s)',
    (reason, advice) => {
      const diagnostic = validatedFeatureRejection({
        ...safe,
        featureWarnings: [
          {
            kind: 'refusal',
            featureId: toFeatureId('resize'),
            featureName: safe.featureName,
            message: 'opaque diagnostic',
            kernelRefusal: {
              family: 'direct-edit',
              operation: 'resize-cylindrical-face',
              category: 'internal',
              code: 'cylinder-diameter-unbuildable',
              ...(reason ? { reason } : {})
            }
          }
        ]
      })!;
      expect(diagnostic.headline).toContain(advice);
      expect(diagnostic.message).toContain(advice);
      expect(diagnostic.detail).toBe('opaque diagnostic');
    }
  );
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

  it('names the later feature an edit strands, not "this feature"', () => {
    // QA 2026-11-14 #8: a Box edit refused because a later Fillet lost its
    // edges, and the Box's card read "re-create this feature".
    const fillet = toFeatureId('feat_fillet');
    const message =
      'Feature "Fillet 2": A selected edge no longer exists. Re-select the edges and re-create this feature.';
    const input = {
      featureName: 'Fillet 2',
      featureId: fillet,
      warnings: [message],
      featureWarnings: [
        {
          featureId: fillet,
          featureName: 'Fillet 2',
          message,
          kind: 'build-failed' as const,
          kernelRefusal: {
            family: 'reference' as const,
            category: 'invalid_input' as const,
            code: 'reference_missing'
          }
        }
      ],
      bodyPresent: true,
      documentMoved: false
    };
    const dependent = validatedFeatureRejection({ ...input, dependent: true });
    expect(dependent?.message).toBe(
      '“Fillet 2” can no longer find an edge or face it was applied to after this change. Edit “Fillet 2” and pick them again, or try a smaller change.'
    );
    expect(dependent?.detail).toBe(
      'A selected edge no longer exists. Re-select the edges and re-create this feature.'
    );
    expect(dependent?.code).toBe('reference_missing');
    expect(dependent?.culprit).toEqual({
      featureId: fillet,
      featureName: 'Fillet 2',
      dependent: true
    });
    // On the stranded feature's own card, "this feature" is that feature.
    expect(validatedFeatureRejection(input)?.message).toBe(
      'A selected edge no longer exists. Re-select the edges and re-create this feature.'
    );
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
      })
    ).toMatchObject({
      // The builder's own words lead only when a person wrote them; a
      // kernel-style sentence is put plainly and kept as detail.
      message: 'The exact kernel could not build this result.',
      detail: 'exact result dropped a requested operand.'
    });
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

// An untyped warning (a committed document's, whose typed records were not
// kept) names its feature only by the `Feature "<name>":` lead. It belongs to
// a feature only when that lead is the feature's name and no other's; an
// ambiguous one stays a document-level warning instead of a guessed blame.
describe('an untyped warning names its feature exactly', () => {
  const fillet10 = 'Feature "Fillet 10": Fillet radius is too large.';

  it('does not give "Fillet 10"\'s warning to "Fillet 1"', () => {
    const roster = ['Fillet 1', 'Fillet 10'];
    expect(warningForFeature('Fillet 1', [fillet10], roster)).toBeNull();
    expect(warningForFeature('Fillet 1', [fillet10])).toBeNull();
    expect(warningForFeature('Fillet 10', [fillet10], roster)).toBe(
      'Fillet radius is too large.'
    );
    expect(
      refusingWarningDetail(
        'Fillet 1',
        [fillet10],
        undefined,
        undefined,
        roster
      )
    ).toBeNull();
  });

  it('leaves a warning unattributed when a rename gives two features its name', () => {
    // "Fillet 10" renamed to "Fillet 1": the lead fits both now.
    const warning = 'Feature "Fillet 1": Fillet radius is too large.';
    const roster = ['Fillet 1', 'Fillet 1'];
    expect(warningForFeature('Fillet 1', [warning], roster)).toBeNull();
    expect(
      refusingWarningDetail('Fillet 1', [warning], undefined, undefined, roster)
    ).toBeNull();
  });

  it("does not let a name that is a prefix of another's lead take its warning", () => {
    // "Rough" is renamed from something else; the other feature's name
    // holds `": `, so its lead starts with Rough's.
    const roster = ['Rough', 'Rough": Chamfer'];
    const theirs = 'Feature "Rough": Chamfer": Chamfer could not be created.';
    expect(warningForFeature('Rough', [theirs], roster)).toBeNull();
    // The lead fits both names, so neither is blamed for it.
    expect(warningForFeature('Rough": Chamfer', [theirs], roster)).toBeNull();
    // A lead only Rough's name fits is still Rough's.
    const own = 'Feature "Rough": Box could not be created.';
    expect(warningForFeature('Rough', [theirs, own], roster)).toBe(
      'Box could not be created.'
    );
  });

  it('still prefers the typed record, by feature id', () => {
    const id = toFeatureId('feat_fillet_1');
    const message = 'Feature "Fillet 1": Fillet radius is too large.';
    expect(
      refusingWarningDetail(
        'Fillet 1',
        [message],
        [
          {
            featureId: id,
            featureName: 'Fillet 1',
            kind: 'build-failed',
            message
          }
        ],
        id,
        ['Fillet 1', 'Fillet 1']
      )?.reason
    ).toBe('Fillet radius is too large.');
  });
});

// Review of #2405: a feature name holding quotes was not stripped, so the
// name's own "with distance 2" took the refused size's unit.
describe('the refusing warning without its feature name', () => {
  it.each([
    'Chamfer with distance 2 "Nominal"',
    'Edge 4 mm with radius 3 mm',
    '"Quoted": name'
  ])('strips %j as the known name', (name) => {
    const sentence =
      'Chamfer could not be created on 1 selected edge with distance 1.5. Try a smaller distance: distance 0.985 builds here.';
    expect(
      refusingWarningDetail(
        name,
        [],
        [
          {
            featureId: toFeatureId('feat_named'),
            featureName: name,
            kind: 'build-failed',
            message: `Feature "${name}": ${sentence}`
          }
        ],
        toFeatureId('feat_named')
      )?.reason
    ).toBe(sentence);
  });
});

// Preview check of #2405: a Box edit that broke a downstream chamfer was
// refused with "0.5" and "0.395" and no unit, in the editor and on
// History's "Edit not saved" card, where Needs repair and Resume had them.
describe('a rejected edit in the document unit', () => {
  const sentence =
    'Chamfer could not be created on 1 selected edge with distance 0.5. Try a smaller distance: distance 0.395 builds here.';
  const reject = (name: string, unit: string | null) =>
    validatedFeatureRejection({
      featureName: name,
      featureId: toFeatureId('feat_chamfer'),
      dependent: true,
      warnings: [`Feature "${name}": ${sentence}`],
      featureWarnings: [
        {
          featureId: toFeatureId('feat_chamfer'),
          featureName: name,
          kind: 'build-failed',
          message: `Feature "${name}": ${sentence}`
        }
      ],
      bodyPresent: true,
      documentMoved: false,
      unit
    });

  it.each(['mm', 'in'])('writes %s after both sizes', (unit) => {
    expect(reject('Chamfer 1', unit)?.message).toBe(
      `Chamfer could not be created on 1 selected edge with distance 0.5 ${unit}. Try a smaller distance: distance 0.395 ${unit} builds here.`
    );
  });

  it('writes them after the refused sizes, not in a name that reads like the refusal', () => {
    expect(
      reject(
        'Rough": Chamfer could not be created on 1 selected edge with distance 2.',
        'mm'
      )?.message
    ).toBe(
      'Chamfer could not be created on 1 selected edge with distance 0.5 mm. Try a smaller distance: distance 0.395 mm builds here.'
    );
  });

  it('leaves sizes bare without a unit', () => {
    expect(reject('Chamfer 1', null)?.message).toBe(sentence);
  });
});
