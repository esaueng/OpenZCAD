import type { Download, Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

/**
 * D07 geometric tolerancing (schema v98): datum A on a box's bottom edge,
 * and a feature control frame under the box's width dimension made a
 * parallelism to A in Properties; both export with the sheet and come back
 * from the saved document after a reload.
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
  const pad = 3 * pxPerMm;
  return {
    pxPerMm,
    top: box.y + pad,
    bottom: box.y + box.height - pad,
    centreX: box.x + box.width / 2
  };
}

test(
  'declares a datum and tolerances a dimension with a frame',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Toleranced');
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

    // Datum A on the front view's bottom edge, its symbol placed below.
    await tools.getByRole('button', { name: 'Datum feature' }).click();
    let front = await frontViewBox(canvas);
    await page.mouse.click(front.centreX, front.bottom);
    await page.mouse.click(
      front.centreX + 10 * front.pxPerMm,
      front.bottom + 12 * front.pxPerMm
    );
    await expect(
      canvas.getByRole('button', { name: 'Datum feature A' })
    ).toBeVisible();

    // The width across the top edge, dimensioned above it.
    await tools.getByRole('button', { name: 'Horizontal' }).click();
    front = await frontViewBox(canvas);
    await page.mouse.click(front.centreX, front.top);
    await page.mouse.click(front.centreX, front.top - 14 * front.pxPerMm);
    const width = canvas.getByRole('button', {
      name: 'Horizontal dimension 30'
    });
    await expect(width).toBeVisible();

    // A frame attached under the dimension: click it, then place.
    await tools.getByRole('button', { name: 'Feature control frame' }).click();
    const widthBox = (await width.boundingBox())!;
    await page.mouse.click(
      widthBox.x + widthBox.width / 2,
      widthBox.y + widthBox.height / 2
    );
    // Anywhere on the paper: an attached frame sits under its dimension.
    await page.mouse.click(
      widthBox.x + widthBox.width + 60,
      widthBox.y + widthBox.height + 40
    );
    await expect(
      canvas.getByRole('button', {
        name: 'Feature control frame Flatness | 0.1'
      })
    ).toBeVisible();
    // Properties opens on it: parallelism names the declared datum A.
    await drawings
      .getByRole('combobox', { name: 'Characteristic' })
      .selectOption('parallelism');
    await expect(
      canvas.getByRole('button', {
        name: 'Feature control frame Parallelism | 0.1 | A'
      })
    ).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toMatch(/>0\.1<\/text>/);
    expect(svg).toMatch(/>A<\/text>/);

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      reopened.getByRole('button', {
        name: 'Feature control frame Parallelism | 0.1 | A'
      })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      reopened.getByRole('button', { name: 'Datum feature A' })
    ).toBeVisible();
    expect(errors).toEqual([]);
  }
);
