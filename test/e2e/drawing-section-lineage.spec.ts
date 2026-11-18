import type { Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * D03 cut-edge lineage: a dimension on a section's own cut edge follows a
 * model edit through the sheet's Update, found again by its section
 * lineage, rather than breaking.
 */

function mode(page: Page, name: 'Build' | 'Draw') {
  return page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name, exact: true });
}

/** A view's drawn extent on screen (its hit box pads it by 3 mm a side). */
async function viewBox(canvas: Locator, view: string) {
  const hit = canvas.locator(`[data-view="${view}"] .drawing-view-hit`);
  const box = (await hit.boundingBox())!;
  const pxPerMm = box.width / Number(await hit.getAttribute('width'));
  const pad = 3 * pxPerMm;
  return {
    pxPerMm,
    left: box.x + pad,
    right: box.x + box.width - pad,
    top: box.y + pad,
    bottom: box.y + box.height - pad,
    width: box.width - 2 * pad,
    centreX: box.x + box.width / 2,
    centreY: box.y + box.height / 2
  };
}

test(
  'a dimension on a section edge follows the model through its Update',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Lineage');
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
    await expect(
      canvas.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });

    // A section across the front view's middle, placed above it.
    await tools.getByRole('button', { name: 'Section view' }).click();
    const front = await viewBox(canvas, 'front');
    await page.mouse.move(front.left + 2 * front.pxPerMm, front.centreY);
    await page.mouse.down();
    await page.mouse.move(front.centreX, front.centreY, { steps: 3 });
    await page.mouse.move(front.right - 2 * front.pxPerMm, front.centreY, {
      steps: 3
    });
    await page.mouse.up();
    const placeY = front.top - 20 * front.pxPerMm;
    await page.mouse.move(front.centreX + 30, placeY, { steps: 6 });
    await expect(canvas.locator('.drawing-section-ghost')).toBeVisible();
    await page.mouse.click(front.centreX + 30, placeY);
    await expect(
      canvas.locator('[data-view="section-A"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });
    await drawings.getByRole('button', { name: 'Fit views to sheet' }).click();

    // The section's own top edge, cut from the box's back face: 30 long.
    await tools.getByRole('button', { name: 'Horizontal' }).click();
    const section = await viewBox(canvas, 'section-A');
    await page.mouse.click(section.centreX, section.top);
    await page.mouse.click(section.centreX, section.top - 10 * section.pxPerMm);
    await expect(
      canvas.getByRole('button', { name: 'Horizontal dimension 30' })
    ).toBeVisible();

    // Widen the box; after the Update the cut edge is a new edge, found by
    // its lineage, and the dimension reads the new width.
    await mode(page, 'Build').click();
    await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
    await inspector.getByRole('textbox', { name: 'Width (X)' }).fill('45');
    await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('contentinfo')).toContainText('Edited Box');
    await mode(page, 'Draw').click();
    const outdated = drawings.locator('.drawing-sync.is-outdated');
    await outdated.getByRole('button', { name: 'Update' }).click({
      timeout: 20_000
    });
    await expect(
      canvas.getByRole('button', { name: 'Horizontal dimension 45' })
    ).toBeVisible({ timeout: 30_000 });
  }
);
