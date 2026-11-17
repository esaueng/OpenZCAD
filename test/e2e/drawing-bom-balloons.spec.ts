import type { Download, Page } from '@playwright/test';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * D02 parts lists and balloons (schema v80): on an assembly's drawing, the
 * Parts list tool places the AS03 BOM table on the paper and the Balloon
 * tool names a picked part's item number; both export and reopen.
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

/** A plate assembled with a copy-free single part: one BOM row. */
function assembledPlate() {
  const manager = new CommandManager(
    createProjectDocument('Plate assembly', toUserId('test'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 10, depth: 20 }
    })
  );
  const plate = manager.document.bodyOrder[0] as BodyId;
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        {
          componentId: 'comp_plate',
          name: 'Plate',
          bodyId: plate,
          grounded: true
        }
      ]
    })
  );
  return manager.document;
}

test(
  'lists an assembly’s parts on its drawing and balloons a part',
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
      name: 'assembly.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: assembledPlate(),
          files: []
        })
      )
    });
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Plate assembly');

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      canvas.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });

    // The parts list, placed by one click near the paper's top left.
    await tools.getByRole('button', { name: 'Parts list' }).click();
    // Above the front view's top-left corner, on the paper.
    const front = canvas.locator('[data-view="front"] .drawing-view-hit');
    const frontBox = (await front.boundingBox())!;
    await page.mouse.click(frontBox.x, frontBox.y - 0.25 * frontBox.height);
    await expect(
      canvas.getByRole('button', { name: 'Parts list' })
    ).toBeVisible();
    const texts = canvas.locator('.drawing-texts');
    await expect(texts).toContainText('Item');
    await expect(texts).toContainText('Plate Body');

    // A balloon on the front view's top edge, placed above it.
    await tools.getByRole('button', { name: 'Balloon' }).click();
    const hit = canvas.locator('[data-view="front"] .drawing-view-hit');
    const box = (await hit.boundingBox())!;
    const pxPerMm = box.width / Number(await hit.getAttribute('width'));
    const top = box.y + 3 * pxPerMm;
    await page.mouse.click(box.x + box.width / 2, top);
    await page.mouse.click(
      box.x + box.width / 2 + 15 * pxPerMm,
      top - 15 * pxPerMm
    );
    await expect(
      canvas.getByRole('button', { name: 'Balloon 1' })
    ).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toContain('>Item</text>');
    expect(svg).toContain('>Plate Body</text>');

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      reopened.getByRole('button', { name: 'Balloon 1' })
    ).toBeVisible({
      timeout: 30_000
    });
    await expect(
      reopened.getByRole('button', { name: 'Parts list' })
    ).toBeVisible();
    expect(errors).toEqual([]);
  }
);
