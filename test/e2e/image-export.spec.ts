import { inflateSync } from 'node:zlib';
import {
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Download, Page } from '@playwright/test';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

/**
 * ZC-190/192: Export image… writes the current view as a PNG at a chosen
 * size, offscreen, with a transparent background on request, and a sketch
 * as an exact SVG at 1:1 in document units.
 */

/** A 1 × 0.5 inch slot with rounded ends and a 0.2 inch hole. */
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

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Decode the encoder's own PNG shape: one IDAT, Sub-filtered RGBA rows. */
function decodePng(png: Buffer) {
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const types: string[] = [];
  let header: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    types.push(type);
    if (type === 'IHDR') header = data;
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const width = header!.readUInt32BE(0);
  const height = header!.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? rgba[y * stride + x - 4]! : 0;
      rgba[y * stride + x] = (raw[row + 1 + x]! + left) & 0xff;
    }
  }
  return { types, width, height, colorType: header![9], rgba };
}

async function openImageExport(page: Page) {
  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  await fileMenu.getByRole('button', { name: /Export image/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export image' });
  await expect(dialog).toBeVisible();
  await expect(fileMenu).not.toHaveAttribute('open', '');
  return dialog;
}

test('exports the view as a sized, transparent PNG and a sketch as exact SVG', async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Image export');
  await page.getByRole('button', { name: 'Create project' }).click();
  const viewport = page.getByRole('region', { name: '3D viewport' });
  await expect(viewport).toBeVisible();

  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
    name: 'slot.dxf',
    mimeType: 'image/vnd.dxf',
    buffer: Buffer.from(SLOT_DXF)
  });
  await expect(page.getByRole('contentinfo')).toContainText(
    'Imported 5 curves from slot.dxf',
    { timeout: 30_000 }
  );
  const row = page.locator('.feature-row-main', { hasText: 'slot' });
  await row.click();
  await page.keyboard.press('e');
  const distance = page
    .getByRole('region', { name: 'Extrude operation' })
    .getByRole('textbox', { name: 'Distance', exact: true });
  await distance.fill('5');
  await distance.press('Enter');
  await expectBodyCount(page, 1);
  // Nothing selected: the image is the whole view.
  await page.keyboard.press('Escape');

  // PNG: a custom size whose shape differs from the view, transparent.
  const canvas = viewport.locator('canvas').first();
  const before = await canvas.evaluate((node: HTMLCanvasElement) => [
    node.width,
    node.height
  ]);
  let dialog = await openImageExport(page);
  await expect(dialog).toContainText('Renders visible bodies (1)');
  await dialog.getByLabel('Width (px)').fill('640');
  await dialog.getByLabel('Height (px)').fill('360');
  await dialog.getByLabel('Transparent background').check();
  await dialog.getByLabel('Include the grid and axes').uncheck();
  let downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export PNG' }).click();
  let download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Image-export.png');
  const png = decodePng(await readDownload(download));
  await download.saveAs(testInfo.outputPath('view.png'));
  expect(png.types).toEqual(['IHDR', 'IDAT', 'IEND']);
  expect([png.width, png.height, png.colorType]).toEqual([640, 360, 6]);
  const alpha = (x: number, y: number) => png.rgba[(y * png.width + x) * 4 + 3];
  // Corners are background: fully transparent. The body is opaque.
  expect([alpha(0, 0), alpha(639, 0), alpha(0, 359), alpha(639, 359)]).toEqual([
    0, 0, 0, 0
  ]);
  let opaque = 0;
  for (let i = 3; i < png.rgba.length; i += 4) {
    if (png.rgba[i] === 255) opaque += 1;
  }
  expect(opaque).toBeGreaterThan(640 * 360 * 0.002);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Exported a 640 × 360 PNG to Image-export.png.'
  );
  // Offscreen: the live canvas kept its size.
  expect(
    await canvas.evaluate((node: HTMLCanvasElement) => [
      node.width,
      node.height
    ])
  ).toEqual(before);

  // An opaque export fills every pixel.
  dialog = await openImageExport(page);
  await dialog.getByLabel('Width (px)').fill('64');
  await dialog.getByLabel('Height (px)').fill('48');
  downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export PNG' }).click();
  download = await downloadPromise;
  const opaquePng = decodePng(await readDownload(download));
  expect([opaquePng.width, opaquePng.height]).toEqual([64, 48]);
  for (let i = 3; i < opaquePng.rgba.length; i += 4) {
    expect(opaquePng.rgba[i]).toBe(255);
  }

  // SVG: the imported sketch, exact, in the document's millimetres.
  dialog = await openImageExport(page);
  await dialog.getByRole('radio', { name: 'SVG' }).check();
  await expect(dialog).toContainText('at 1:1 in millimeters');
  await dialog.getByLabel('Transparent background').check();
  downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export SVG' }).click();
  download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Image-export-sketch.svg');
  const svg = (await readDownload(download)).toString('utf8');
  await download.saveAs(testInfo.outputPath('sketch.svg'));
  expect(svg.match(/<line /g)).toHaveLength(2);
  expect(svg.match(/<path d="M[^"]* A6\.35 6\.35 /g)).toHaveLength(2);
  expect(svg).toMatch(/<circle cx="12\.7" cy="-6\.35" r="2\.54"\/>/);
  expect(svg).not.toContain('<rect');
  // 25.4 × 12.7 mm plus the slot's round ends (6.35 mm radius each side)
  // and half a 0.25 mm stroke of margin all round.
  const viewBox = svg
    .match(/viewBox="([^"]+)"/)![1]!
    .split(' ')
    .map(Number);
  expect(viewBox[2]).toBeCloseTo(25.4 + 2 * 6.35 + 0.25, 6);
  expect(viewBox[3]).toBeCloseTo(12.7 + 0.25, 6);
  expect(svg).toMatch(/width="38\.35mm" height="12\.95mm"/);

  // A History selection outside sketch editing must choose that sketch,
  // rather than silently downloading the first sketch again.
  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
    name: 'second-slot.dxf',
    mimeType: 'image/vnd.dxf',
    buffer: Buffer.from(SLOT_DXF.replace('40\r\n0.1', '40\r\n0.2'))
  });
  await expect(page.getByRole('contentinfo')).toContainText(
    'Imported 5 curves from second-slot.dxf',
    { timeout: 30_000 }
  );
  await page.locator('.feature-row-main', { hasText: 'second-slot' }).click();
  dialog = await openImageExport(page);
  await dialog.getByRole('radio', { name: 'SVG' }).check();
  await expect(dialog.getByLabel('Sketch').locator('option:checked')).toHaveText(
    'second-slot'
  );
  downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export SVG' }).click();
  const selectedSvg = (await readDownload(await downloadPromise)).toString('utf8');
  expect(selectedSvg).toContain('r="5.08"');
  expect(selectedSvg).not.toContain('r="2.54"');
});

for (const arc of [
  { name: 'large finite angle', start: 2 ** 60, end: 2 ** 60 + 256 },
  { name: 'nearly closed arc', start: 0, end: 359.999999999 }
]) {
  test(`exports a visible SVG for a ${arc.name}`, async ({ page }) => {
    await stubApi(page);
    const { document } = addSketchFeature(
      createProjectDocument('Arc image', toUserId('user_e2e')),
      {
        name: 'Arc',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          {
            objectKind: 'arc',
            centerX: 0,
            centerY: 0,
            radius: 10,
            startAngleDeg: arc.start,
            endAngleDeg: arc.end
          }
        ]
      }
    );
    await page.route('**/api/projects', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 201,
            json: {
              project: {
                projectId: document.projectId,
                name: document.name,
                revisionCount: 1,
                updatedAt: new Date().toISOString()
              },
              document
            }
          })
        : route.fulfill({ json: { projects: [] } })
    );
    await page.goto('/');
    await page.getByLabel('Project name').fill(document.name);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(
      page.locator('.feature-row .feature-name', { hasText: /^Arc$/ })
    ).toBeVisible();
    const dialog = await openImageExport(page);
    await dialog.getByRole('radio', { name: 'SVG' }).check();
    const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    const bounds = await page.evaluate((source) => {
      const root = new DOMParser().parseFromString(
        source,
        'image/svg+xml'
      ).documentElement;
      const node = window.document.importNode(root, true);
      window.document.body.appendChild(node);
      try {
        const box = node.querySelector('path')!.getBBox();
        return { width: box.width, height: box.height };
      } finally {
        node.remove();
      }
    }, svg);
    const extent = svg
      .match(/viewBox="([^"]+)"/)![1]!
      .split(' ')
      .map(Number);
    expect(extent[2]).toBe(20.25);
    // Chromium's SVG path bounds use float precision; the serialized extent
    // above is exact, and the path must actually draw the full diameter.
    expect(bounds.width).toBeCloseTo(20, 4);
    expect(bounds.height).toBeGreaterThan(16.9);
  });
}
