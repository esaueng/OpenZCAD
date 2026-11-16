import type { Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

/**
 * D02 distance dimensions (schema v75): picked between two straight edges
 * and from a centreline to an edge, read from the model, following a
 * widen through the sheet's Update and back from a reload.
 */

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
    left: box.x + pad,
    right: box.x + box.width - pad,
    top: box.y + pad,
    bottom: box.y + box.height - pad,
    centreX: box.x + box.width / 2,
    centreY: box.y + box.height / 2
  };
}

test(
  'dimensions the distance between edges and from a centreline',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Distances');
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
    ).toHaveCount(1, { timeout: 20_000 });
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });

    // Between the left and right edges, each picked away from its ends.
    await tools.getByRole('button', { name: 'Distance', exact: true }).click();
    let front = await frontViewBox(canvas);
    await page.mouse.click(front.left, front.centreY);
    await page.mouse.click(front.right, front.centreY);
    await page.mouse.click(front.centreX, front.bottom + 12 * front.pxPerMm);
    await expect(
      canvas.getByRole('button', { name: 'Distance dimension 30' })
    ).toBeVisible();

    // A centreline midway up, then the distance from it to the top edge.
    await tools
      .getByRole('button', { name: 'Centreline', exact: true })
      .click();
    front = await frontViewBox(canvas);
    await page.mouse.click(front.centreX, front.top);
    await page.mouse.click(front.centreX, front.bottom);
    const centreline = canvas.getByRole('button', {
      name: 'Centreline between lines'
    });
    await expect(centreline).toBeVisible();
    await tools.getByRole('button', { name: 'Distance', exact: true }).click();
    const lineBox = (await centreline.boundingBox())!;
    await page.mouse.click(
      lineBox.x + lineBox.width / 2,
      lineBox.y + lineBox.height / 2
    );
    front = await frontViewBox(canvas);
    await page.mouse.click(
      front.left + 0.4 * (front.right - front.left),
      front.top
    );
    await page.mouse.click(front.right + 16 * front.pxPerMm, front.top);
    await expect(
      canvas.getByRole('button', { name: 'Distance dimension 5' })
    ).toBeVisible();

    // Widen the box: after the Update the distance reads the new width.
    await mode(page, 'Build').click();
    await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
    await inspector.getByRole('textbox', { name: 'Width (X)' }).fill('45');
    await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('contentinfo')).toContainText('Edited Box');
    await mode(page, 'Draw').click();
    await drawings
      .locator('.drawing-sync.is-outdated')
      .getByRole('button', { name: 'Update' })
      .click({ timeout: 20_000 });
    await expect(
      canvas.getByRole('button', { name: 'Distance dimension 45' })
    ).toBeVisible({ timeout: 20_000 });

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      reopened.getByRole('button', { name: 'Distance dimension 45' })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      reopened.getByRole('button', { name: 'Distance dimension 5' })
    ).toBeVisible();
    expect(errors).toEqual([]);
  }
);
