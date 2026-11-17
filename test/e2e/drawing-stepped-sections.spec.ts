import type { Download, Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * D03 stepped sections (schema v93): a section drawn square across the
 * front view of a block, then given a step in its properties so its line
 * jogs to another height: both cut faces hatched, the line drawn with its
 * jog, exported and reopened from the saved document.
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
  'steps a section line to another depth along its run',
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
        dimensions: { width: 40, height: 20, depth: 10 }
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

    // A square line across the front view's middle, placed above it.
    await tools.getByRole('button', { name: 'Section view' }).click();
    const front = await viewBox(canvas, 'front');
    await page.mouse.move(front.centreX - 15 * front.pxPerMm, front.centreY);
    await page.mouse.down();
    await page.mouse.move(front.centreX, front.centreY, { steps: 3 });
    await page.mouse.move(front.centreX + 15 * front.pxPerMm, front.centreY, {
      steps: 3
    });
    await page.mouse.up();
    const placeY = front.centreY - 40 * front.pxPerMm;
    await page.mouse.move(front.centreX, placeY, { steps: 4 });
    await page.mouse.click(front.centreX, placeY);
    const section = canvas.locator(
      '[data-view="section-A"]:not(.is-placeholder)'
    );
    await expect(section).toHaveCount(1, { timeout: 30_000 });

    // One step, half-way along, then up to z = 8.
    await section.locator('.drawing-view-hit').click();
    const panel = drawings.getByRole('complementary', {
      name: 'Drawing properties'
    });
    await panel.getByRole('button', { name: 'Add step' }).click();
    const depth = panel.getByLabel('Step 1 cut at Z (mm)');
    await expect(depth).toBeVisible();
    await depth.fill('8');
    await depth.press('Enter');
    await expect(
      canvas.locator('[data-view="section-A"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });
    // The line jogs: four points, thick at both ends and both corners.
    const chain = canvas.locator('.drawing-strokes.is-chain polyline');
    await expect(chain).toHaveCount(1);
    await expect
      .poll(async () =>
        ((await chain.getAttribute('points')) ?? '').trim().split(/\s+/)
      )
      .toHaveLength(4);
    await expect(
      canvas.locator('.drawing-strokes.is-cutting polyline')
    ).toHaveCount(6);
    await expect(
      canvas.locator('.drawing-strokes.is-hatch polyline')
    ).not.toHaveCount(0);

    // Placed clear of the front view, it may run past the border.
    await drawings.getByRole('button', { name: 'Fit views to sheet' }).click();
    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toContain('<g class="hatch"');
    expect(svg).toContain('>SECTION A-A</text>');

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      reopened.locator('.drawing-strokes.is-cutting polyline')
    ).toHaveCount(6, { timeout: 30_000 });
    expect(errors).toEqual([]);
  }
);
