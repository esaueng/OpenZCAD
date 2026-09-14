import { describe, expect, it } from 'vitest';
import type { FeatureWarning } from '@openzcad/shared';
import { presentedDiagnostics } from './diagnosticsRows';

const featureId = 'feat_1' as FeatureWarning['featureId'];

describe('presented diagnostics', () => {
  it('drops suppressed features instead of counting them as warnings', () => {
    const message = 'Feature "Boss": Suppressed; skipped during exact rebuild.';
    expect(
      presentedDiagnostics(
        [message],
        [{ featureId, featureName: 'Boss', message, kind: 'suppressed' }]
      )
    ).toEqual([]);
  });

  it('names the feature and says what a missing target means', () => {
    const [row] = presentedDiagnostics([
      'Feature "Extrude": Stored cut target body_cd3e23ce-8b05-4e17-af93-0054f6e7be09 is unavailable.'
    ]);
    expect(row).toMatchObject({
      featureName: 'Extrude',
      message: 'The body this feature cuts into no longer exists.'
    });
    expect(row?.detail).toContain('body_cd3e23ce');
  });

  it('translates a kernel sentence and keeps it as detail', () => {
    const [row] = presentedDiagnostics([
      'Feature "Subtract": exact-only policy: the exact boolean pipeline could not produce this result and the approximate fallback was declined'
    ]);
    expect(row?.featureName).toBe('Subtract');
    expect(row?.message).toBe('The exact kernel could not build this result.');
    expect(row?.detail).toContain('exact-only policy');
  });

  it('scrubs internal ids out of adapter sentences without losing the sentence', () => {
    const [row] = presentedDiagnostics([
      'Feature "Sketch 02": Face sketch cannot attach because source body body_0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b is unavailable at the sketch\'s history position.'
    ]);
    expect(row?.message).toBe(
      "Face sketch cannot attach because source body is unavailable at the sketch's history position."
    );
  });

  it('passes a plain adapter sentence through untouched', () => {
    const text =
      'Feature "Union": Union does not fill empty space. The selected solids form 2 disconnected groups.';
    const [row] = presentedDiagnostics([text]);
    expect(row).toEqual({
      key: text,
      featureName: 'Union',
      message:
        'Union does not fill empty space. The selected solids form 2 disconnected groups.'
    });
  });
});

describe('presented diagnostics carry the kernel category', () => {
  const message =
    'Feature "Weld": exact-only policy: the exact boolean pipeline could ' +
    'not produce this result';

  it('classifies a row from the rebuild record, not from its words', () => {
    const [row] = presentedDiagnostics(
      [message],
      [
        {
          featureId,
          featureName: 'Weld',
          message,
          kind: 'build-failed',
          kernelRefusal: {
            family: 'boolean',
            operation: 'fuse',
            category: 'quality_refused',
            code: 'exact_only_unattainable'
          }
        }
      ]
    );
    expect(row).toMatchObject({
      featureName: 'Weld',
      category: 'quality_refused'
    });
  });

  it('leaves an uncategorised row uncategorised', () => {
    const [row] = presentedDiagnostics(
      [message],
      [{ featureId, featureName: 'Weld', message, kind: 'build-failed' }]
    );
    expect(row?.category).toBeUndefined();
  });

  /**
   * A resource limit and an unsupported domain are different stories, and the
   * row now tells them apart from the same kernel sentence.
   */
  it('gives two categories two sentences for one kernel sentence', () => {
    const rowFor = (category: string) =>
      presentedDiagnostics(
        [message],
        [
          {
            featureId,
            featureName: 'Weld',
            message,
            kind: 'build-failed',
            kernelRefusal: { family: 'boolean', category, code: 'c' }
          }
        ]
      )[0]!;
    expect(rowFor('resource_limit').message).not.toBe(
      rowFor('unsupported').message
    );
  });
});
