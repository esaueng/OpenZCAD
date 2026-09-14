import { describe, expect, it, vi } from 'vitest';
import {
  toBodyId,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import {
  describeSectionOutline,
  resolveSectionOutline,
  sectionOutlineExportable,
  sectionOutlineFor,
  sectionOutlineFromReport,
  sectionSourceOf,
  writeSectionDxf,
  type ViewportGeometry,
  type ViewportStandIn
} from './sectionOutline';

/**
 * The section rail has two jobs beyond drawing: it says which of the two
 * section pipelines is on screen, and it decides whether there is a drawing
 * to export. Both have been wrong in ways only this layer can be held to —
 * a section of bodies the viewport is not showing, and a live export button
 * for a section the exporter refuses.
 */

const plane = { plane: 'XY' as const, offset: 3 };
const document = { version: 7 } as unknown as ProjectDocument;

/**
 * What the viewport is drawing, the way the workspace builds it. Every
 * question about a section is asked of this and only this — there is no
 * overload that takes a document and a body list a caller paired up itself,
 * because pairing them up itself is how the section came to describe a
 * model nobody was looking at.
 */
function onScreen<S extends ViewportStandIn>(
  drawn: ProjectDocument | null,
  bodyIds: readonly BodyId[],
  standIns: S[] | null = null
): ViewportGeometry<S> {
  return {
    document: drawn,
    bodies: bodyIds.map((bodyId) => ({ bodyId }) as BodyRepresentation),
    standIns
  };
}

function region(bodyId: string, area: number) {
  return {
    bodyId,
    area,
    loops: [{ kind: 'outer' as const, points: [[0, 0, 3] as const] }],
    positions: new Float32Array([0, 0, 3]),
    indices: new Uint32Array([0])
  };
}

/** The one state the drawing may be written from. */
const exportable = sectionOutlineFromReport({
  plane: { origin: [0, 0, 3], normal: [0, 0, 1] },
  regions: [region('body_a', 540)],
  refusals: []
} as unknown as Parameters<typeof sectionOutlineFromReport>[0]);

const report = (
  regions: ReturnType<typeof region>[],
  refusals: { bodyId: string; reason: string; message: string }[] = []
) =>
  ({
    plane: { origin: [0, 0, 3], normal: [0, 0, 1] },
    regions,
    refusals
  }) as unknown as Parameters<typeof sectionOutlineFromReport>[0];

describe('the exact section asks about the bodies on screen', () => {
  it('sends the caller\'s visible body list to the kernel', async () => {
    const sectionOutline = vi.fn(async () => report([region('body_a', 540)]));
    const visible: BodyId[] = [toBodyId('body_a')];

    const state = await resolveSectionOutline(
      { sectionOutline },
      onScreen(document, visible),
      plane
    );

    // Not "every body in the document": hiding and isolating never reach the
    // document, so a body the user hid would otherwise be sectioned, drawn
    // floating in empty space, and counted into the area.
    expect(sectionOutline).toHaveBeenCalledWith(
      document,
      { origin: [0, 0, 3], normal: [0, 0, 1] },
      visible
    );
    expect(state.kind).toBe('exact');
    expect(state.kind === 'exact' && state.area).toBe(540);
  });

  it('asks about the document those bodies came from, never another one', async () => {
    // The mismatch this exists to prevent: the viewport is drawing a preview
    // document, so the visible list names a body only the preview has. Sent
    // with the LIVE document, the adapter has no geometry for it. The pair
    // is one value, so there is no call site that can split them.
    const sectionOutline = vi.fn(async () =>
      report([region('body_preview_only', 120)])
    );
    const previewDocument = { version: 8 } as unknown as ProjectDocument;
    const previewBodies: BodyId[] = [toBodyId('body_preview_only')];

    await resolveSectionOutline(
      { sectionOutline },
      onScreen(previewDocument, previewBodies),
      plane
    );

    expect(sectionOutline).toHaveBeenCalledWith(
      previewDocument,
      { origin: [0, 0, 3], normal: [0, 0, 1] },
      previewBodies
    );
    expect(sectionOutline).not.toHaveBeenCalledWith(
      document,
      expect.anything(),
      expect.anything()
    );
  });

  it('asks nothing at all before a document is open', async () => {
    const sectionOutline = vi.fn(async () => report([]));
    const state = await resolveSectionOutline(
      { sectionOutline },
      onScreen(null, []),
      plane
    );
    expect(sectionOutline).not.toHaveBeenCalled();
    expect(state).toEqual({ kind: 'clipping' });
  });

  it('writes the DXF of the same bodies the section was cut from', async () => {
    const exportModel = vi.fn(async () => ({ text: '0\r\nEOF\r\n' }));
    const save = vi.fn(async () => true);
    const announced: string[] = [];
    const visible: BodyId[] = [toBodyId('body_a')];

    await writeSectionDxf(
      { exportModel } as never,
      onScreen(document, visible),
      plane,
      exportable,
      save,
      'part',
      (message: string) => announced.push(message)
    );

    expect(exportModel).toHaveBeenCalledWith('dxf', document, visible, {
      section: { origin: [0, 0, 3], normal: [0, 0, 1] }
    });
    expect(save).toHaveBeenCalledWith('part-section.dxf', 'dxf', '0\r\nEOF\r\n');
    expect(announced.at(-1)).toBe('Exported the XY section to part-section.dxf.');
  });

  it('writes nothing for a section the exporter would refuse', async () => {
    // The DXF button is shut in this state, so reaching the exporter means
    // a call that did not come from it — a keyboard shortcut, a future menu
    // item. The gate lives with the export, not only on the button.
    const exportModel = vi.fn(async () => ({ text: '0\r\nEOF\r\n' }));
    const save = vi.fn(async () => true);
    const announced: string[] = [];

    await writeSectionDxf(
      { exportModel } as never,
      onScreen(document, [toBodyId('body_a')]),
      plane,
      sectionOutlineFromReport(
        report(
          [region('body_a', 540)],
          [
            {
              bodyId: 'body_b',
              reason: 'area-mismatch',
              message: "The kernel's cross-section area disagrees…"
            }
          ]
        )
      ),
      save,
      'part',
      (message: string) => announced.push(message)
    );

    expect(exportModel).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    // And it says nothing: no "Exporting…" for an export that never began.
    expect(announced).toEqual([]);
  });

  it('reports a worker failure instead of throwing at the viewport', async () => {
    const sectionOutline = vi.fn(async () => {
      throw new Error('Geometry worker is unavailable.');
    });
    const state = await resolveSectionOutline(
      { sectionOutline },
      onScreen(document, []),
      plane
    );
    expect(state).toEqual({
      kind: 'refused',
      detail: 'Geometry worker is unavailable.'
    });
  });
});

/**
 * The viewport draws a document's exact bodies until something is being
 * tried out, and then it draws an approximation over them and hides the
 * bodies underneath. A section of the document while that is up describes
 * geometry that is no longer on screen — the cut curves float beside a part
 * of a different size, the rail calls the old area exact, and the DXF button
 * writes a drawing of a model the user is not looking at.
 *
 * That happened twice for two different reasons, which is why the rule here
 * is about stand-ins in general and never about any one of them.
 */
describe('a section is of the drawing, not of the document behind it', () => {
  /** What a parameter edit nobody has applied puts on screen. */
  const parameterPreview = [
    {
      bodyId: toBodyId('body_a_preview'),
      replaces: [toBodyId('body_a')],
      color: '#8ab4f8',
      parts: []
    }
  ];

  it('has nothing to section while a parameter edit nobody applied is drawn', () => {
    const view = onScreen(document, [toBodyId('body_a')], parameterPreview);

    // The body is still listed — it is what the preview stands in FOR — but
    // there is no document to section it out of, because the shape on screen
    // is not the shape this document builds.
    expect(sectionSourceOf(view)).toEqual({
      document: null,
      bodyIds: [toBodyId('body_a')]
    });
  });

  it('asks the kernel nothing while that preview is up', async () => {
    const sectionOutline = vi.fn(async () => report([region('body_a', 200)]));

    const state = await resolveSectionOutline(
      { sectionOutline },
      onScreen(document, [toBodyId('body_a')], parameterPreview),
      plane
    );

    expect(sectionOutline).not.toHaveBeenCalled();
    // Back to the honest half of the section view: the clipped preview.
    expect(state).toEqual({ kind: 'clipping' });
    expect(sectionOutlineExportable(state)).toBe(false);
  });

  it('writes no DXF of the document a preview is standing in front of', async () => {
    // The reported defect end to end: an exact section is on screen and
    // exportable, and the user types a new parameter value without applying
    // it. The drawing that button would write is of the old geometry.
    const exportModel = vi.fn(async () => ({ text: '0\r\nEOF\r\n' }));
    const save = vi.fn(async () => true);
    const announced: string[] = [];

    await writeSectionDxf(
      { exportModel } as never,
      onScreen(document, [toBodyId('body_a')], parameterPreview),
      plane,
      exportable,
      save,
      'part',
      (message: string) => announced.push(message)
    );

    expect(exportModel).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(announced).toEqual([]);
  });

  it('refuses a stand-in it has never heard of', async () => {
    // The next one. It is not the parameter preview, it does not replace a
    // body — it adds geometry the document never built — and this file
    // learns nothing about it. Being drawn is the whole test: reaching the
    // viewport means reaching it through ViewportGeometry, and a section is
    // derived from that same value, so the refusal is structural.
    const somethingNew = [
      { kind: 'simulation-ghost', replaces: [] as BodyId[], frames: 12 }
    ];
    const sectionOutline = vi.fn(async () => report([region('body_a', 200)]));
    const view = onScreen(document, [toBodyId('body_a')], somethingNew);

    expect(sectionSourceOf(view).document).toBeNull();
    expect(
      await resolveSectionOutline({ sectionOutline }, view, plane)
    ).toEqual({ kind: 'clipping' });
    expect(sectionOutline).not.toHaveBeenCalled();
  });

  it('takes the drawn section down with the geometry it described', () => {
    // The half of this the request path cannot fix: a section computed and
    // drawn a moment ago, still in state, while a parameter edit arrives and
    // hides the body it was cut from. Its curves would keep rendering beside
    // a preview of a different size, and the rail would keep calling the old
    // area exact. Not shown at all — back to the clipped preview.
    const bodies = [toBodyId('body_a')];
    expect(
      sectionOutlineFor(onScreen(document, bodies, parameterPreview), exportable)
    ).toEqual({ kind: 'clipping' });
    expect(
      sectionOutlineFor(
        onScreen(document, bodies, [
          { kind: 'simulation-ghost', replaces: [] as BodyId[] }
        ]),
        exportable
      )
    ).toEqual({ kind: 'clipping' });
    // And with nothing standing in, it is shown exactly as computed.
    expect(sectionOutlineFor(onScreen(document, bodies), exportable)).toBe(
      exportable
    );
  });

  it('sections the drawing again the moment the stand-in comes down', async () => {
    // Cancelling the edit is not a special case either: the same rule that
    // refused reads the same value and finds nothing standing in.
    const sectionOutline = vi.fn(async () => report([region('body_a', 200)]));
    const bodies = [toBodyId('body_a')];

    for (const standIns of [null, []]) {
      sectionOutline.mockClear();
      const state = await resolveSectionOutline(
        { sectionOutline },
        onScreen(document, bodies, standIns),
        plane
      );
      expect(sectionOutline).toHaveBeenCalledWith(
        document,
        { origin: [0, 0, 3], normal: [0, 0, 1] },
        bodies
      );
      expect(state.kind).toBe('exact');
    }
  });
});

describe('what the section rail may offer to export', () => {
  // Two DIFFERENT bodies: the kernel reports per solid, so two refusals
  // against one id would be one body in two states, which is the case the
  // body-granular counting below is about.
  const missed = {
    bodyId: 'body_b',
    reason: 'plane-misses-body',
    message: 'The section plane does not pass through this body.'
  };
  const mismatch = {
    bodyId: 'body_c',
    reason: 'area-mismatch',
    message: "The kernel's cross-section area (720.8013) disagrees…"
  };

  it('counts a plane that misses a body apart from one it cannot section', () => {
    const state = sectionOutlineFromReport(
      report([region('body_a', 540)], [missed, mismatch])
    );
    expect(state).toMatchObject({ kind: 'exact', missed: 1, unsectioned: 1 });
  });

  it('counts bodies, not the kernel\'s per-solid outcomes', () => {
    // One imported body holding two solids, the plane through one of them.
    // The kernel answers per solid, so the same body appears as a region
    // AND as a refusal. Counting refusals told the user "1 body is not cut
    // here" while pointing at that body's own cross-section.
    const state = sectionOutlineFromReport(
      report(
        [region('body_import', 100)],
        [
          {
            bodyId: 'body_import',
            reason: 'plane-misses-body',
            message: 'The section plane does not pass through this body.'
          }
        ]
      )
    );
    expect(state).toMatchObject({ kind: 'exact', missed: 0, unsectioned: 0 });
    expect(sectionOutlineExportable(state)).toBe(true);
    expect(describeSectionOutline(state, 'mm').detail).toBe(
      '100.00 mm² of material'
    );
  });

  it('counts a body with two kinds of refusal once, as unsectioned', () => {
    // Three solids under one body: one missed, one refused, none cut. The
    // drawing is what decides — a body with material the exporter cannot
    // write is unsectioned, never "not cut here".
    const state = sectionOutlineFromReport(
      report(
        [region('body_a', 540)],
        [
          { ...missed, bodyId: 'body_multi' },
          { ...mismatch, bodyId: 'body_multi' }
        ]
      )
    );
    expect(state).toMatchObject({ kind: 'exact', missed: 0, unsectioned: 1 });
    expect(sectionOutlineExportable(state)).toBe(false);
  });

  it('shuts the export for a body the document has no geometry for', () => {
    // The adapter refuses a body id its build never made rather than losing
    // the whole section to a throw. It is not the plane missing, so the
    // drawing is off: `exportSectionDxf` fails closed on the same body.
    const state = sectionOutlineFromReport(
      report(
        [region('body_a', 540)],
        [
          {
            bodyId: 'body_preview_only',
            reason: 'unknown-body',
            message: 'Body body_preview_only has no exact geometry in this model.'
          }
        ]
      )
    );
    expect(state).toMatchObject({ kind: 'exact', missed: 0, unsectioned: 1 });
    expect(sectionOutlineExportable(state)).toBe(false);
  });

  it('offers the export when the only refusal is a plane that missed', () => {
    const state = sectionOutlineFromReport(
      report([region('body_a', 540)], [missed])
    );
    expect(sectionOutlineExportable(state)).toBe(true);
    expect(describeSectionOutline(state, 'mm').detail).toBe(
      '540.00 mm² of material, 1 body is not cut here'
    );
  });

  it('refuses the export when a body the plane cuts has no exact section', () => {
    // `exportSectionDxf` throws on this state rather than leaving the body's
    // material out of the drawing, so the button must not offer it: the user
    // would get a raw kernel diagnostic and no file.
    const state = sectionOutlineFromReport(
      report([region('body_a', 540)], [mismatch])
    );
    expect(sectionOutlineExportable(state)).toBe(false);
    expect(describeSectionOutline(state, 'mm').detail).toBe(
      '540.00 mm² of material, 1 body has no exact section, so there is no drawing to export'
    );
  });

  it('never offers the export for a preview, a pending cut, or a refusal', () => {
    expect(sectionOutlineExportable({ kind: 'clipping' })).toBe(false);
    expect(sectionOutlineExportable({ kind: 'computing' })).toBe(false);
    expect(
      sectionOutlineExportable({ kind: 'refused', detail: 'no cut' })
    ).toBe(false);
  });

  it('is a refusal, not an empty section, when nothing was cut', () => {
    expect(sectionOutlineFromReport(report([], [missed]))).toEqual({
      kind: 'refused',
      detail: 'The section plane does not pass through this body.'
    });
  });
});
