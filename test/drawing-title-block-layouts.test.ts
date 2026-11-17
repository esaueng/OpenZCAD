import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  assertStorableDocument,
  createProjectDocument,
  updateDrawingSheet
} from '@openzcad/document-core';
import {
  DRAWING_TITLE_BLOCK_SHOP_FIELDS,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  drawingSetError,
  toUserId,
  type DrawingSheet,
  type DrawingSheetId
} from '@openzcad/shared';
import {
  SHOP_TITLE_BLOCK_HEIGHT_MM,
  TITLE_BLOCK_HEIGHT_MM,
  composeSheetPage,
  sheetViewArea,
  titleBlockBox
} from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';

/**
 * D02 title-block layouts (schema v94): the compact block, unchanged, and a
 * shop block that adds the material, finish, who checked and approved the
 * drawing, the company and a general-tolerance note.
 */

const sheetId = 'dsht_title' as DrawingSheetId;

function sheetOf(extra: Partial<DrawingSheet> = {}): DrawingSheet {
  return {
    sheetId,
    name: 'Bracket',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {
      drawingNumber: 'BR-104',
      material: '6061-T6 aluminium',
      finish: 'Clear anodise',
      checkedBy: 'R. Ito',
      approvedBy: 'M. Okafor',
      company: 'Northside Machining',
      tolerances: 'UNLESS STATED ±0.1 mm, ±0.5°'
    },
    source: { fingerprint: 'test' },
    views: [],
    ...extra
  };
}

const context = { projectName: 'Bracket', units: 'mm' as const };

describe('title-block layouts', () => {
  it('validates the layout and the shop fields', () => {
    expect(drawingSetError({ sheets: [sheetOf()] })).toBeNull();
    expect(
      drawingSetError({ sheets: [sheetOf({ titleBlockLayout: 'shop' })] })
    ).toBeNull();
    expect(
      drawingSetError({
        sheets: [
          sheetOf({
            titleBlockLayout: 'iso' as DrawingSheet['titleBlockLayout']
          })
        ]
      })
    ).toMatch(/unknown title-block layout/);
    expect(
      drawingSetError({
        sheets: [sheetOf({ titleBlock: { material: 'x'.repeat(121) } })]
      })
    ).toMatch(/invalid title-block field "material"/);
    expect(DRAWING_TITLE_BLOCK_SHOP_FIELDS).toEqual([
      'company',
      'material',
      'finish',
      'checkedBy',
      'approvedBy',
      'tolerances'
    ]);
  });

  it('keeps the compact block as it was, shop fields stored but not printed', () => {
    const compact = sheetOf();
    expect(titleBlockBox(compact).height).toBe(TITLE_BLOCK_HEIGHT_MM);
    const page = composeSheetPage(compact, [], context);
    const text = page.texts.map((entry) => entry.text);
    expect(text).toContain('DWG NO.');
    expect(text).toContain('DRAWN');
    expect(text).not.toContain('MATERIAL');
    expect(text).not.toContain('6061-T6 aluminium');
    // The same page as a sheet with no shop fields at all.
    const plain = composeSheetPage(
      sheetOf({ titleBlock: { drawingNumber: 'BR-104' } }),
      [],
      context
    );
    expect(page).toEqual(plain);
  });

  it('prints the shop block taller, with every shop field', () => {
    const shop = sheetOf({ titleBlockLayout: 'shop' });
    const box = titleBlockBox(shop);
    expect(box.height).toBe(SHOP_TITLE_BLOCK_HEIGHT_MM);
    // Views fit above it.
    expect(sheetViewArea(shop).y).toBe(box.y + box.height);
    expect(sheetViewArea(shop).height).toBe(
      sheetViewArea(sheetOf()).height -
        (SHOP_TITLE_BLOCK_HEIGHT_MM - TITLE_BLOCK_HEIGHT_MM)
    );
    const page = composeSheetPage(shop, [], context);
    const text = page.texts.map((entry) => entry.text);
    for (const label of [
      'MATERIAL',
      'FINISH',
      'CHECKED',
      'APPROVED',
      'COMPANY',
      'GENERAL TOLERANCES',
      'DWG NO.',
      'PROJECTION'
    ])
      expect(text).toContain(label);
    for (const value of [
      '6061-T6 aluminium',
      'Clear anodise',
      'R. Ito',
      'M. Okafor',
      'Northside Machining',
      'UNLESS STATED ±0.1 mm, ±0.5°'
    ])
      expect(text).toContain(value);
    // A rule under the title and between each of its four rows.
    const rules = page.strokes.filter(
      (stroke) =>
        stroke.kind === 'thin' &&
        stroke.points.length === 4 &&
        stroke.points[0] === box.x &&
        stroke.points[2] === box.x + box.width
    );
    expect(rules.map((rule) => rule.points[1])).toEqual([
      box.y + 40,
      box.y + 30,
      box.y + 20,
      box.y + 10
    ]);
    // Both writers carry the note.
    expect(sheetPageToSvg(page, 'Bracket')).toContain(
      '>UNLESS STATED ±0.1 mm, ±0.5°</text>'
    );
    expect(
      new TextDecoder('latin1').decode(sheetPageToPdf(page, 'Bracket'))
    ).toContain('(6061-T6 aluminium) Tj');
  });

  it('switches layouts and edits shop fields, gated at v94', () => {
    const manager = new CommandManager(
      createProjectDocument('Bracket', toUserId('test'))
    );
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheetOf({ titleBlock: {} })
      })
    );
    const shop = updateDrawingSheet(manager.document, {
      sheetId,
      titleBlockLayout: 'shop',
      titleBlock: { material: ' Brass C360 ' }
    });
    const stored = shop.drawings!.sheets[0]!;
    expect(stored.titleBlockLayout).toBe('shop');
    expect(stored.titleBlock.material).toBe('Brass C360');
    expect(() => assertStorableDocument(shop)).not.toThrow();
    expect(() =>
      assertStorableDocument({
        ...shop,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION - 1
      })
    ).toThrow(/Title-block layouts require project schema v94/);
    const compact = updateDrawingSheet(shop, {
      sheetId,
      titleBlockLayout: null,
      titleBlock: { material: '' }
    });
    expect('titleBlockLayout' in compact.drawings!.sheets[0]!).toBe(false);
    expect(compact.drawings!.sheets[0]!.titleBlock.material).toBeUndefined();
  });
});
