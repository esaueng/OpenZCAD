import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  finishExtrude
} from './openzcad-fixtures';

/**
 * D04: a DXF drawing imports as one sketch on Top, its units converted and
 * its annotations reported, and the sketch is real geometry: it extrudes.
 */

/**
 * A 1 × 0.5 inch slot (rounded ends, bulge 1) with a 0.2 inch hole, plus a
 * label the import leaves out. One "code value" pair per line.
 */
const SLOT_DXF = `
0 SECTION
2 HEADER
9 $INSUNITS
70 1
0 ENDSEC
0 SECTION
2 ENTITIES
0 LWPOLYLINE
90 4
70 1
10 0
20 0
42 0
10 1
20 0
42 1
10 1
20 0.5
42 0
10 0
20 0.5
42 1
0 CIRCLE
10 0.5
20 0.25
40 0.1
0 TEXT
10 0
20 0
40 0.1
1 SLOT
0 ENDSEC
0 EOF
`
  .trim()
  .split('\n')
  .flatMap((line) => {
    const space = line.indexOf(' ');
    return [line.slice(0, space), line.slice(space + 1)];
  })
  .join('\r\n');

test('imports a DXF as an extrudable sketch, converting its units', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('DXF import');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();

  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
    name: 'slot.dxf',
    mimeType: 'image/vnd.dxf',
    buffer: Buffer.from(SLOT_DXF)
  });
  await expect(page.getByRole('contentinfo')).toContainText(
    'Imported 5 curves from slot.dxf as sketch "slot", converted from inches · left out 1 TEXT.',
    { timeout: 30_000 }
  );
  const row = page.locator('.feature-row-main', { hasText: 'slot' });
  await expect(row).toHaveCount(1);

  // The slot and its hole bound one region; extruding it makes a body.
  await row.click();
  await page.keyboard.press('e');
  await finishExtrude(page, '5');
  await expectBodyCount(page, 1);
});
