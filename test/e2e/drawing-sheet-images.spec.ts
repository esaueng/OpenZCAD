import { deflateSync } from 'node:zlib';
import type { Download, Page } from '@playwright/test';
import {
  clickGhostPlane,
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  finishInPlaceCommand,
  pressTool,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * D02 sheet images (schema v92): a picture inserted into the project in
 * Build is placed on a drawing sheet with the Image tool, printed into the
 * SVG and PDF exports from its own bytes, and reopened with the sheet.
 */

/** A 200 × 100 RGB PNG: dark left half, light right half. */
function testPng(): Buffer {
  const width = 200;
  const height = 100;
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) {
      const light = x >= width / 2;
      rows.push(light ? 230 : 30, light ? 220 : 60, light ? 200 : 90);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function mode(page: Page, name: 'Build' | 'Draw') {
  return page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name, exact: true });
}

test(
  'places a project picture on a sheet and prints it',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Sheet image');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '40', depth: '20', height: '10' }
    });
    await expectBodyCount(page, 1);

    // A picture in the project: inserted as a reference image in Build.
    const chooser = page.waitForEvent('filechooser');
    await pressTool(page, /^Image — /);
    await (
      await chooser
    ).setFiles({
      name: 'Shop logo.png',
      mimeType: 'image/png',
      buffer: testPng()
    });
    await clickGhostPlane(page, 'XY');
    await finishInPlaceCommand(page, 'Image');
    await expect(
      page
        .getByRole('list', { name: 'Objects' })
        .getByRole('button', { name: /^Shop logo/ })
    ).toBeVisible();

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      canvas.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });

    // The Image tool, then a click on empty paper near the top left.
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });
    await tools.getByRole('button', { name: 'Image', exact: true }).click();
    const paper = (await canvas.locator('.drawing-paper').boundingBox())!;
    await page.mouse.click(
      paper.x + paper.width * 0.15,
      paper.y + paper.height * 0.15
    );
    const shown = canvas.locator('image.drawing-sheet-image');
    await expect(shown).toHaveCount(1, { timeout: 20_000 });
    await expect(shown).toHaveAttribute('href', /^blob:/);
    // 40 mm wide by default, half as high as the 200 × 100 picture.
    await expect(shown).toHaveAttribute('width', '40');
    await expect(shown).toHaveAttribute('height', '20');
    const panel = drawings.getByRole('complementary', {
      name: 'Drawing properties'
    });
    await expect(panel.getByLabel('Picture')).toHaveValue(/^rimg_/);
    await panel.getByLabel('Width (mm)').fill('60');
    await panel.getByLabel('Width (mm)').press('Enter');
    await expect(shown).toHaveAttribute('height', '30');

    let downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toMatch(
      /<image [^>]*width="60" height="30" preserveAspectRatio="none" href="data:image\/png;base64,/
    );
    downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export PDF' }).click();
    const pdf = (await readDownload(await downloadPromise)).toString('latin1');
    expect(pdf).toContain('/Width 200 /Height 100');
    expect(pdf).toContain('/Filter /DCTDecode');
    expect(pdf).toContain('/Im1 Do Q');

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(reopened.locator('image.drawing-sheet-image')).toHaveAttribute(
      'href',
      /^blob:/,
      { timeout: 30_000 }
    );
    expect(errors).toEqual([]);
  }
);
