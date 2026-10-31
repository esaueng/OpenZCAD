import type { Download, Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  expect,
  finishInPlaceCommand,
  openMoveOptions,
  pickObjectsBody,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * D03: a section view drawn from a line across the front view of a bored
 * plate, dragged into place along its arrows, hatched, dimensioned on its
 * own cut edge (the bore, a circle only the section has), exported, and
 * reopened from the saved document.
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
  'cuts a section view from a line across the front view',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Sectioned');
    await page.getByRole('button', { name: 'New project' }).click();

    // A 40 × 30 × 30 plate bored through by a Ø12 hole at (20, 15).
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '40', depth: '30', height: '30' },
      name: 'Plate'
    });
    await createPrimitiveInPlace(page, 'cylinder', {
      sizes: { radius: '6', height: '30' },
      name: 'Bore tool'
    });
    await expect(
      page.locator('.feature-row-main', { hasText: 'Bore tool' })
    ).toBeVisible();
    await page.getByRole('button', { name: /^Move \(M\)/ }).click();
    const move = page.getByRole('form', { name: 'Move controls' });
    await openMoveOptions(move);
    await move.getByLabel('Move X in mm').fill('20');
    await move.getByLabel('Move Y in mm').fill('15');
    await move.getByRole('button', { name: 'Done' }).click();
    await expect(
      page.locator('.feature-row', { hasText: 'Move' })
    ).toBeVisible();
    await page.getByRole('button', { name: /^Subtract \(X\)/ }).click();
    await pickObjectsBody(page, 'Plate 1');
    await pickObjectsBody(page, 'Bore tool 1');
    await finishInPlaceCommand(page, 'Subtract');
    await expect(
      page
        .locator('.feature-row', { hasText: 'Subtract' })
        .getByTitle('Feature failed to build')
    ).toHaveCount(0);

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', {
      name: 'Sheet Sheet 1'
    });
    await expect(
      canvas.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 20_000 });
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });

    // Across the bore: a drag sideways through the front view, a little off
    // its middle height so the line snaps onto it (z = 15).
    const front = await viewBox(canvas, 'front');
    await tools.getByRole('button', { name: 'Section view' }).click();
    const y = front.centreY + 0.6 * front.pxPerMm;
    await page.mouse.move(front.left + 2 * front.pxPerMm, y);
    await page.mouse.down();
    await page.mouse.move(front.centreX, y, { steps: 4 });
    await page.mouse.move(front.right - 2 * front.pxPerMm, y, { steps: 4 });
    await page.mouse.up();
    // Then into place above the front view, along the arrows.
    const placeY = front.top - 20 * front.pxPerMm;
    await page.mouse.move(front.centreX + 30, placeY, { steps: 6 });
    await expect(canvas.locator('.drawing-section-ghost')).toBeVisible();
    await page.mouse.click(front.centreX + 30, placeY);

    const section = canvas.locator(
      '[data-view="section-A"]:not(.is-placeholder)'
    );
    await expect(section).toHaveCount(1, { timeout: 20_000 });
    await expect(
      canvas.locator('.drawing-strokes.is-hatch polyline')
    ).not.toHaveCount(0);
    await expect(
      canvas.locator('.drawing-strokes.is-chain polyline')
    ).toHaveCount(1);
    await expect(canvas.locator('.drawing-texts')).toContainText('SECTION A-A');
    // Placed clear of the front view, the layout may run past the border:
    // fit the views, then check the section stayed in the front's column.
    await drawings.getByRole('button', { name: 'Fit views to sheet' }).click();
    const placed = await viewBox(canvas, 'section-A');
    const aligned = await viewBox(canvas, 'front');
    expect(Math.abs(placed.centreX - aligned.centreX)).toBeLessThan(1);
    expect(placed.bottom).toBeLessThan(aligned.top);
    await section.locator('.drawing-view-hit').click();
    const panel = drawings.getByRole('complementary', {
      name: 'Drawing properties'
    });
    await expect(panel.getByLabel('Cut at Z (mm)')).toHaveValue('15.0');
    await expect(panel).toContainText("The cut is the kernel's exact boolean");

    // A dimension on the section's own edge: the bore, cut square to its
    // axis, is a Ø12 circle at the section's middle.
    await tools.getByRole('button', { name: 'Diameter' }).click();
    await page.mouse.click(placed.centreX + 6 * placed.pxPerMm, placed.centreY);
    await page.mouse.click(
      placed.centreX + 20 * placed.pxPerMm,
      placed.top - 8 * placed.pxPerMm
    );
    const diameter = canvas.getByRole('button', {
      name: /^Diameter dimension .*12$/
    });
    await expect(diameter).toBeVisible();

    // Export: the hatch, the cutting-plane line and the caption are in both.
    let downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg).toContain('<g class="hatch"');
    expect(svg).toContain('<g class="chain"');
    expect(svg).toContain('>SECTION A-A</text>');
    downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export PDF' }).click();
    const pdf = (await readDownload(await downloadPromise)).toString('latin1');
    expect(pdf).toContain('(SECTION A-A) Tj');

    // Reopen: the section and its dimension come back from the document.
    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      reopened.getByRole('button', { name: /^Diameter dimension .*12$/ })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      reopened.locator('.drawing-strokes.is-hatch polyline')
    ).not.toHaveCount(0);
  }
);
