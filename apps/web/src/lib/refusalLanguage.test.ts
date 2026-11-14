import { describe, expect, it } from 'vitest';
import { plainRefusal, stepImportRefusal } from './refusalLanguage';

describe('stepImportRefusal', () => {
  it('offers a fresh export while retaining the complete STEP parser diagnostic', () => {
    const raw =
      'parse error: entity #999999 not found\nReferenced by ADVANCED_FACE #42.';
    expect(stepImportRefusal(raw)).toEqual({
      message:
        'This STEP file could not be read. Export a fresh STEP file from the source CAD project and try again.',
      detail: raw
    });
  });

  it('leaves other import and kernel refusals unchanged', () => {
    for (const raw of [
      'The source file contains no solid bodies.',
      'Error: unsupported STEP entity: OFFSET_SURFACE',
      'exact-only policy: the exact boolean pipeline could not produce this result',
      'glTF binary import failed: parse error: not a GLB file'
    ]) {
      expect(stepImportRefusal(raw)).toEqual({ message: raw });
    }
  });
});

describe('plainRefusal', () => {
  it('explains a typed blend-group diameter limit without parsing prose', () => {
    expect(
      plainRefusal('opaque detail', {
        category: 'nonconvergence',
        code: 'cylinder-diameter-unbuildable'
      }).message
    ).toBe(
      'That diameter does not fit the existing supports and fillets. Try a smaller diameter.'
    );
  });
  it.each(['__proto__', 'constructor', 'toString'])(
    'falls back for a category named "%s"',
    (category) => {
      // A raw kernel sentence, so the category sentence is consulted.
      const plain = plainRefusal('boolean operation failed', category);
      expect(typeof plain.message).toBe('string');
      expect(plain.message.length).toBeGreaterThan(0);
    }
  );

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
      ],
      [
        // The demo bracket's plate top pushed past the boss above it.
        'offset: move-face would change topology at face Some(Id(338)), edge None: swept face reaches nonadjacent face 340 before completing the move',
        'The face would run into another part of the body before it got that far.'
      ],
      [
        'offset: move-face would change topology: conical cap reaches or crosses its support apex',
        'The conical end would collapse at that distance. Try a smaller offset.'
      ],
      [
        'resize blend: radial resize intersects nonincident meridian boundaries 2 and 7',
        'That diameter would make parts of the body overlap.'
      ],
      [
        'resize blend: radial resize reverses a meridian segment',
        'That diameter would collapse a wall or blend. Try a smaller change.'
      ],
      [
        'resize blend: radial resize collapses a torus ring',
        'That diameter would collapse a wall or blend. Try a smaller change.'
      ],
      [
        // A boss grown out of a sphere (2026-11-05 resize report).
        'offset: move-face does not support face Id(18) (sphere): face is adjacent to selected move boundary edge 80',
        "This face meets a curved surface that resizing and moving faces can't follow yet. Change the size on the original shape in History instead."
      ],
      [
        // The same boss once its seam with the sphere is filleted.
        'offset: move-face does not support face Id(50) (nurbs): face is adjacent to selected move boundary edge 350',
        "This face meets a fillet or freeform surface, which resizing and moving faces can't follow yet."
      ],
      [
        // A blind bore cut into the same sphere.
        'offset: move-face does not support face Id(22) (cylinder): partial-cylinder resize currently requires an outward quarter wall with radial planar sides',
        "This hole's wall doesn't end in full circles, which resizing can't follow yet. Change the size on the original shape in History instead."
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

  /**
   * A refused face move the kernel typed is read from its code and cause.
   * The prose here matches no table entry, so the sentence can only have come
   * from the record (Remus #1550, `resizeCylindricalFaceDetailed`).
   */
  it('names a typed face-move refusal from its code and cause', () => {
    const raw = 'an opaque kernel sentence';
    const typed = (reason: string, neighborSurfaceType?: string) => ({
      category: 'unsupported',
      code: 'unsupported_move_face',
      reason,
      ...(neighborSurfaceType ? { neighborSurfaceType } : {})
    });
    const cases: ReadonlyArray<[ReturnType<typeof typed>, string]> = [
      [
        typed('unsupported_neighbor', 'sphere'),
        "This face meets a curved surface that resizing and moving faces can't follow yet. Change the size on the original shape in History instead."
      ],
      [
        typed('unsupported_neighbor', 'nurbs'),
        "This face meets a fillet or freeform surface, which resizing and moving faces can't follow yet."
      ],
      [
        typed('partial_reversed_wall'),
        "This hole's wall doesn't end in full circles, which resizing can't follow yet. Change the size on the original shape in History instead."
      ]
    ];
    for (const [record, sentence] of cases) {
      expect(plainRefusal(raw, record), record.reason).toEqual({
        message: sentence,
        detail: raw,
        category: 'unsupported',
        code: 'unsupported_move_face'
      });
    }
    // A cause with no sentence of its own falls back to the category.
    expect(plainRefusal(raw, typed('unclassified')).message).toBe(
      'The exact kernel does not support this combination of shapes yet.'
    );
  });
});

describe('exact-only typed refusals', () => {
  it('explains an approximate reblend refusal before generic raw-text matching', () => {
    const raw = 'exact-only policy: approximate fallback was declined';
    expect(
      plainRefusal(raw, {
        category: 'quality_refused',
        code: 'exact_only_unattainable',
        reason: 'approximate_reblend_not_permitted'
      })
    ).toEqual({
      message:
        'Resizing this face would require an approximate fillet. This edit only allows exact geometry.',
      detail: raw,
      category: 'quality_refused',
      code: 'exact_only_unattainable'
    });
  });
  it('explains exact quality refusal without inventing a fillet cause', () => {
    const raw = 'exact-only policy: exact result unavailable';
    expect(
      plainRefusal(raw, {
        category: 'quality_refused',
        code: 'exact_only_unattainable'
      }).message
    ).toBe(
      'The exact kernel could not build this exactly, and an approximate result was declined.'
    );
  });

  describe('a face move that would collapse a neighbouring face', () => {
    // Captured from Remus on the pin: the Front face of a 27 × 24 × 16 block
    // whose right-hand vertical edges are rounded r8.8 (see
    // test/parity/offset-face-fillet-limit.spec.ts), pushed in 9.
    const captured =
      'resize blend: exact reconstruction refused: remove/rebuild failed (resize blend: exact reconstruction refused: blend region has unsupported support surfaces ["torus", "torus", "plane", "cylinder", "cylinder", "plane", "plane", "plane"]; expected all planes or one supported analytic pair); exact prismatic blend translation failed (offset: move-face would change topology at face None, edge Some(Id(8)): line edge 8 with one moving end would reverse: a move of -9 against a fixed-to-moving extent of 6.400000000000002)';

    it('names the limit instead of an internal failure', () => {
      expect(plainRefusal(captured, { category: 'internal' })).toEqual({
        message:
          'A neighbouring face would shrink to nothing past 6.4. Try a smaller offset.',
        detail: captured,
        category: 'internal'
      });
    });

    it('reads the collapse wording the same way', () => {
      expect(
        plainRefusal(
          captured.replace(
            'would reverse: a move of -9',
            'would collapse: a move of -6.4'
          )
        ).message
      ).toBe(
        'A neighbouring face would shrink to nothing past 6.4. Try a smaller offset.'
      );
    });

    it('keeps the adapter sentence and the kernel words behind Why', () => {
      const adapter = `A neighbouring face would shrink to nothing past 6.4. Try a smaller offset.\n${captured}`;
      expect(plainRefusal(adapter, { category: 'invalid_topology' })).toEqual({
        message:
          'A neighbouring face would shrink to nothing past 6.4. Try a smaller offset.',
        detail: captured,
        category: 'invalid_topology'
      });
    });
  });
});
