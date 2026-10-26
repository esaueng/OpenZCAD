import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * MERGE GUARD for the privacy policy page (ADR-024, Delivery phases row 0).
 *
 * `public/privacy.html` marks anything still to be supplied with a
 * placeholder in square brackets and capitals, such as `[EFFECTIVE DATE]`.
 * This test FAILS while any placeholder remains, and passes once the last
 * one is filled in, so the page cannot ship half written. See
 * docs/legal/privacy-policy.md for what is left. Do not skip or weaken it:
 * fill in the page instead.
 */
const PLACEHOLDER = /\[[A-Z0-9][A-Z0-9\s,.'’:;/&()-]*[A-Z)]\]/g;

/** Each placeholder once, with any line wrapping inside it folded. */
function unfilledPlaceholders(source: string): string[] {
  return Array.from(
    new Set(
      (source.match(PLACEHOLDER) ?? []).map((found) =>
        found.replace(/\s+/g, ' ')
      )
    )
  );
}

describe('privacy policy placeholders', () => {
  it('recognises the placeholder form and nothing else', () => {
    expect(
      unfilledPlaceholders(
        'Run by [OPERATOR LEGAL NAME]. Since [EFFECTIVE DATE]. Under [MINIMUM AGE]. [A] [x] [1] array[0] [Effective date]'
      )
    ).toEqual(['[OPERATOR LEGAL NAME]', '[EFFECTIVE DATE]', '[MINIMUM AGE]']);
    // A formatter may wrap a long placeholder across lines; it still counts.
    expect(
      unfilledPlaceholders(
        'see [REPRESENTATIVE OR DATA\n        PROTECTION OFFICER]'
      )
    ).toEqual(['[REPRESENTATIVE OR DATA PROTECTION OFFICER]']);
    expect(unfilledPlaceholders('Effective 26 October 2026')).toEqual([]);
  });

  it('FILL IN BEFORE MERGE: public/privacy.html has no [PLACEHOLDER] left', () => {
    const html = readFileSync(
      resolve(__dirname, '../../public/privacy.html'),
      'utf8'
    );
    const remaining = unfilledPlaceholders(html);
    expect(
      remaining,
      `The privacy policy still has ${remaining.length} unfilled placeholder(s). ` +
        'Replace each before this page is published ' +
        '(docs/legal/privacy-policy.md):\n  ' +
        remaining.join('\n  ')
    ).toEqual([]);
  });
});
