import { describe, expect, it } from 'vitest';
import { plainRefusal } from './refusalLanguage';

describe('plainRefusal', () => {
  it('keeps a sentence the adapter wrote, and its detail', () => {
    expect(
      plainRefusal(
        'Fillet could not be created on 1 selected edge with radius 12. Try a smaller radius.'
      )
    ).toEqual({
      message:
        'Fillet could not be created on 1 selected edge with radius 12. Try a smaller radius.'
    });
    expect(
      plainRefusal(
        'This offset was refused and the body left unchanged.\n5 source faces (2 curved) became 80 result faces (0 curved)'
      )
    ).toEqual({
      message: 'This offset was refused and the body left unchanged.',
      detail: '5 source faces (2 curved) became 80 result faces (0 curved)'
    });
    expect(plainRefusal('Nothing more to say.\n  ')).toEqual({
      message: 'Nothing more to say.'
    });
  });

  it('replaces a kernel diagnostic with a plain sentence and keeps the words', () => {
    const cases: Array<[string, string]> = [
      [
        'exact-only policy: the exact boolean pipeline could not produce this result and the approximate fallback was declined',
        'The exact kernel could not build this result.'
      ],
      [
        'boolean result has degenerate topology (F=0, E=0, V=0)',
        "The resulting body wouldn't be valid."
      ],
      ['non-manifold result', "The resulting body wouldn't be valid."],
      [
        'offset_face: self-intersection trimming failed (3 loops)',
        'The resulting body would intersect itself.'
      ],
      [
        'chamfer setback does not fit: 4 mm on a 2 mm edge',
        'The blend does not fit here. Try a smaller size.'
      ],
      [
        'fillet radius must be positive at all points',
        'The radius must be greater than zero.'
      ],
      [
        'degenerate line edge: length 0',
        'The geometry collapses to nothing at this value.'
      ],
      [
        'face splitting failed: wire 3 has no edges',
        'The exact kernel could not build the result surfaces.'
      ],
      [
        "Edge 7 names face handle 12, which is not among this solid's faces.",
        'The kernel returned inconsistent topology for this body.'
      ],
      [
        'importStep: [object WebAssembly.Exception]',
        'The exact kernel crashed on this operation.'
      ],
      [
        'Through-hole diameter 40 does not fit this body: intersection failed: no overlap.',
        'The hole does not fit this body.'
      ],
      [
        'exact geometry failed',
        'The exact kernel could not build this feature.'
      ]
    ];
    for (const [raw, sentence] of cases) {
      expect(plainRefusal(raw), raw).toEqual({
        message: sentence,
        detail: raw
      });
    }
  });

  it('falls back to a generic sentence for kernel text it has no table entry for', () => {
    expect(plainRefusal('wire 4: edge appears twice')).toEqual({
      message: 'The exact kernel could not build this result.',
      detail: 'wire 4: edge appears twice'
    });
    // The kernel's words join any detail already behind the sentence.
    expect(
      plainRefusal(
        'boolean result has only 0 solids\n2 operand faces, 0 result faces'
      )
    ).toEqual({
      message: "The resulting body wouldn't be valid.",
      detail:
        'boolean result has only 0 solids\n2 operand faces, 0 result faces'
    });
  });

  it('keeps a lost selection and a file parse error verbatim', () => {
    // The card recognises a lost selection by its wording; a parse error
    // names the broken entity, which is what the person fixing the file needs.
    expect(
      plainRefusal('face 3 no longer exists on the rebuilt body; re-pick it.')
    ).toEqual({
      message: 'face 3 no longer exists on the rebuilt body; re-pick it.'
    });
    expect(plainRefusal('parse error: entity #999999 not found')).toEqual({
      message: 'parse error: entity #999999 not found'
    });
  });
});
