import type { Download, Page } from '@playwright/test';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * AS03 exploded drawing views (schema v113): a drawing's front view, set to
 * Exploded, draws the pin where Assemble pulls it out, takes a balloon but
 * refuses a dimension, exports, and reopens exploded.
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

/** A plate and a pin, the pin's stored exploded offset 60 mm along +X. */
function pulledOutPin() {
  const manager = new CommandManager(
    createProjectDocument('Pin assembly', toUserId('test'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 10, depth: 20 }
    })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Pin',
      primitiveKind: 'box',
      // As deep as the plate, so its top edge is the front view's top.
      dimensions: { width: 6, height: 10, depth: 20 }
    })
  );
  const [plate, pin] = manager.document.bodyOrder as [BodyId, BodyId];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        {
          componentId: 'c_plate',
          name: 'Plate',
          bodyId: plate,
          grounded: true
        },
        { componentId: 'c_pin', name: 'Pin', bodyId: pin, grounded: false }
      ]
    })
  );
  manager.execute(
    commandFactories.setAssemblyExplode({
      offsets: { c_pin: { x: 60, y: 0, z: 0 } }
    })
  );
  return manager.document;
}

test(
  'draws an assembly view exploded, balloons it and reopens it',
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
          document: pulledOutPin(),
          files: []
        })
      )
    });
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Pin assembly');

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    const front = canvas.locator(
      '[data-view="front"]:not(.is-placeholder) .drawing-view-hit'
    );
    await expect(front).toHaveCount(1, { timeout: 30_000 });
    // The hit box pads 3 mm each side around the drawn span, in paper mm.
    const span = async () => Number(await front.getAttribute('width')) - 6;
    const assembled = await span();

    const panel = drawings.getByRole('complementary', {
      name: 'Drawing properties'
    });
    // The sheet's scale, read while no view is selected (the sheet panel).
    const [num, den] = (await panel.getByLabel('Scale').inputValue())
      .split(':')
      .map(Number) as [number, number];
    await front.click();
    await panel.getByLabel('Exploded').check();
    // Both boxes start at the origin corner, so the 6 mm pin sat inside
    // the 40 mm plate's span. Pulled 60 mm along X it reaches 66 mm.
    expect(assembled).toBeCloseTo((40 * num) / den, 1);
    await expect
      .poll(span, { timeout: 30_000 })
      .toBeCloseTo((66 * num) / den, 1);
    // The toggle kept the sheet current: no Update is asked for.
    await expect(drawings.locator('.drawing-sync.is-outdated')).toHaveCount(0);

    // A dimension is refused on it, with the reason; a balloon is not.
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });
    // Measured after each tool is chosen: choosing one can refit the sheet.
    const pinTop = async () => {
      const box = (await front.boundingBox())!;
      const pxPerMm = box.width / Number(await front.getAttribute('width'));
      return {
        x: box.x + box.width - 6 * pxPerMm,
        y: box.y + 3 * pxPerMm,
        pxPerMm
      };
    };
    await tools.getByRole('button', { name: 'Horizontal' }).click();
    let at = await pinTop();
    await page.mouse.click(at.x, at.y);
    await expect(page.getByRole('contentinfo')).toContainText(
      'An exploded view takes notes and balloons only'
    );
    await page.keyboard.press('Escape');
    await tools.getByRole('button', { name: 'Balloon' }).click();
    at = await pinTop();
    await page.mouse.click(at.x, at.y);
    await page.mouse.click(at.x, at.y - 15 * at.pxPerMm);
    await expect(
      canvas.getByRole('button', { name: 'Balloon 2' })
    ).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toContain('>2</text>');

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    const explodedSpan = await span();
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      reopened.getByRole('button', { name: 'Balloon 2' })
    ).toBeVisible({ timeout: 30_000 });
    const reopenedFront = reopened.locator(
      '[data-view="front"]:not(.is-placeholder) .drawing-view-hit'
    );
    await expect
      .poll(async () => Number(await reopenedFront.getAttribute('width')) - 6)
      .toBeCloseTo(explodedSpan, 3);
    await reopenedFront.click();
    await expect(
      page
        .getByRole('complementary', { name: 'Drawing properties' })
        .getByLabel('Exploded')
    ).toBeChecked();
    expect(errors).toEqual([]);
  }
);
