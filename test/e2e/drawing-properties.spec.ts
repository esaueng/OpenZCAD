import type { Download, Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

/**
 * D02 drawing properties (schema v70): a millimetre model dimensioned on a
 * sheet that prints inches with a decimal comma and its own line weights;
 * the title block names the units and the paper, and the properties come
 * back from the saved document after a reload.
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

async function frontViewBox(canvas: Locator) {
  const hit = canvas.locator('[data-view="front"] .drawing-view-hit');
  const box = (await hit.boundingBox())!;
  const pxPerMm = box.width / Number(await hit.getAttribute('width'));
  return { pxPerMm, top: box.y + 3 * pxPerMm, centreX: box.x + box.width / 2 };
}

test(
  'prints a sheet’s dimensions in its own units and separator, with its own line weights',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Inch drawing');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '38.1', depth: '20', height: '10' }
    });
    await expect(
      page.locator('.feature-row-main', { hasText: 'Box' })
    ).toBeVisible();

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    const panel = drawings.getByRole('complementary', {
      name: 'Drawing properties'
    });
    await expect(
      canvas.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 20_000 });
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });
    await tools.getByRole('button', { name: 'Horizontal' }).click();
    const front = await frontViewBox(canvas);
    await page.mouse.click(front.centreX, front.top);
    await page.mouse.click(front.centreX, front.top - 12 * front.pxPerMm);
    await expect(
      canvas.getByRole('button', { name: 'Horizontal dimension 38.1' })
    ).toBeVisible();
    // Back to the sheet's own properties.
    await page.keyboard.press('Escape');
    await panel.getByRole('button', { name: 'Back to the sheet' }).click();

    await panel
      .getByRole('combobox', { name: 'Dimension units' })
      .selectOption('inch');
    await expect(
      canvas.getByRole('button', { name: 'Horizontal dimension 1.5' })
    ).toBeVisible();
    await panel
      .getByRole('combobox', { name: 'Decimal separator' })
      .selectOption('comma');
    await expect(
      canvas.getByRole('button', { name: 'Horizontal dimension 1,5' })
    ).toBeVisible();
    await panel.getByText('Line weights (mm)').click();
    const visible = panel.getByRole('spinbutton', { name: 'Visible edges' });
    await visible.fill('0.5');
    await visible.press('Enter');

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toContain('>1,5</text>');
    expect(svg).toContain('>Inches</text>');
    expect(svg).toMatch(/>\d+:\d+ · (A\d|ANSI [A-D])<\/text>/);
    expect(svg).toContain(
      '<g class="visible" fill="none" stroke="#000000" stroke-width="0.5"'
    );

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Drawings' })
        .getByRole('application', { name: 'Sheet Sheet 1' })
        .getByRole('button', { name: 'Horizontal dimension 1,5' })
    ).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  }
);
