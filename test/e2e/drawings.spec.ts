import type { Download, Locator, Page } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * D01: a drawing sheet with the four-view starter, view placement, the scale
 * transform, PDF and SVG export, and the model fence — an edited model makes
 * the sheet stale and refuses export until an explicit Update.
 */

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function inspectorOf(page: Page) {
  return page.getByRole('region', { name: 'Feature inspector' });
}

function mode(page: Page, name: 'Build' | 'Draw') {
  return page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name, exact: true });
}

async function viewCentreX(panel: Locator): Promise<number> {
  return Number(await panel.getByLabel('Centre X (mm)').inputValue());
}

test('lays out, places, exports and fences a drawing sheet', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Drawing sheet');
  await page.getByRole('button', { name: 'Create project' }).click();

  const inspector = inspectorOf(page);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Width (X)').fill('30');
  await inspector.getByLabel('Depth (Y)').fill('20');
  await inspector.getByLabel('Height (Z)').fill('10');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  await mode(page, 'Draw').click();
  const drawings = page.getByRole('region', { name: 'Drawings' });
  await drawings.getByRole('button', { name: 'New drawing sheet' }).click();

  // The starter: front, top, a side view and the isometric, all drawn.
  const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
  for (const orientation of ['front', 'top', 'left', 'iso'])
    await expect(
      canvas.locator(`[data-view="${orientation}"]:not(.is-placeholder)`)
    ).toHaveCount(1, { timeout: 20_000 });
  await expect(
    canvas.locator('.drawing-strokes.is-visible polyline').first()
  ).toBeAttached();
  await expect(canvas.locator('.drawing-texts')).toContainText('Drawing sheet');
  await expect(canvas.locator('.drawing-texts')).toContainText('First angle');

  // Placement: the front view moves by field and by arrow key, and the top
  // view projected from it keeps its column.
  const panel = drawings.getByRole('complementary', {
    name: 'Drawing properties'
  });
  await canvas.getByRole('button', { name: 'Front view' }).click();
  await panel.getByLabel('Centre X (mm)').fill('120');
  await panel.getByLabel('Centre X (mm)').press('Enter');
  await expect.poll(() => viewCentreX(panel)).toBe(120);
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => viewCentreX(panel)).toBe(121);
  await canvas.getByRole('button', { name: 'Top view' }).click();
  await expect.poll(() => viewCentreX(panel)).toBe(121);

  // Scale: 1:2 halves the drawn span through the shared page transform.
  const frontBox = canvas.locator('[data-view="front"] .drawing-view-hit');
  const scale = panel.getByLabel('Scale');
  const initial = await scale.inputValue();
  // The hit box pads 3 mm each side around the drawn span.
  const span = async () => Number(await frontBox.getAttribute('width')) - 6;
  await scale.selectOption('1:1');
  await expect.poll(span).toBeCloseTo(30, 3);
  await scale.selectOption('1:2');
  await expect.poll(span).toBeCloseTo(15, 3);
  await scale.selectOption(initial);

  // A plain box hides nothing face-on; the isometric hides its far corner
  // once its hidden lines are switched on.
  await canvas.getByRole('button', { name: 'Isometric view' }).click();
  await panel.getByLabel('Hidden lines').check();
  await expect(
    canvas.locator('.drawing-strokes.is-hidden polyline')
  ).toHaveCount(3, {
    timeout: 20_000
  });

  // Export: a vector PDF on A3 and an SVG in millimetres.
  let downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'PDF', exact: true }).click();
  let download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Drawing-sheet-Sheet-1.pdf');
  const pdf = (await readDownload(download)).toString('latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf).toContain('/MediaBox [0 0 1190.551 841.89]');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Exported the drawing to Drawing-sheet-Sheet-1.pdf.'
  );
  downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'SVG', exact: true }).click();
  download = await downloadPromise;
  const svg = (await readDownload(download)).toString('utf8');
  expect(svg).toContain('width="420mm" height="297mm"');
  expect(svg).toContain(
    '<g class="hidden" fill="none" stroke="#000000" stroke-width="0.25"'
  );
  expect(svg).toContain('stroke-dasharray="3 1.5"');

  // The fence: widen the box in Build, and the sheet goes stale.
  await mode(page, 'Build').click();
  await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
  await inspector.getByRole('textbox', { name: 'Width (X)' }).fill('45');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edited Box');
  await mode(page, 'Draw').click();
  const banner = drawings.getByRole('status');
  await expect(banner).toContainText(
    'The model changed since this sheet was drawn',
    {
      timeout: 20_000
    }
  );
  await expect(
    panel.getByRole('button', { name: 'PDF', exact: true })
  ).toBeDisabled();
  await expect(canvas.locator('.drawing-view.is-placeholder')).toHaveCount(4);

  await banner.getByRole('button', { name: 'Update' }).click();
  await expect(banner).toHaveCount(0);
  await expect(
    panel.getByRole('button', { name: 'PDF', exact: true })
  ).toBeEnabled({
    timeout: 20_000
  });
  await expect(canvas.locator('.drawing-view.is-placeholder')).toHaveCount(0);

  // Undo in the Drawing workspace takes back the sheet's own Update: stale
  // again. The model edit underneath it is Build's and stays.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(banner).toContainText(
    'The model changed since this sheet was drawn'
  );

  // Reopen: the sheet and its placement come back from the saved document.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(banner).toHaveCount(0);
  // The redo must reach the device store before the tab goes away.
  await expect(page.locator('.save-state')).toHaveClass(/is-(synced|local)\b/);
  await page.reload();
  const reopened = page.getByRole('region', { name: 'Drawings' });
  await expect(
    reopened.getByRole('application', { name: 'Sheet Sheet 1' })
  ).toBeVisible({
    timeout: 30_000
  });
  await reopened
    .getByRole('application', { name: 'Sheet Sheet 1' })
    .getByRole('button', { name: 'Front view' })
    .click();
  await expect
    .poll(() =>
      viewCentreX(
        reopened.getByRole('complementary', { name: 'Drawing properties' })
      )
    )
    .toBe(121);
  await expect(reopened.getByRole('status')).toHaveCount(0);
});

test('refuses a parameter-only undo or redo in the Draw workspace', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Draw undo guard');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('New parameter name').fill('w');
  await page.getByLabel('New parameter expression').fill('30');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.locator('.param-row')).toContainText('w');

  // The newest history entry only sets a parameter; Draw edits sheets only.
  await mode(page, 'Draw').click();
  await expect(page.getByRole('region', { name: 'Drawings' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cannot undo: Draw mode edits drawing sheets only'
  );
  await mode(page, 'Build').click();
  await expect(page.locator('.param-row')).toContainText('w');
});
