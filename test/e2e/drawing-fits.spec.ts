import type { Download, Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

/**
 * D07 slice B (schema v105): a pin's diameter given an ISO 286 fit, printed
 * with the limits its tables state, and an ISO 2768 general-tolerance block
 * placed on the paper; both export with the sheet and come back from the
 * saved document after a reload.
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

async function viewBox(canvas: Locator, view: string) {
  const hit = canvas.locator(`[data-view="${view}"] .drawing-view-hit`);
  const box = (await hit.boundingBox())!;
  const pxPerMm = box.width / Number(await hit.getAttribute('width'));
  const pad = 3 * pxPerMm;
  return {
    pxPerMm,
    left: box.x + pad,
    right: box.x + box.width - pad,
    centreX: box.x + box.width / 2,
    centreY: box.y + box.height / 2
  };
}

test(
  'fits a pin’s diameter and states the general tolerances',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Fitted');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'cylinder', {
      sizes: { radius: '4', height: '20' }
    });
    await expect(
      page.locator('.feature-row-main', { hasText: 'Cylinder' })
    ).toBeVisible();

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    const panel = drawings.getByRole('complementary', {
      name: 'Drawing properties'
    });
    await expect(
      canvas.locator('[data-view="top"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 20_000 });
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });

    // The rim, seen face-on from above, at its leftmost point.
    await tools.getByRole('button', { name: 'Diameter' }).click();
    const top = await viewBox(canvas, 'top');
    await page.mouse.click(top.left, top.centreY);
    await page.mouse.click(top.right + 10 * top.pxPerMm, top.centreY);
    await expect(
      canvas.getByRole('button', { name: 'Diameter dimension Ø8' })
    ).toBeVisible();
    // H7 on Ø8 (6–10 mm): +0.015/0.
    await panel
      .getByRole('combobox', { name: 'Fit (ISO 286)' })
      .selectOption('H7');
    await expect(
      canvas.getByRole('button', {
        name: 'Diameter dimension Ø8 H7 +0.015/0'
      })
    ).toBeVisible();

    // The general-tolerance block, one click on the paper.
    await tools.getByRole('button', { name: 'General tolerances' }).click();
    await page.mouse.click(top.right + 40 * top.pxPerMm, top.centreY);
    await expect(
      canvas.getByRole('button', { name: 'General tolerances ISO 2768-m' })
    ).toBeVisible();
    await panel
      .getByRole('combobox', { name: 'Geometric class (ISO 2768-2)' })
      .selectOption('K');
    await expect(
      canvas.getByRole('button', { name: 'General tolerances ISO 2768-mK' })
    ).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toContain('>Ø8 H7<');
    expect(svg).toContain('>+0.015<');
    expect(svg).toContain('>ISO 2768-mK (mm)<');

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      reopened.getByRole('button', {
        name: 'Diameter dimension Ø8 H7 +0.015/0'
      })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      reopened.getByRole('button', { name: 'General tolerances ISO 2768-mK' })
    ).toBeVisible();
    expect(errors).toEqual([]);
  }
);
