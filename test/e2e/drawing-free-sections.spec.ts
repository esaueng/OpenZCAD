import type { Download, Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * D03 free section planes (schema v91): a section line dragged at 45°
 * across the front view of a block cuts it by an inclined plane; a click
 * beside the line places the section seen square to it, hatched, exported
 * and reopened from the saved document.
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

/** A view's drawn extent on screen (its hit box pads it by 3 mm a side). */
async function viewBox(canvas: Locator, view: string) {
  const hit = canvas.locator(`[data-view="${view}"] .drawing-view-hit`);
  const box = (await hit.boundingBox())!;
  const pxPerMm = box.width / Number(await hit.getAttribute('width'));
  return {
    pxPerMm,
    centreX: box.x + box.width / 2,
    centreY: box.y + box.height / 2,
    right: box.x + box.width,
    bottom: box.y + box.height
  };
}

test(
  'cuts a free section along a line drawn at an angle',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Import target');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    const document = addPrimitiveFeature(
      createProjectDocument('Block', toUserId('test')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 20, depth: 10 }
      }
    );
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'block.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document,
          files: []
        })
      )
    });
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Block');

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      canvas.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });

    // A drag at 45° from the front view's middle, up and to the right.
    await tools.getByRole('button', { name: 'Section view' }).click();
    const front = await viewBox(canvas, 'front');
    const step = 6 * front.pxPerMm;
    await page.mouse.move(front.centreX, front.centreY);
    await page.mouse.down();
    await page.mouse.move(front.centreX + step / 2, front.centreY - step / 2, {
      steps: 3
    });
    await page.mouse.move(front.centreX + step, front.centreY - step, {
      steps: 3
    });
    await page.mouse.up();
    await expect(drawings.locator('.drawing-tool-hint')).toContainText(
      'Click on a side of the line'
    );
    // Then a click below and to the right of it, clear of the front view.
    const placeX = front.right + 40 * front.pxPerMm;
    const placeY = front.bottom + 10 * front.pxPerMm;
    await page.mouse.move(placeX, placeY, { steps: 4 });
    await expect(canvas.locator('.drawing-section-ghost')).toBeVisible();
    await page.mouse.click(placeX, placeY);

    const section = canvas.locator(
      '[data-view="section-A"]:not(.is-placeholder)'
    );
    await expect(section).toHaveCount(1, { timeout: 30_000 });
    await expect(
      canvas.locator('.drawing-strokes.is-hatch polyline')
    ).not.toHaveCount(0);
    await expect(
      canvas.locator('.drawing-strokes.is-chain polyline')
    ).toHaveCount(1);
    await section.locator('.drawing-view-hit').click();
    const panel = drawings.getByRole('complementary', {
      name: 'Drawing properties'
    });
    await expect(panel.getByLabel('Plane offset (mm)')).toBeVisible();
    await expect(panel).toContainText('at an angle: it is placed freely');
    await expect(panel).toContainText("The cut is the kernel's exact boolean");

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toContain('<g class="hatch"');
    expect(svg).toContain('<g class="chain"');
    expect(svg).toContain('>SECTION A-A</text>');

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      reopened.locator('[data-view="section-A"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      reopened.locator('.drawing-strokes.is-hatch polyline')
    ).not.toHaveCount(0);
    expect(errors).toEqual([]);
  }
);
