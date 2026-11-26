import { describe, expect, it, vi } from 'vitest';
import {
  FACE_SWEEP_BLOCKED,
  FACE_SWEEP_UNPROVEN,
  GENERIC_REFUSAL,
  SPLIT_PLANE_MISSES,
  SPLIT_PLANE_ON_EDGE,
  SPLIT_PLANE_ON_FACE,
  plainRefusal,
  stepImportRefusal,
  withFaceSweepReading
} from './refusalLanguage';

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
  it('reads a typed variable-blend refusal as the not-yet sentence of its category', () => {
    const text =
      'Variable-radius fillet could not be created on 1 selected edge. edges-not-blended: blend: 1 of the edges named were not blended';
    // Untyped, this was the generic "could not build" line; typed
    // `unsupported` (exact-variable-blends.ts), it says what the kernel
    // cannot do yet. The kernel's own words stay in the detail.
    const plain = plainRefusal(text, {
      category: 'unsupported',
      code: 'edges-not-blended'
    });
    expect(plain.message).toBe(
      'The exact kernel does not support this combination of shapes yet.'
    );
    expect(plain.detail ?? '').toContain('edges-not-blended');
    expect(plainRefusal(text).message).toBe(
      'The exact kernel could not build this result.'
    );
  });

  it('says which fillets removal and resize cannot rebuild yet, by code', () => {
    const text =
      'unsupported-support-pair: resize blend: unsupported analytic support pair: plane x cone';
    const plain = plainRefusal(text, {
      category: 'unsupported',
      code: 'unsupported-support-pair'
    });
    expect(plain.message).toMatch(/can't rebuild yet/);
    expect(plain.message).not.toMatch(/plane x cone|support-pair/);
    expect(plain.detail).toBe(text);
    // A too-large radius keeps its own, more specific sentence.
    expect(
      plainRefusal(
        'radius-too-large: resize blend: radius 30 mm does not fit on the recovered sharp feature',
        { category: 'invalid_input', code: 'radius-too-large' }
      ).message
    ).toBe(
      'That radius is too large for the faces this blend joins. Try a smaller radius.'
    );
  });

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

  // esaueng/remus#1747 adds the cause; the pinned kernel sends none.
  it.each([
    [
      undefined,
      'That diameter does not fit the existing supports and fillets. Try a smaller diameter.'
    ],
    [
      'wall_meets_face',
      'That diameter does not fit the existing supports and fillets. Try a smaller diameter.'
    ],
    [
      'group_reblend_failed',
      "The fillets around this wall can't be rebuilt at that diameter. Change or remove those fillets in History, then resize the wall."
    ]
  ])('words a refused diameter by its typed cause (%s)', (reason, sentence) => {
    // As the adapter writes it: its sentence, then the kernel's.
    const raw = `${sentence}\nblend cluster: diameter 60 mm cannot be built`;
    expect(
      plainRefusal(raw, {
        category: 'internal',
        code: 'cylinder-diameter-unbuildable',
        ...(reason ? { reason } : {})
      })
    ).toEqual({
      message: sentence,
      headline: sentence,
      // The kernel's words stay behind "Why?".
      detail: raw,
      category: 'internal',
      code: 'cylinder-diameter-unbuildable'
    });
  });

  it('does not advise a smaller diameter when the fillets cannot re-fillet', () => {
    const plain = plainRefusal('opaque detail', {
      category: 'internal',
      code: 'cylinder-diameter-unbuildable',
      reason: 'group_reblend_failed'
    });
    expect(plain.headline).not.toMatch(/smaller diameter/i);
    expect(plain.message).not.toMatch(/smaller diameter/i);
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
      // Signed like the move (-9), as the adapter's typed refusal says it.
      expect(plainRefusal(captured, { category: 'internal' })).toEqual({
        message:
          'A neighbouring face would shrink to nothing past -6.4. Try a smaller offset.',
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
        'A neighbouring face would shrink to nothing past -6.4. Try a smaller offset.'
      );
      expect(
        plainRefusal(
          captured.replace(
            'would reverse: a move of -9',
            'would collapse: a move of 9'
          )
        ).message
      ).toBe(
        'A neighbouring face would shrink to nothing past 6.4. Try a smaller offset.'
      );
    });

    it('keeps the adapter sentence and the kernel words behind Why', () => {
      const adapter = `A neighbouring face would shrink to nothing past -6.4. Try a smaller offset.\n${captured}`;
      expect(plainRefusal(adapter, { category: 'invalid_topology' })).toEqual({
        message:
          'A neighbouring face would shrink to nothing past -6.4. Try a smaller offset.',
        detail: captured,
        category: 'invalid_topology'
      });
    });
  });
});

/**
 * QA 2026-11-14 finding #18: refusals on zcad.app led with the kernel's own
 * words — "Remus draft refused: …", `corner 139`, `face Some(Id(409))`,
 * `exact_only_unattainable (quality_refused)`, `radius-too-large: resize
 * blend`. The raw strings below are the pinned kernel's wording (read from
 * the Remus binary) with the ids the QA run reported.
 */
describe('kernel refusals named in the 2026-11-14 production QA', () => {
  const KERNEL_NOTATION =
    /Remus|Some\(|Id\(|\b[a-z]+_[a-z_]+\b|\b(?:face|edge|vertex|wire|corner) \d|-too-|not implemented/;

  const cases: Array<[string, string]> = [
    [
      'Remus draft refused: the draft moves a corner of curved face 139; re-trimming a curved neighbour against the taper is not implemented',
      "A face next to this one is curved, and re-trimming a curved face to fit isn't supported yet. Try faces that only meet flat faces."
    ],
    [
      'the chamfer has to rebuild the boundary of face 12, which carries a curved edge; re-trimming a curved boundary against the bevel is not implemented',
      "A face next to this one is curved, and re-trimming a curved face to fit isn't supported yet. Try faces that only meet flat faces."
    ],
    [
      'the cutting plane crosses curved edge 36; trimming a curve to the plane is not implemented here, and a chord across it would not be the same edge',
      "The cutting plane crosses a curved edge, which splitting can't trim yet. Move the plane so it misses fillets and curved edges."
    ],
    [
      "the cutting plane crosses inner wire 0 of face 32; that hole would stop being a hole and become a notch in the face's own boundary, which is not implemented",
      "The cutting plane runs through a hole in a face, which splitting can't handle yet. Move the plane clear of holes and openings."
    ],
    [
      'the cutting plane crosses face 18, whose surface is not planar; the section across it is not a straight edge and is not implemented',
      "The cutting plane crosses a curved face, which splitting can't cut yet. Move the plane so it crosses only flat faces."
    ],
    [
      'the cutting plane contains edge 36 of the solid; splitting along an existing edge has no unambiguous answer',
      'The cutting plane lies exactly along an existing edge. Move the plane slightly off the edge.'
    ],
    [
      // Untyped, the touch names neither an edge nor a face: the kernel
      // words both alike (see the typed Split cases below).
      "the cutting plane does not cross the solid's interior; it only touches the body and contains edge 3 of the solid, so there is nothing to split",
      'The cutting plane only touches the body, along an edge or a face. Slide the plane into the body.'
    ],
    [
      'invalid input: cutting plane does not split the solid (entirely on one side)',
      'The cutting plane does not pass through the body. Move the plane so it cuts through the body.'
    ],
    [
      'Remus solid offset refused: assembly failed: wire loop walk: no unvisited edge from vertex 2685 (40 visited, 3 in loop)',
      'Solid offset could not rebuild this body. It currently works on bodies with flat faces and sharp edges; fillets, shells and curved faces are not supported yet.'
    ],
    [
      'Remus shell refused: shell interference: offset faces 4 and 9 cross',
      'The shell could not be built with this wall thickness. Try a thinner wall or different open faces.'
    ],
    [
      // Issue #1630: no wall thickness helps, so the thickness advice is wrong.
      "Remus shell refused: shell: unsupported configuration: a free loop of the shelled body lies in none of the opened faces' planes, so there is no face that closes it",
      'Shell cannot close this opening yet: the wall it exposes has no flat rim. That happens when two open faces share an edge, or a fillet or other rounded face blends into an open face. A thinner wall will not help. Open faces that do not touch, or suppress the fillet.'
    ],
    [
      'resize blend: exact reconstruction refused: blend-aware planar move requires a prismatic sharp support neighborhood',
      'This face meets a fillet, and a face next to a fillet can only move when the faces around it are flat with sharp edges. Change the size on the original shape in History instead.'
    ],
    [
      'radius-too-large: resize blend: blend radius 25 exceeds the 12 available between its supports',
      'That radius is too large for the faces this blend joins. Try a smaller radius.'
    ],
    [
      // Capitalised, so it used to pass as a product sentence.
      'Offset refused at face Some(Id(409)), edge None',
      'The exact kernel could not build this result.'
    ],
    [
      'Hole refused: exact_only_unattainable (quality_refused)',
      'The exact kernel could not build this result.'
    ],
    [
      'Remus pattern journal rejected: instance 3 names no source face',
      'The exact kernel could not build this result.'
    ]
  ];

  it.each(cases)('puts %j into plain words', (raw, sentence) => {
    const plain = plainRefusal(raw);
    expect(plain).toEqual({ message: sentence, detail: raw });
    expect(plain.message).not.toMatch(KERNEL_NOTATION);
  });

  // M11 slice 1a: a Split whose plane meets no edge across the body. Slice
  // 0's coupon found the miss shown as the generic sentence, and a plane on
  // a face (every Split begun from a face pick, at offset 0) told to move off
  // an edge. The kernel text is the pinned Remus split's.
  describe('a refused Split by plane, by its typed cause', () => {
    const TOUCH =
      "split: unsupported configuration: the cutting plane does not cross the solid's interior; it only touches the body and contains edge 3 of the solid, so there is nothing to split";
    const MISS =
      'invalid input: cutting plane does not split the solid (entirely on one side)';
    const split = (category: string, reason?: string) => ({
      category,
      code: 'split_refused',
      ...(reason ? { reason } : {})
    });

    it.each([
      [MISS, split('invalid_input', 'plane_misses_body'), SPLIT_PLANE_MISSES],
      [TOUCH, split('unsupported', 'plane_on_face'), SPLIT_PLANE_ON_FACE],
      [TOUCH, split('unsupported', 'plane_on_edge'), SPLIT_PLANE_ON_EDGE]
    ])('%j as %o', (raw, typed, sentence) => {
      const plain = plainRefusal(raw, typed);
      expect(plain).toEqual({
        message: sentence,
        detail: raw,
        category: typed.category,
        code: 'split_refused'
      });
      expect(plain.message).not.toMatch(KERNEL_NOTATION);
    });

    it('says a face touch is not an edge, and an edge touch is not a face', () => {
      expect(SPLIT_PLANE_ON_FACE).not.toMatch(/edge/i);
      expect(SPLIT_PLANE_ON_EDGE).not.toMatch(/\bface\b/i);
    });

    it('reads the miss without a cause, and never as the generic sentence', () => {
      expect(plainRefusal(MISS).message).toBe(SPLIT_PLANE_MISSES);
      expect(plainRefusal(MISS, 'invalid_input').message).toBe(
        SPLIT_PLANE_MISSES
      );
      expect(plainRefusal(MISS, split('invalid_input')).message).not.toBe(
        GENERIC_REFUSAL
      );
    });

    it('falls back to the prose table for a cause it has no sentence for', () => {
      expect(
        plainRefusal(TOUCH, split('unsupported', 'some_future_cause')).message
      ).toBe(
        'The cutting plane only touches the body, along an edge or a face. Slide the plane into the body.'
      );
      expect(
        plainRefusal(
          'split: unsupported configuration: the cutting plane crosses curved edge 36; trimming a curve to the plane is not implemented here',
          split('unsupported')
        ).message
      ).toBe(
        "The cutting plane crosses a curved edge, which splitting can't trim yet. Move the plane so it misses fillets and curved edges."
      );
    });

    it('keeps the edge sentence for a plane through the body along an edge', () => {
      expect(
        plainRefusal(
          'split: unsupported configuration: the cutting plane contains edge 36 of the solid; splitting along an existing edge has no unambiguous answer',
          split('unsupported')
        ).message
      ).toBe(SPLIT_PLANE_ON_EDGE);
    });
  });

  it('lets the kernel category speak for a capitalised kernel line', () => {
    expect(
      plainRefusal(
        'Hole refused: exact_only_unattainable (quality_refused)',
        'quality_refused'
      ).message
    ).toBe(
      'The exact kernel could not build this exactly, and an approximate result was declined.'
    );
  });

  it('still names the wrapped operation ahead of the category', () => {
    expect(
      plainRefusal(
        'Remus draft refused: draft angle leaves face 4 without a boundary',
        'unsupported'
      ).message
    ).toBe(
      'The draft could not be built on these faces. Try a smaller angle or fewer faces.'
    );
  });

  it("keeps the STEP importer's own diagnosis of each dropped solid", () => {
    for (const sentence of [
      'Body "Part" imported, but 1 of its 2 STEP solids is not a closed solid and was dropped: solid 1 (5 faces): it is non-manifold — 1 edge is shared by more than two faces.',
      'STEP file contains no closed solids: solid 1 (5 faces): it is non-manifold — 1 edge is shared by more than two faces.',
      // Body names are not escaped, so one may carry its own quotes.
      'Body "Part "A"" imported, but 1 of its 2 STEP solids is not a closed solid and was dropped: solid 1 (5 faces): it is non-manifold — 1 edge is shared by more than two faces.'
    ]) {
      expect(plainRefusal(sentence)).toEqual({ message: sentence });
    }
  });

  it("keeps a face set offset's later-step refusal, which names its face by place", () => {
    const sentence =
      "Offsetting face 2 after the others would change the body's topology. Offset fewer faces, or a smaller distance.";
    expect(plainRefusal(sentence)).toEqual({ message: sentence });
    expect(plainRefusal(sentence, 'topology').message).toBe(sentence);
    // The kernel's own entity numbers still read as kernel text.
    expect(plainRefusal('offsetting face 2 hit edge 7').message).not.toBe(
      'offsetting face 2 hit edge 7'
    );
  });

  it('leaves product sentences with user names and face labels alone', () => {
    for (const sentence of [
      'Subtract refused: "left_bracket" and "Box 2" could not be cut exactly, and an approximate result was declined.',
      'Pick a flat face; Face 18 is curved.',
      // The STEP importer numbers a file's solids for the user to find.
      'STEP file contains no closed solids: solid 1 (5 faces): it is an open shell — 4 of its 12 edges are used by a single face, so it encloses no volume.',
      'Subtract refused: subtracting "Left block" and "Right block" would leave nothing, because the tool covers the whole body. Make the tool smaller or move it so part of the body remains.'
    ]) {
      expect(plainRefusal(sentence)).toEqual({ message: sentence });
    }
  });
});

describe('exact sweep path refusals (M04)', () => {
  it('names neither corner mode as the fix when the path turns back on itself', () => {
    const { message } = plainRefusal(
      'exact sweep path turns back on itself at joint 1'
    );
    expect(message).toContain('neither a mitre nor a round corner');
  });
});

describe('withFaceSweepReading', () => {
  // The kernel's words for a captured refusal on a threaded part, where the
  // moved face cleared the thread that "blocked" it by about 22 mm.
  const kernel =
    'offset: move-face would change topology at face Some(Id(11608)), edge None: swept face reaches nonadjacent face 11744 before completing the move';
  const refusal = { ...plainRefusal(kernel), limit: 4 };

  it('reads a swept-face refusal as the collision sentence', () => {
    expect(plainRefusal(kernel).message).toBe(FACE_SWEEP_BLOCKED);
  });

  it('says the kernel could not prove a path the mesh shows clear, without a limit', () => {
    const reworded = withFaceSweepReading(refusal, () => ({ kind: 'clear' }));
    expect(reworded.message).toBe(FACE_SWEEP_UNPROVEN);
    expect(reworded.message).toBe(
      "The geometry kernel couldn't prove this move is clear of nearby curved faces (such as a thread). Try a smaller step, or make the change before adding the thread."
    );
    // The kernel's own words stay behind it, exactly as recorded.
    expect(reworded.detail).toBe(refusal.detail);
    expect(reworded).not.toHaveProperty('limit');
  });

  it('keeps the collision sentence where the mesh shows an obstruction', () => {
    const estimate =
      'The display mesh suggests another part of the body about 6 mm in front of this face.';
    expect(
      withFaceSweepReading(refusal, () => ({ kind: 'blocked', estimate }))
    ).toEqual({ ...refusal, detail: `${estimate}\n${refusal.detail}` });
    expect(withFaceSweepReading(refusal, () => ({ kind: 'blocked' }))).toBe(
      refusal
    );
  });

  it('keeps the collision sentence when the mesh cannot say', () => {
    expect(withFaceSweepReading(refusal, () => undefined)).toBe(refusal);
    expect(withFaceSweepReading(refusal)).toBe(refusal);
  });

  it('reads the mesh only for the swept-face collision', () => {
    const read = vi.fn(() => ({ kind: 'clear' as const }));
    const other = { message: 'Unsupported adjacent surface.' };
    expect(withFaceSweepReading(other, read)).toBe(other);
    expect(read).not.toHaveBeenCalled();
  });
});
