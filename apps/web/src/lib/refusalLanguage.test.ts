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

  it('reports unsupported STEP types without mistaking their names for invalid geometry', () => {
    for (const entity of ['DEGENERATE_TOROIDAL_SURFACE', 'OFFSET_SURFACE']) {
      const raw = `Error: unsupported STEP entity: ${entity}`;
      expect(
        plainRefusal(`${raw}\nImport stopped before committing the body.`)
      ).toEqual({
        message:
          'This STEP file uses a geometry type the importer does not support yet.',
        detail: `${raw}\nImport stopped before committing the body.`
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

/**
 * Before the typed seam, every kernel-written sentence with no table entry
 * collapsed into one line whatever the engine's reason was: a domain it does
 * not support, a budget it exceeded and geometry it refused on quality all
 * read identically. The category the rebuild now records tells them apart.
 */
describe('plainRefusal with the kernel category', () => {
  const raw = 'wire 4: edge appears twice';

  it('tells three refusals apart that used to read the same', () => {
    expect(plainRefusal(raw).message).toBe(
      'The exact kernel could not build this result.'
    );
    expect(plainRefusal(raw, 'unsupported').message).toBe(
      'The exact kernel does not support this combination of shapes yet.'
    );
    expect(plainRefusal(raw, 'resource_limit').message).toBe(
      "This operation went past the exact kernel's budget for this kind of work."
    );
    expect(plainRefusal(raw, 'quality_refused').message).toBe(
      'The exact kernel could not build this exactly, and an approximate ' +
        'result was declined.'
    );
  });

  it('answers for every category the kernel can report', () => {
    for (const category of [
      'invalid_input',
      'invalid_topology',
      'unsupported',
      'nonconvergence',
      'resource_limit',
      'tolerance_violation',
      'quality_refused',
      'cancelled',
      'internal'
    ]) {
      const { message } = plainRefusal(raw, category);
      expect(message, category).not.toBe(
        'The exact kernel could not build this result.'
      );
      expect(message.endsWith('.'), category).toBe(true);
    }
  });

  it('falls back exactly as before for a category it does not know', () => {
    expect(plainRefusal(raw, 'a_future_kernel_category')).toEqual({
      message: 'The exact kernel could not build this result.',
      detail: raw,
      category: 'a_future_kernel_category'
    });
  });

  /**
   * A symptom the table names is more specific than any category, so the
   * hand-written sentence still wins. The category rides along regardless, so
   * a caller can branch on it whichever sentence was chosen.
   */
  it('keeps the hand-written sentence for a symptom it recognises', () => {
    expect(plainRefusal('radius must be positive', 'invalid_input')).toEqual({
      message: 'The radius must be greater than zero.',
      detail: 'radius must be positive',
      category: 'invalid_input'
    });
  });

  /** An adapter-written sentence is already plain and stays untouched. */
  it('leaves a product sentence alone and still carries the category', () => {
    const sentence =
      'Union refused: "Plate" could not be combined exactly, and an ' +
      'approximate result was declined.';
    expect(
      plainRefusal(
        `${sentence}\nKernel refusal exact_only_unattainable (quality_refused): …`,
        'quality_refused'
      )
    ).toEqual({
      message: sentence,
      detail: 'Kernel refusal exact_only_unattainable (quality_refused): …',
      category: 'quality_refused'
    });
  });
});
