import type { Download } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  finishExtrude
} from './openzcad-fixtures';

/**
 * D04: a DXF cam outline drawn as a closed periodic SPLINE around an ELLIPSE
 * bore imports onto the sketch's exact spline and ellipse and extrudes; a
 * sketch's own menu then exports it as DXF.
 */

function dxf(lines: string): string {
  return lines
    .trim()
    .split('\n')
    .flatMap((line) => {
      const space = line.indexOf(' ');
      return [line.slice(0, space), line.slice(space + 1)];
    })
    .join('\r\n');
}

/** A periodic cubic over six points (the first three repeated) in inches. */
const RING = [
  [1.2, 0],
  [0.6, 1],
  [-0.6, 1.1],
  [-1.3, 0],
  [-0.6, -1],
  [0.6, -1.1]
];
const WRAPPED = [...RING, ...RING.slice(0, 3)];

const CAM_DXF = dxf(`
0 SECTION
2 HEADER
9 $INSUNITS
70 1
0 ENDSEC
0 SECTION
2 ENTITIES
0 SPLINE
70 11
71 3
72 ${WRAPPED.length + 4}
73 ${WRAPPED.length}
74 0
${Array.from({ length: WRAPPED.length + 4 }, (_, i) => `40 ${i}`).join('\n')}
${WRAPPED.map(([x, y]) => `10 ${x}\n20 ${y}\n30 0`).join('\n')}
0 ELLIPSE
10 0
20 0
30 0
11 0.3
21 0
31 0
40 0.5
41 0
42 6.283185307179586
0 ENDSEC
0 EOF
`);

const PLATE_DXF = dxf(`
0 SECTION
2 HEADER
9 $INSUNITS
70 4
0 ENDSEC
0 SECTION
2 ENTITIES
0 LWPOLYLINE
90 4
70 1
10 0
20 0
10 40
20 0
10 40
20 25
10 0
20 25
0 ENDSEC
0 EOF
`);

async function readDownload(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

test(
  'imports a spline cam with an ellipse bore and exports a sketch from its menu',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Curves');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(
      page.getByRole('region', { name: '3D viewport' })
    ).toBeVisible();

    const importer = page.getByLabel(/^Import STEP or /);
    await importer.setInputFiles({
      name: 'cam.dxf',
      mimeType: 'image/vnd.dxf',
      buffer: Buffer.from(CAM_DXF)
    });
    await expect(page.getByRole('contentinfo')).toContainText(
      'Imported 2 curves from cam.dxf as sketch "cam", converted from inches.',
      { timeout: 30_000 }
    );
    // The spline outline less the ellipse bore is one region: it extrudes.
    const cam = page.locator('.feature-row-main', { hasText: 'cam' });
    await expect(cam).toHaveCount(1);
    await cam.click();
    await page.keyboard.press('e');
    await finishExtrude(page, '5');
    await expectBodyCount(page, 1);

    await importer.setInputFiles({
      name: 'plate.dxf',
      mimeType: 'image/vnd.dxf',
      buffer: Buffer.from(PLATE_DXF)
    });
    await expect(page.getByRole('contentinfo')).toContainText(
      'Imported 4 curves from plate.dxf as sketch "plate"',
      { timeout: 30_000 }
    );

    // The sketch's own menu opens the export on it, as DXF.
    await page.getByRole('button', { name: 'More actions for plate' }).click();
    await page.getByRole('menuitem', { name: 'Export DXF…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { name: 'DXF' })).toBeChecked();
    await expect(
      dialog.getByRole('combobox').locator('option:checked')
    ).toHaveText('plate');
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export DXF' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Curves-sketch.dxf');
    const text = await readDownload(download);
    expect(text.match(/\r?\n\s*0\r?\nLINE\r?\n/g)).toHaveLength(4);
    await expect(page.getByRole('contentinfo')).toContainText(
      'Exported the sketch to Curves-sketch.dxf.'
    );
  }
);
