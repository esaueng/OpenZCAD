import type { Download, Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

/**
 * D02 (schema v68): a dimension's tolerance, prefix and suffix. Limits are
 * stored as deviations, so after the model widens and the sheet's Update
 * they print the new size's limits; they export to SVG and PDF and come
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

/** The front view's drawn extent on screen (its hit box pads it 3 mm). */
async function frontViewBox(canvas: Locator) {
  const hit = canvas.locator('[data-view="front"] .drawing-view-hit');
  const box = (await hit.boundingBox())!;
  const pxPerMm = box.width / Number(await hit.getAttribute('width'));
  const pad = 3 * pxPerMm;
  return {
    pxPerMm,
    top: box.y + pad,
    centreX: box.x + box.width / 2
  };
}

test(
  'tolerances a dimension with limits that follow the model, and exports them',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Toleranced');
    await page.getByRole('button', { name: 'New project' }).click();
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
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
    const plain = canvas.getByRole('button', {
      name: 'Horizontal dimension 30'
    });
    // Placed, it is selected (the tool stays armed for the next one).
    await expect(plain).toHaveAttribute('aria-pressed', 'true');

    // Limits of ±0.1 by default, then a prefix and a suffix.
    await panel
      .getByRole('combobox', { name: 'Tolerance' })
      .selectOption('limits');
    await expect(
      canvas.getByRole('button', { name: 'Horizontal dimension 30.10/29.90' })
    ).toBeVisible();
    const lower = panel.getByRole('spinbutton', { name: 'Tolerance lower' });
    await lower.fill('-0.05');
    await lower.press('Enter');
    await panel.getByRole('textbox', { name: 'Prefix' }).fill('2×');
    await panel.getByRole('textbox', { name: 'Prefix' }).press('Enter');
    await panel.getByRole('textbox', { name: 'Suffix' }).fill('TYP');
    await panel.getByRole('textbox', { name: 'Suffix' }).press('Enter');
    const toleranced = canvas.getByRole('button', {
      name: 'Horizontal dimension 2× 30.10/29.95 TYP'
    });
    await expect(toleranced).toBeVisible();
    // Drawn as a stacked pair, not one line.
    const texts = canvas.locator('.drawing-texts text');
    await expect(texts.filter({ hasText: /^30\.10$/ })).toHaveCount(1);
    await expect(texts.filter({ hasText: /^29\.95$/ })).toHaveCount(1);

    let downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    for (const text of ['2×', '30.10', '29.95', 'TYP'])
      expect(svg).toContain(`>${text}</text>`);
    downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export PDF' }).click();
    const pdf = (await readDownload(await downloadPromise)).toString('latin1');
    expect(pdf).toContain('(30.10) Tj');
    expect(pdf).toContain('(29.95) Tj');

    // Widen the box; after the Update the limits are the new size's.
    await mode(page, 'Build').click();
    await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
    await inspector.getByRole('textbox', { name: 'Width (X)' }).fill('45');
    await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('contentinfo')).toContainText('Edited Box');
    await mode(page, 'Draw').click();
    const outdated = drawings.locator('.drawing-sync.is-outdated');
    await outdated
      .getByRole('button', { name: 'Update' })
      .click({ timeout: 20_000 });
    await expect(
      canvas.getByRole('button', {
        name: 'Horizontal dimension 2× 45.10/44.95 TYP'
      })
    ).toBeVisible({ timeout: 20_000 });

    // Reopen: the format comes back from the saved document.
    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Drawings' })
        .getByRole('application', { name: 'Sheet Sheet 1' })
        .getByRole('button', {
          name: 'Horizontal dimension 2× 45.10/44.95 TYP'
        })
    ).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  }
);
