import { describe, expect, it, vi } from 'vitest';
import { toBodyId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  describeSectionOutline,
  resolveSectionOutline,
  sectionOutlineExportable,
  sectionOutlineFromReport,
  writeSectionDxf
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

function region(bodyId: string, area: number) {
  return {
    bodyId,
    area,
    loops: [{ kind: 'outer' as const, points: [[0, 0, 3] as const] }],
    positions: new Float32Array([0, 0, 3]),
    indices: new Uint32Array([0])
  };
}

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
      document,
      plane,
      visible
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

  it('writes the DXF of the same bodies the section was cut from', async () => {
    const exportModel = vi.fn(async () => ({ text: '0\r\nEOF\r\n' }));
    const save = vi.fn(async () => true);
    const announced: string[] = [];
    const visible: BodyId[] = [toBodyId('body_a')];

    await writeSectionDxf(
      { exportModel } as never,
      document,
      plane,
      visible,
      save,
      'part',
      (message) => announced.push(message)
    );

    expect(exportModel).toHaveBeenCalledWith('dxf', document, visible, {
      section: { origin: [0, 0, 3], normal: [0, 0, 1] }
    });
    expect(save).toHaveBeenCalledWith('part-section.dxf', 'dxf', '0\r\nEOF\r\n');
    expect(announced.at(-1)).toBe('Exported the XY section to part-section.dxf.');
  });

  it('reports a worker failure instead of throwing at the viewport', async () => {
    const sectionOutline = vi.fn(async () => {
      throw new Error('Geometry worker is unavailable.');
    });
    const state = await resolveSectionOutline(
      { sectionOutline },
      document,
      plane,
      []
    );
    expect(state).toEqual({
      kind: 'refused',
      detail: 'Geometry worker is unavailable.'
    });
  });
});

describe('what the section rail may offer to export', () => {
  const missed = {
    bodyId: 'body_b',
    reason: 'plane-misses-body',
    message: 'The section plane does not pass through this body.'
  };
  const mismatch = {
    bodyId: 'body_b',
    reason: 'area-mismatch',
    message: "The kernel's cross-section area (720.8013) disagrees…"
  };

  it('counts a plane that misses a body apart from one it cannot section', () => {
    const state = sectionOutlineFromReport(
      report([region('body_a', 540)], [missed, mismatch])
    );
    expect(state).toMatchObject({ kind: 'exact', missed: 1, unsectioned: 1 });
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
