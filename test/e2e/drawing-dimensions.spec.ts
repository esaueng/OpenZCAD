import type { Download, Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

/**
 * D02: dimensions and notes on a drawing view. A dimension is picked from
 * the view's edges, reads its value from the model, exports with the sheet,
 * follows the sheet's stale/Update fence after a model edit, and comes back
 * from the saved document after a reload.
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

/**
 * The front view's drawn extent on screen: its hit box pads the projected
 * extent by 3 mm a side, and its width attribute is in paper millimetres.
 */
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

test('dimensions a drawing view from the model and follows its Update', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Dimensioned');
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
  const panel = drawings.getByRole('complementary', {
    name: 'Drawing properties'
  });
  await expect(
    canvas.locator('[data-view="front"]:not(.is-placeholder)')
  ).toHaveCount(1, { timeout: 20_000 });
  const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });

  // Horizontal: the front view's top edge picked away from its ends is
  // dimensioned whole; the next click places the text above it.
  let front = await frontViewBox(canvas);
  await tools.getByRole('button', { name: 'Horizontal' }).click();
  await page.mouse.click(front.centreX, front.top);
  await page.mouse.click(front.centreX, front.top - 12 * front.pxPerMm);
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension 30' })
  ).toBeVisible();
  await expect(canvas.locator('.drawing-texts')).toContainText('30');

  // Vertical, on the right edge, placed to its right.
  await tools.getByRole('button', { name: 'Vertical' }).click();
  await page.mouse.click(front.right, front.centreY);
  await page.mouse.click(front.right + 12 * front.pxPerMm, front.centreY);
  await expect(
    canvas.getByRole('button', { name: 'Vertical dimension 10' })
  ).toBeVisible();

  // A note with a leader to the left edge, then its text typed.
  await tools.getByRole('button', { name: 'Note' }).click();
  await page.mouse.click(front.left, front.centreY);
  await page.mouse.click(
    front.left - 30 * front.pxPerMm,
    front.bottom + 15 * front.pxPerMm
  );
  const text = panel.getByLabel('Text');
  await text.fill('BREAK SHARP EDGES');
  await text.press('Enter');
  await expect(canvas.locator('.drawing-texts')).toContainText(
    'BREAK SHARP EDGES'
  );
  await expect(
    canvas.locator('.drawing-strokes.is-dimension polygon.is-filled')
  ).not.toHaveCount(0);

  // Delete and undo: the dimension comes back with its value.
  await canvas.getByRole('button', { name: 'Vertical dimension 10' }).click();
  await page.keyboard.press('Delete');
  await expect(
    canvas.getByRole('button', { name: 'Vertical dimension 10' })
  ).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(
    canvas.getByRole('button', { name: 'Vertical dimension 10' })
  ).toBeVisible();

  // Export: the dimensions and note are in the SVG and the PDF.
  let downloadPromise = page.waitForEvent('download');
  await drawings.getByRole('button', { name: 'Export SVG' }).click();
  const svg = (await readDownload(await downloadPromise)).toString('utf8');
  expect(svg).toContain('<g class="dimension"');
  expect(svg).toMatch(/>30<\/text>/);
  expect(svg).toMatch(/>10<\/text>/);
  expect(svg).toContain('>BREAK SHARP EDGES</text>');
  downloadPromise = page.waitForEvent('download');
  await drawings.getByRole('button', { name: 'Export PDF' }).click();
  const pdf = (await readDownload(await downloadPromise)).toString('latin1');
  expect(pdf).toContain('(30) Tj');
  expect(pdf).toContain('(BREAK SHARP EDGES) Tj');

  // Widen the box: the sheet goes stale but keeps its drawing, dimensions
  // read from the model it was drawn from, until the explicit Update reads
  // the new one.
  await mode(page, 'Build').click();
  await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
  await inspector.getByRole('textbox', { name: 'Width (X)' }).fill('45');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edited Box');
  await mode(page, 'Draw').click();
  const outdated = drawings.locator('.drawing-sync.is-outdated');
  await expect(outdated).toContainText(
    'The model changed since this sheet was drawn',
    { timeout: 20_000 }
  );
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension 30' })
  ).toBeVisible();
  await expect(
    drawings.getByRole('button', { name: 'Export PDF' })
  ).toBeEnabled();
  await outdated.getByRole('button', { name: 'Update' }).click();
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension 45' })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    canvas.getByRole('button', { name: 'Vertical dimension 10' })
  ).toBeVisible();

  // Reopen: placement and references come back from the saved document.
  await expect(page.locator('.save-state')).toHaveClass(/is-(synced|local)\b/);
  await page.reload();
  const reopened = page
    .getByRole('region', { name: 'Drawings' })
    .getByRole('application', { name: 'Sheet Sheet 1' });
  await expect(
    reopened.getByRole('button', { name: 'Horizontal dimension 45' })
  ).toBeVisible({ timeout: 30_000 });
  await expect(reopened.locator('.drawing-texts')).toContainText(
    'BREAK SHARP EDGES'
  );
  front = await frontViewBox(reopened);
  expect(front.right - front.left).toBeGreaterThan(0);
});
