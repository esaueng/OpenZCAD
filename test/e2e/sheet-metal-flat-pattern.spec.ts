import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  sheetMetalBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  expectBodyCount
} from './openzcad-fixtures';

/**
 * M16 slice 4: a sheet-metal L bracket (the spec's 96.5239 blank, one 90°
 * up bend) opens in the flat-pattern view from File, shows its bend table,
 * and downloads a DXF with the outline on layer 0 and the bend on BEND_UP.
 */
test(
  'a sheet-metal bracket opens its flat pattern and downloads the layered DXF',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });

    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Flat bracket', toUserId('user_e2e')),
      {
        name: 'Blank',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          {
            objectKind: 'rectangle',
            width: 96.5239,
            height: 40,
            centerX: 96.5239 / 2,
            centerY: 20
          },
          {
            objectKind: 'line',
            x1: 48.262,
            y1: 0,
            x2: 48.262,
            y2: 40,
            construction: true
          }
        ]
      }
    );
    const [rectangleId, lineId] = findSketch(withSketch, sketchId)!.objectIds;
    const { document } = sheetMetalBody(withSketch, {
      name: 'Bracket',
      sketchId,
      profiles: [{ all: true, sourceEntityIds: [rectangleId!] }],
      thickness: 2,
      bendRadius: 2,
      kFactor: 0.44,
      relief: { shape: 'none' },
      bends: [
        {
          id: 'b1',
          line: { sketchId, objectId: lineId! },
          angleDeg: 90,
          direction: 'up'
        }
      ]
    });

    await page.goto('/');
    await expect(page).toHaveTitle(/OpenZCAD/);
    await page.getByRole('button', { name: 'Import project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'bracket.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document,
          files: []
        })
      )
    });
    await expectBodyCount(page, 1);

    const menu = page.locator('details.file-menu');
    await menu.locator('summary').click();
    await menu.getByRole('button', { name: /Flat pattern…/ }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Flat pattern — Bracket'
    });
    await expect(dialog).toBeVisible();
    const table = dialog.getByRole('table', { name: 'Bend table' });
    await expect(table).toBeVisible({ timeout: 60_000 });
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr td').nth(1)).toHaveText('Up');
    await expect(table.locator('tbody tr td').nth(2)).toHaveText('90');
    await expect(dialog).toContainText('96.524 × 40 mm');
    await expect(dialog.getByRole('note')).toHaveCount(0);
    await testInfo.attach('flat-pattern-dialog', {
      body: await dialog.screenshot({
        path: testInfo.outputPath('flat-pattern-dialog.png')
      }),
      contentType: 'image/png'
    });

    const pending = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export DXF' }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('Flat-bracket-Bracket-flat.dxf');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const dxf = Buffer.concat(chunks).toString('utf8');
    const lines = dxf.split('\r\n');
    const layerOf = (entity: string) =>
      lines.flatMap((line, index) =>
        line === entity && lines[index + 1]?.trim() === '8'
          ? [lines[index + 2]]
          : []
      );
    expect(layerOf('LINE').sort()).toEqual(['0', '0', '0', '0', 'BEND_UP']);
    expect(layerOf('TEXT')).toEqual(['BEND_NOTES']);
    expect(dxf).toContain('UP 90\\U+00B0 R2');
    expect(dxf).toContain('$INSUNITS\r\n 70\r\n4'.replace(' 70', '70'));
    await expect(dialog.getByRole('status').last()).toHaveText(
      'Saved Flat-bracket-Bracket-flat.dxf.'
    );
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  }
);
