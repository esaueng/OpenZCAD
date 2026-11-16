import type { Download, Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

/**
 * D02 geometry annotations (schema v73): a centreline midway between two
 * edges and an intersection mark where two edges' lines cross, made from
 * picks alone, and a dimension measured to the mark; they export as chain
 * and thin lines and come back from the saved document after a reload.
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
    left: box.x + pad,
    right: box.x + box.width - pad,
    top: box.y + pad,
    bottom: box.y + box.height - pad,
    centreX: box.x + box.width / 2,
    centreY: box.y + box.height / 2
  };
}

test(
  'marks a centreline and an intersection, and dimensions to the mark',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Marked');
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

    // A centreline midway between the front view's top and bottom edges,
    // each picked away from its ends: made on the second pick.
    await tools
      .getByRole('button', { name: 'Centreline', exact: true })
      .click();
    let front = await frontViewBox(canvas);
    await page.mouse.click(front.centreX, front.top);
    await page.mouse.click(front.centreX, front.bottom);
    await expect(
      canvas.getByRole('button', { name: 'Centreline between lines' })
    ).toBeVisible();

    // Where the top and right edges' lines cross.
    await tools.getByRole('button', { name: 'Intersection mark' }).click();
    front = await frontViewBox(canvas);
    await page.mouse.click(front.centreX, front.top);
    await page.mouse.click(front.right, front.centreY);
    const mark = canvas.getByRole('button', { name: 'Intersection mark' });
    await expect(mark).toBeVisible();

    // A horizontal dimension from the mark to the left edge's end.
    await tools.getByRole('button', { name: 'Horizontal' }).click();
    const markBox = (await mark.boundingBox())!;
    await page.mouse.click(
      markBox.x + markBox.width / 2,
      markBox.y + markBox.height / 2
    );
    front = await frontViewBox(canvas);
    await page.mouse.click(front.left, front.top + 1);
    await page.mouse.click(front.centreX, front.top - 14 * front.pxPerMm);
    await expect(
      canvas.getByRole('button', { name: 'Horizontal dimension 30' })
    ).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toContain('<g class="chain"');
    expect(svg).toMatch(/>30<\/text>/);

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      reopened.getByRole('button', { name: 'Horizontal dimension 30' })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      reopened.getByRole('button', { name: 'Intersection mark' })
    ).toBeVisible();
    await expect(
      reopened.getByRole('button', { name: 'Centreline between lines' })
    ).toBeVisible();
    expect(errors).toEqual([]);
  }
);
