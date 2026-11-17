import type { Download, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * D02 title-block layouts (schema v94): a sheet switched to the shop
 * layout prints its material and general tolerances in a taller block, in
 * the preview and the PDF, and keeps them through a reload.
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

test(
  'prints the shop title block with its material and tolerances',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Import target');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    const document = addPrimitiveFeature(
      createProjectDocument('Bracket', toUserId('test')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 20, depth: 10 }
      }
    );
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'bracket.openzcad',
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
    ).toContainText('Bracket');

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(canvas.locator('.drawing-texts')).toContainText('DWG NO.', {
      timeout: 30_000
    });
    await expect(canvas.locator('.drawing-texts')).not.toContainText(
      'MATERIAL'
    );

    const panel = drawings.getByRole('complementary', {
      name: 'Drawing properties'
    });
    await panel.getByLabel('Layout').selectOption('shop');
    const material = panel.getByRole('textbox', {
      name: 'Material',
      exact: true
    });
    await material.fill('6061-T6 aluminium');
    await material.press('Enter');
    const tolerances = panel.getByRole('textbox', {
      name: 'General tolerances',
      exact: true
    });
    await tolerances.fill('UNLESS STATED ±0.1 mm');
    await tolerances.press('Enter');
    const texts = canvas.locator('.drawing-texts');
    await expect(texts).toContainText('MATERIAL');
    await expect(texts).toContainText('6061-T6 aluminium');
    await expect(texts).toContainText('GENERAL TOLERANCES');
    await expect(texts).toContainText('UNLESS STATED ±0.1 mm');

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export PDF' }).click();
    const pdf = (await readDownload(await downloadPromise)).toString('latin1');
    expect(pdf).toContain('(6061-T6 aluminium) Tj');
    expect(pdf).toContain('(GENERAL TOLERANCES) Tj');

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(reopened.locator('.drawing-texts')).toContainText(
      '6061-T6 aluminium',
      { timeout: 30_000 }
    );
    expect(errors).toEqual([]);
  }
);
