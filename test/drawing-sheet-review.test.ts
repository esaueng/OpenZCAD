import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands,
  replayCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  composeSheetPage,
  freeViewCenter,
  nextViewOrientation,
  sheetViewArea,
  titleBlockSheetText,
  type ViewExtent
} from '../apps/web/src/lib/drawing/sheetPage';
import {
  movedSheets,
  sheetOrderSteps
} from '../apps/web/src/lib/drawing/sheetEdits';

/**
 * Design review 2026-11-13, Draw: sheets reorder in one undo step with the
 * sheet commands every client already replays (I62); the title block's SHEET cell says where the sheet sits in the set
 * and its name, not the paper size (I63); "Add view" offers an orientation
 * the sheet lacks and places a free view clear of the others (I65).
 */
function boxDocument(): ProjectDocument {
  return addPrimitiveFeature(createProjectDocument('Bracket', toUserId('t')), {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 6 }
  });
}

function sheet(name: string, bodyId: BodyId): DrawingSheet {
  return {
    sheetId: `dsht_${name.replace(/\W/g, '').toLowerCase()}` as DrawingSheetId,
    name,
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: [
      {
        viewId: `dvw_${name.replace(/\W/g, '').toLowerCase()}` as DrawingViewId,
        orientation: 'front',
        bodyIds: [bodyId],
        centerMm: { x: 100, y: 100 },
        hiddenLines: true
      }
    ]
  };
}

describe('drawing sheet order (review I62)', () => {
  it('moves a sheet with the sheet commands every client replays, as one undo step', () => {
    const initial = boxDocument();
    const body = initial.bodyOrder[0]!;
    const manager = new CommandManager(initial);
    for (const name of ['Sheet 1', 'Sheet 2', 'Sheet 3'])
      manager.execute(
        commandFactories.addDrawingSheet({ sheet: sheet(name, body) })
      );
    const sheets = () => manager.document.drawings!.sheets;
    const names = () => sheets().map((entry) => entry.name);
    const move = (sheetId: DrawingSheetId, index: number) => {
      const next = movedSheets(sheets(), sheetId, index);
      if (!next) return false;
      const { remove, add } = sheetOrderSteps(sheets(), next);
      manager.execute(
        composeCommands('Move sheet', [
          ...remove.map((id) =>
            commandFactories.deleteDrawingSheet({ sheetId: id })
          ),
          ...add.map((entry) =>
            commandFactories.addDrawingSheet({ sheet: entry })
          )
        ])
      );
      return true;
    };
    const [first, , third] = sheets().map((entry) => entry.sheetId);
    const before = structuredClone(sheets());

    expect(move(third!, 0)).toBe(true);
    expect(names()).toEqual(['Sheet 3', 'Sheet 1', 'Sheet 2']);
    // Moved, not rebuilt: every sheet is the one it was.
    expect([...sheets()].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      before
    );
    // Clamped to the list; already there is no edit.
    expect(move(first!, 99)).toBe(true);
    expect(names()).toEqual(['Sheet 3', 'Sheet 2', 'Sheet 1']);
    expect(move(first!, 2)).toBe(false);
    expect(move(first!, Number.NaN)).toBe(false);

    // Replaying the log, as an older client would, gives the same order: no
    // new command field, so no schema bump.
    expect(
      replayCommands(initial, manager.document.commandLog).drawings
    ).toEqual(manager.document.drawings);
    manager.undo();
    expect(names()).toEqual(['Sheet 3', 'Sheet 1', 'Sheet 2']);
  });

  it('takes out only the sheets from the first position that changes', () => {
    const a = { sheetId: 'a' } as DrawingSheet;
    const b = { sheetId: 'b' } as DrawingSheet;
    const c = { sheetId: 'c' } as DrawingSheet;
    const copy = { sheetId: 'b2' } as DrawingSheet;
    expect(sheetOrderSteps([a, b, c], [a, c, b])).toEqual({
      remove: ['b', 'c'],
      add: [c, b]
    });
    // A duplicate placed beside its original.
    expect(sheetOrderSteps([a, b, c], [a, b, copy, c])).toEqual({
      remove: ['c'],
      add: [copy, c]
    });
    expect(sheetOrderSteps([a, b], [a, b])).toEqual({ remove: [], add: [] });
  });
});

describe('title block SHEET cell (review I63)', () => {
  it('prints the place in the set and the name, not the paper size', () => {
    expect(
      titleBlockSheetText({ name: 'Details' }, { index: 2, count: 3 })
    ).toBe('2 / 3 · Details');
    expect(titleBlockSheetText({ name: 'Sheet 1' }, undefined)).toBe(
      '1 / 1 · Sheet 1'
    );
    const page = composeSheetPage(sheet('Details', 'body_x' as BodyId), [], {
      projectName: 'Bracket',
      units: 'mm',
      sheetNumber: { index: 2, count: 3 }
    });
    const texts = page.texts.map((text) => text.text);
    expect(texts).toContain('SHEET');
    expect(texts).toContain('2 / 3 · Details');
    expect(texts).not.toContain('A3');
  });
});

describe('Add view defaults (review I65)', () => {
  const body = 'body_x' as BodyId;
  it('offers the first orientation the sheet does not show', () => {
    const base = sheet('Sheet 1', body);
    expect(nextViewOrientation({ views: [] })).toBe('front');
    expect(nextViewOrientation(base)).toBe('top');
    const views = (['front', 'top', 'right', 'left'] as const).map(
      (orientation, index) => ({
        ...base.views[0]!,
        viewId: `dvw_${index}` as DrawingViewId,
        orientation
      })
    );
    expect(nextViewOrientation({ views })).toBe('bottom');
    // A section shows a cut, not its orientation's view.
    expect(
      nextViewOrientation({
        views: [
          {
            ...base.views[0]!,
            section: {
              sourceViewId: 'dvw_src' as DrawingViewId,
              label: 'A'
            }
          } as DrawingSheet['views'][number]
        ]
      })
    ).toBe('front');
  });

  it('places a view in the free space nearest the middle, clear of the rest', () => {
    const empty = { ...sheet('Sheet 1', body), views: [] };
    const area = sheetViewArea(empty);
    const middle = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
    const size = { width: 60, height: 40 };
    expect(freeViewCenter(empty, new Map(), 'mm', size)).toEqual(middle);

    // A 100 × 80 mm view sits on the middle: the new one goes beside it,
    // clear by the gap, and stays inside the view area.
    const occupied = sheet('Sheet 1', body);
    occupied.views[0]!.centerMm = middle;
    const extent: ViewExtent = { minU: 0, minV: 0, maxU: 100, maxV: 80 };
    const extents = new Map([[occupied.views[0]!.viewId, extent]]);
    const at = freeViewCenter(occupied, extents, 'mm', size);
    const apart =
      Math.abs(at.x - middle.x) >= 50 + 30 + 10 - 1e-9 ||
      Math.abs(at.y - middle.y) >= 40 + 20 + 10 - 1e-9;
    expect(apart).toBe(true);
    expect(at.x - 30).toBeGreaterThanOrEqual(area.x);
    expect(at.x + 30).toBeLessThanOrEqual(area.x + area.width);
    expect(at.y - 20).toBeGreaterThanOrEqual(area.y);
    expect(at.y + 20).toBeLessThanOrEqual(area.y + area.height);
    // Deterministic: the same sheet places the same way.
    expect(freeViewCenter(occupied, extents, 'mm', size)).toEqual(at);

    // Larger than the view area: the middle, as before.
    expect(
      freeViewCenter(occupied, extents, 'mm', { width: 2000, height: 10 })
    ).toEqual(middle);
  });
});
