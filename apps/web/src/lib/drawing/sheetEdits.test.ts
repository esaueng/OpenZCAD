import { describe, expect, it } from 'vitest';
import type {
  DrawingAnnotation,
  DrawingSheet,
  DrawingView,
  DrawingViewId
} from '@openzcad/shared';
import {
  copySheetName,
  deletedSheetSummary,
  deletedViewSummary,
  duplicateDrawingSheet,
  nextSheetName
} from './sheetEdits';

const id = (value: string) => value as DrawingViewId;

function view(viewId: string, extra: Partial<DrawingView> = {}): DrawingView {
  return {
    viewId: id(viewId),
    orientation: 'front',
    bodyIds: [],
    centerMm: { x: 100, y: 100 },
    hiddenLines: true,
    ...extra
  };
}

function dimension(annotationId: string, viewId: string): DrawingAnnotation {
  return {
    kind: 'linear',
    annotationId,
    viewId: id(viewId),
    placementMm: { x: 0, y: 0 }
  } as unknown as DrawingAnnotation;
}

function note(annotationId: string, viewId?: string): DrawingAnnotation {
  return {
    kind: 'note',
    annotationId,
    text: 'Deburr',
    placementMm: { x: 0, y: 0 },
    ...(viewId ? { viewId: id(viewId) } : {})
  } as unknown as DrawingAnnotation;
}

/** Front with a projected Top and a section A-A cut from it. */
function sheet(): DrawingSheet {
  return {
    sheetId: 'sheet_a',
    name: 'Sheet 1',
    views: [
      view('front'),
      view('top', { orientation: 'top', parentViewId: id('front') }),
      view('section', {
        section: { sourceViewId: id('front'), label: 'A', depth: 0 }
      })
    ],
    annotations: [
      dimension('d1', 'front'),
      dimension('d2', 'front'),
      dimension('d3', 'section'),
      dimension('d4', 'top'),
      note('n1', 'section'),
      note('n2')
    ]
  } as unknown as DrawingSheet;
}

const label = (entry: DrawingView) =>
  entry.section
    ? `Section ${entry.section.label}-${entry.section.label}`
    : entry.orientation === 'top'
      ? 'Top'
      : 'Front';

describe('drawing sheet edits (review I62)', () => {
  it('names a new sheet with the next unused number', () => {
    expect(nextSheetName([])).toBe('Sheet 1');
    // Sheet 1 deleted, Sheet 2 left: the next is Sheet 3, not a second 2.
    expect(nextSheetName([{ name: 'Sheet 2' }])).toBe('Sheet 3');
    expect(nextSheetName([{ name: 'Details' }])).toBe('Sheet 2');
    expect(copySheetName('Details', [{ name: 'Details copy' }])).toBe(
      'Details copy 2'
    );
  });

  it('duplicates a sheet with fresh ids that still point at each other', () => {
    let n = 0;
    const original = sheet();
    const copy = duplicateDrawingSheet(original, [original], {
      sheet: () => 'sheet_copy' as DrawingSheet['sheetId'],
      view: () => id(`v${++n}`),
      annotation: () =>
        `a${++n}` as NonNullable<
          DrawingSheet['annotations']
        >[number]['annotationId']
    });
    expect(copy.sheetId).toBe('sheet_copy');
    expect(copy.name).toBe('Sheet 1 copy');
    const [front, top, section] = copy.views;
    expect(front!.viewId).toBe('v1');
    expect(top!.parentViewId).toBe('v1');
    expect(section!.section?.sourceViewId).toBe('v1');
    const ids = new Set(copy.views.map((entry) => entry.viewId));
    for (const annotation of copy.annotations ?? []) {
      expect(annotation.annotationId).toMatch(/^a\d+$/);
      if (annotation.viewId) expect(ids.has(annotation.viewId)).toBe(true);
    }
    // The original is untouched.
    expect(original.views[0]!.viewId).toBe('front');
  });
});

describe('delete notices (review I2)', () => {
  it('names everything a view delete takes with it', () => {
    expect(deletedViewSummary(sheet(), id('front'), label)).toBe(
      'Deleted Front view, Section A-A, 3 dimensions and 1 note.'
    );
    expect(deletedViewSummary(sheet(), id('top'), label)).toBe(
      'Deleted Top view and 1 dimension.'
    );
  });

  it('counts a sheet’s views', () => {
    expect(deletedSheetSummary(sheet())).toBe(
      'Deleted Sheet 1 and its 3 views.'
    );
  });
});
