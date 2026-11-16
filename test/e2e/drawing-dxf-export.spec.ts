import type { Download, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

/**
 * D04: a drawing sheet exports as a DXF R12 drawing in paper millimetres,
 * with a layer per line kind, the dimensions' arrowheads and the title
 * block's text.
 */

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
  'exports a dimensioned drawing sheet as DXF',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Plate');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '30', depth: '20', height: '10' }
    });
    await expect(
      page.locator('.feature-row-main', { hasText: 'Box' })
    ).toBeVisible();

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      canvas.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 20_000 });
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });
    await tools.getByRole('button', { name: 'Horizontal' }).click();
    const hit = canvas.locator('[data-view="front"] .drawing-view-hit');
    const box = (await hit.boundingBox())!;
    const pxPerMm = box.width / Number(await hit.getAttribute('width'));
    const top = box.y + 3 * pxPerMm;
    await page.mouse.click(box.x + box.width / 2, top);
    await page.mouse.click(box.x + box.width / 2, top - 12 * pxPerMm);
    await expect(
      canvas.getByRole('button', { name: 'Horizontal dimension 30' })
    ).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export DXF' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Plate-Sheet-1.dxf');
    const dxf = (await readDownload(download)).toString('latin1');
    expect(dxf).toContain('$INSUNITS\r\n70\r\n4\r\n');
    for (const layer of ['VISIBLE', 'BORDER', 'DIMENSION', 'TEXT'])
      expect(dxf).toContain(`\r\n2\r\n${layer}\r\n70\r\n0\r\n`);
    // The dimension's value and its two arrowheads; the title block's text.
    expect(dxf).toMatch(/\r\nTEXT\r\n8\r\nTEXT\r\n[^]*?\r\n1\r\n30\r\n/);
    expect(dxf.match(/\r\nSOLID\r\n8\r\nDIMENSION\r\n/g)).toHaveLength(2);
    expect(dxf).toContain('\r\n1\r\nPlate\r\n');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
    expect(errors).toEqual([]);
  }
);
