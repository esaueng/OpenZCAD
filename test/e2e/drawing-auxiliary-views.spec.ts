import type { Download, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * D03 auxiliary views (schema v81): on a box turned 30° about Y, picking its
 * sloping edge in the front view and clicking beside it places a view seen
 * square to that face, labelled VIEW A; it exports and reopens.
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

function tiltedBox() {
  const document = addPrimitiveFeature(
    createProjectDocument('Tilted block', toUserId('test')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 20, depth: 10 }
    }
  );
  return transformBody(document, {
    name: 'Turn',
    targetBodyId: document.bodyOrder[0]!,
    translation: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 30, z: 0 }
  }).document;
}

test(
  'places an auxiliary view square to a sloping face',
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
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'tilted.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: tiltedBox(),
          files: []
        })
      )
    });
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Tilted block');

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      canvas.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });
    await tools.getByRole('button', { name: 'Auxiliary view' }).click();

    // The front view's top edge slopes 30°: from its high corner along the
    // footprint's top, down a quarter of the way.
    const hit = canvas.locator('[data-view="front"] .drawing-view-hit');
    const box = (await hit.boundingBox())!;
    const pxPerMm = box.width / Number(await hit.getAttribute('width'));
    const pad = 3 * pxPerMm;
    const left = box.x + pad;
    const right = box.x + box.width - pad;
    const top = box.y + pad;
    // Turned about +Y by 30°, the box's top edge falls from left to right
    // or rises: try both corners until the tool takes the edge.
    const hint = drawings.locator('.drawing-tool-hint');
    const slope = Math.tan(Math.PI / 6);
    const candidates = [
      [
        left + 0.3 * 40 * pxPerMm * Math.cos(Math.PI / 6),
        top + 0.3 * 40 * pxPerMm * Math.sin(Math.PI / 6)
      ],
      [
        right - 0.3 * 40 * pxPerMm * Math.cos(Math.PI / 6),
        top + 0.3 * 40 * pxPerMm * Math.sin(Math.PI / 6)
      ]
    ] as const;
    let picked = false;
    for (const [x, y] of candidates) {
      await page.mouse.click(x, y);
      if ((await hint.textContent())?.includes('Move to the side')) {
        picked = true;
        break;
      }
    }
    expect(picked, `slope ${slope}`).toBe(true);
    await page.mouse.click(
      box.x + box.width + 40 * pxPerMm,
      box.y - 10 * pxPerMm
    );
    const views = drawings.getByRole('listbox', {
      name: 'Views on this sheet'
    });
    await expect(views.getByRole('option', { name: 'View A' })).toBeVisible();
    await expect(canvas.locator('.drawing-texts')).toContainText('VIEW A');

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toContain('>VIEW A</text>');

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Drawings' })
        .getByRole('listbox', { name: 'Views on this sheet' })
        .getByRole('option', { name: 'View A' })
    ).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  }
);
