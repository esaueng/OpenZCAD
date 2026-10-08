import { describe, expect, it } from 'vitest';
import { parseInlineSpans, parseRichText } from './richText';

describe('assistant rich text emphasis', () => {
  it('leaves snake_case parameter names and arithmetic as plain text', () => {
    const line =
      'Set hole_inset to 10 and plate_length to 80, then plate_width - 2*hole_inset gives 2*3*4 = 24.';
    expect(parseInlineSpans(line)).toEqual([{ text: line }]);
  });

  it('still reads real *emphasis* and _emphasis_', () => {
    expect(parseInlineSpans('a *thin* plate and a _thick_ one')).toEqual([
      { text: 'a ' },
      { text: 'thin', italic: true },
      { text: ' plate and a ' },
      { text: 'thick', italic: true },
      { text: ' one' }
    ]);
    expect(parseInlineSpans('*Note:* keep it')).toEqual([
      { text: 'Note:', italic: true },
      { text: ' keep it' }
    ]);
  });

  it('does not italicise up to the next star from an unclosed bold', () => {
    expect(parseInlineSpans('**bold then 2*3 = 6')).toEqual([
      { text: '**bold then 2*3 = 6' }
    ]);
  });
});

describe('assistant rich text numbered lists', () => {
  it('keeps a loose list (blank lines between items) as one list', () => {
    expect(
      parseRichText('1. Sketch the plate\n\n2. Draw the holes\n\n3. Cut them')
    ).toEqual([
      {
        kind: 'list',
        ordered: true,
        items: [
          [{ text: 'Sketch the plate' }],
          [{ text: 'Draw the holes' }],
          [{ text: 'Cut them' }]
        ]
      }
    ]);
  });

  it('keeps the source number of a list that does not start at 1', () => {
    expect(
      parseRichText('First:\n\n1. Sketch\n\nThen:\n\n2. Draw\n3. Cut')
    ).toEqual([
      { kind: 'paragraph', spans: [{ text: 'First:' }] },
      { kind: 'list', ordered: true, items: [[{ text: 'Sketch' }]] },
      { kind: 'paragraph', spans: [{ text: 'Then:' }] },
      {
        kind: 'list',
        ordered: true,
        start: 2,
        items: [[{ text: 'Draw' }], [{ text: 'Cut' }]]
      }
    ]);
  });

  it('still ends a list at a paragraph and at a change of list kind', () => {
    expect(parseRichText('- a\n\n1. b\n\nafter')).toEqual([
      { kind: 'list', ordered: false, items: [[{ text: 'a' }]] },
      { kind: 'list', ordered: true, items: [[{ text: 'b' }]] },
      { kind: 'paragraph', spans: [{ text: 'after' }] }
    ]);
  });
});
