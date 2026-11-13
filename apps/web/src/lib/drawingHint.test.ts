import { describe, expect, it } from 'vitest';
import type { DrawingSheetId, ProjectDocument } from '@openzcad/shared';
import { drawingSheetHasViews } from './drawingHint';

const empty = 'sheet_empty' as DrawingSheetId;
const drawn = 'sheet_drawn' as DrawingSheetId;

function documentWith(
  sheets: { sheetId: DrawingSheetId; views: unknown[] }[]
): Pick<ProjectDocument, 'drawings'> {
  return { drawings: { sheets } } as unknown as Pick<
    ProjectDocument,
    'drawings'
  >;
}

describe('drawingSheetHasViews', () => {
  const both = documentWith([
    { sheetId: empty, views: [] },
    { sheetId: drawn, views: [{}] }
  ]);

  it('reads the sheet on screen, not any sheet', () => {
    expect(drawingSheetHasViews(both, empty)).toBe(false);
    expect(drawingSheetHasViews(both, drawn)).toBe(true);
  });

  it('falls back to any sheet until the workspace names one', () => {
    expect(drawingSheetHasViews(both, null)).toBe(true);
    expect(
      drawingSheetHasViews(both, 'sheet_gone' as DrawingSheetId)
    ).toBe(true);
    expect(
      drawingSheetHasViews(documentWith([{ sheetId: empty, views: [] }]), null)
    ).toBe(false);
  });

  it('has no views without a document or sheets', () => {
    expect(drawingSheetHasViews(null, null)).toBe(false);
    expect(drawingSheetHasViews({}, drawn)).toBe(false);
  });
});
