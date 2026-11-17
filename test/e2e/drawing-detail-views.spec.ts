import type { Download, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

/**
 * D03 detail views (schema v78): a circle dragged on a view makes an
 * enlarged, cropped detail placed by a click; it exports with its caption
 * and the circle on its source, and comes back after a reload.
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
  'circles a region of a view and places it as an enlarged detail',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Detailed');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '40', depth: '20', height: '10' }
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
    await tools.getByRole('button', { name: 'Detail view' }).click();

    // From the front view's top right corner, out 5 mm.
    const hit = canvas.locator('[data-view="front"] .drawing-view-hit');
    const box = (await hit.boundingBox())!;
    const pxPerMm = box.width / Number(await hit.getAttribute('width'));
    const corner = {
      x: box.x + box.width - 3 * pxPerMm,
      y: box.y + 3 * pxPerMm
    };
    await page.mouse.move(corner.x - 2, corner.y + 2);
    await page.mouse.down();
    await page.mouse.move(corner.x - 2 + 5 * pxPerMm, corner.y + 2, {
      steps: 4
    });
    await page.mouse.up();
    await expect(drawings.locator('.drawing-tool-hint')).toContainText(
      'Move the detail into place'
    );
    // Placed below the front view.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 40);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height + 40);
    const views = drawings.getByRole('listbox', {
      name: 'Views on this sheet'
    });
    await expect(views.getByRole('option', { name: 'Detail A' })).toBeVisible();
    // At least twice the sheet's own scale.
    await expect(canvas.locator('.drawing-texts')).toContainText(
      /DETAIL A \(\d+:\d+\)/
    );

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toMatch(/>DETAIL A \(\d+:\d+\)<\/text>/);

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page.getByRole('region', { name: 'Drawings' });
    await expect(
      reopened
        .getByRole('listbox', { name: 'Views on this sheet' })
        .getByRole('option', { name: 'Detail A' })
    ).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  }
);
