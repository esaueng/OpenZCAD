import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { sanitizeStepHeaderPrivacy } from './index';

describe('STEP header privacy sanitization', () => {
  it('preserves complete headers without a FILE_NAME record', () => {
    const input = readFileSync(
      new URL(
        '../../../test/fixtures/step/lemon-torus-band.step',
        import.meta.url
      ),
      'utf8'
    );
    expect(sanitizeStepHeaderPrivacy(input, 'lemon-torus-band.step')).toBe(
      input
    );
    expect(
      sanitizeStepHeaderPrivacy(
        "HEADER;/* FILE_NAME('/private/decoy.step'); */FILE_SCHEMA(('AP214'));ENDSEC;DATA;ENDSEC;",
        'model.step'
      )
    ).toContain("/* FILE_NAME('/private/decoy.step'); */");
  });

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
  it('ignores comment and string decoys and accepts whitespace around the record', () => {
    const input =
      "ISO-10303-21;HEADER;/* FILE_NAME('decoy','',(),(),'','',''); */FILE_DESCRIPTION(('ENDSEC; FILE_NAME(''decoy'')'),'2;1');FILE_NAME /* gap */ ('/private/model.step','',(),(),'','','');ENDSEC;DATA;ENDSEC;";
    const sanitized = sanitizeStepHeaderPrivacy(input, 'model.step');
    expect(sanitized).not.toContain('/private/model.step');
    expect(sanitized).toContain("/* FILE_NAME('decoy'");
    expect(sanitized).toContain("FILE_NAME /* gap */ ('model.step'");
    expect(sanitizeStepHeaderPrivacy(sanitized, 'model.step')).toBe(sanitized);
  });

  it('refuses duplicate records and incomplete comments or strings', () => {
    for (const input of [
      "HEADER;FILE_NAME('a');FILE_NAME('b');ENDSEC;",
      "HEADER;/* FILE_NAME('a');ENDSEC;",
      "HEADER;FILE_NAME('unterminated);ENDSEC;"
    ])
      expect(() => sanitizeStepHeaderPrivacy(input, 'x.step')).toThrow();
  });
});
