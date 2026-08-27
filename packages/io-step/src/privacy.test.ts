import { describe, expect, it } from 'vitest';

import { sanitizeStepHeaderPrivacy } from './index';

describe('STEP header privacy sanitization', () => {
  it('replaces a private FILE_NAME path without changing DATA records', () => {
    const input = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_NAME('/Users/alice/private/model','2026',('alice'),(''),'', '', '');",
      'ENDSEC;',
      'DATA;',
      "#1=PRODUCT('Hammer','',(),());",
      'ENDSEC;',
      'END-ISO-10303-21;'
    ].join('\n');

    const sanitized = sanitizeStepHeaderPrivacy(input, 'Hammer Holder.step');

    expect(sanitized).toContain("FILE_NAME('Hammer Holder.step'");
    expect(sanitized).not.toContain('/Users/alice');
    expect(sanitized.slice(sanitized.indexOf('DATA;'))).toBe(
      input.slice(input.indexOf('DATA;'))
    );
  });

  it('handles escaped apostrophes and rejects incomplete headers', () => {
    const input =
      "ISO-10303-21;\nHEADER;\nFILE_NAME('Alice''s/path', '', (), (), '', '', '');\nENDSEC;\nDATA;\nENDSEC;";
    expect(
      sanitizeStepHeaderPrivacy(input, "/Users/alice/owner's.step")
    ).toContain("FILE_NAME('owner''s.step'");
    expect(() => sanitizeStepHeaderPrivacy('DATA;\nENDSEC;', 'x.step')).toThrow(
      'complete HEADER'
    );
  });
});
