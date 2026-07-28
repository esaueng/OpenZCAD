import { describe, expect, it } from 'vitest';
import { directEditRejection } from './directEdit';

const safe = {
  label: 'Offset Face',
  warnings: [] as string[],
  bodyPresent: true,
  documentMoved: false
};

describe('a clean rebuild commits', () => {
  it('returns no rejection when every check passes', () => {
    expect(directEditRejection(safe)).toBeNull();
  });

  it('ignores warnings belonging to other features', () => {
    expect(
      directEditRejection({
        ...safe,
        warnings: ['Feature "Fillet edges": radius too large']
      })
    ).toBeNull();
  });
});

describe('the kernel warning wins', () => {
  it('surfaces the warning with its feature prefix stripped', () => {
    expect(
      directEditRejection({
        ...safe,
        warnings: ['Feature "Offset Face": push/pull produced no material']
      })
    ).toBe('push/pull produced no material');
  });

  it('is preferred over the generic checks, being more specific', () => {
    expect(
      directEditRejection({
        ...safe,
        warnings: ['Feature "Offset Face": self-intersecting result'],
        bodyPresent: false,
        documentMoved: true
      })
    ).toBe('self-intersecting result');
  });

  it('matches a label containing regex metacharacters literally', () => {
    expect(
      directEditRejection({
        ...safe,
        label: 'Resize (bore)',
        warnings: ['Feature "Resize (bore)": radius must be positive']
      })
    ).toBe('radius must be positive');
  });
});

describe('generic rejections', () => {
  it('rejects an edit whose target body did not survive the rebuild', () => {
    expect(directEditRejection({ ...safe, bodyPresent: false })).toBe(
      'Direct edit did not produce the selected body.'
    );
  });

  it('rejects an edit whose document moved while it validated', () => {
    expect(directEditRejection({ ...safe, documentMoved: true })).toBe(
      'The document changed while the edit was validating.'
    );
  });

  it('reports the missing body ahead of the stale document', () => {
    // A missing body says the edit was wrong; a moved document only says it
    // was late, so the more informative failure is reported.
    expect(
      directEditRejection({
        ...safe,
        bodyPresent: false,
        documentMoved: true
      })
    ).toBe('Direct edit did not produce the selected body.');
  });
});
