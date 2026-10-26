import type { Download, Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi,
  selectBodyFromObjects
} from './openzcad-fixtures';

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

function mode(page: Page, name: 'View' | 'Build' | 'Draw') {
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
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '30', depth: '20', height: '10' }
  });
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
  // The reopened model rebuilds before the sheet can read ready; headless
  // runs stall seconds on first open, past the default 5 s.
  await expect(reopened.getByRole('status')).toHaveCount(0, {
    timeout: 30_000
  });
});

async function exportSheet(
  page: Page,
  panel: Locator
): Promise<{ pdf: Buffer; svg: Buffer }> {
  const bytes: Buffer[] = [];
  for (const format of ['PDF', 'SVG']) {
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: format, exact: true }).click();
    bytes.push(await readDownload(await downloadPromise));
  }
  return { pdf: bytes[0]!, svg: bytes[1]! };
}

test('exports the same bytes after a reload re-meshes the model', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Drawing bytes');
  await page.getByRole('button', { name: 'Create project' }).click();

  // A broad, thin disc: its rim is faceted by the chordal deflection, not
  // the angular limit, so a different deflection samples it differently.
  const inspector = inspectorOf(page);
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '20', height: '4' }
  });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Cylinder' })
  ).toBeVisible();
  // Edit only once the creation has rebuilt: an edit opened against the
  // rebuilding model is refused ("The model changed").
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Rebuilding geometry|Exact geometry is still rebuilding/i,
    { timeout: 60_000 }
  );
  // R20 → R21 stays inside the display mesh's held-deflection band, so this
  // session keeps meshing the disc at the R20 value; a reload meshes it at
  // the R21 nominal value.
  await page.locator('.feature-row-main', { hasText: 'Cylinder' }).click();
  await inspector
    .getByRole('textbox', { name: 'Radius', exact: true })
    .fill('21');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edited Cylinder');

  await mode(page, 'Draw').click();
  const drawings = page.getByRole('region', { name: 'Drawings' });
  await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
  const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
  const panel = drawings.getByRole('complementary', {
    name: 'Drawing properties'
  });
  await canvas.getByRole('button', { name: 'Isometric view' }).click();
  await panel.getByLabel('Hidden lines').check();
  await expect(canvas.locator('.drawing-view.is-placeholder')).toHaveCount(0, {
    timeout: 20_000
  });
  await expect(
    canvas.locator('.drawing-strokes.is-hidden polyline').first()
  ).toBeAttached();
  const before = await exportSheet(page, panel);

  await expect(page.locator('.save-state')).toHaveClass(/is-(synced|local)\b/);
  await page.reload();
  const reopened = page.getByRole('region', { name: 'Drawings' });
  const reopenedCanvas = reopened.getByRole('application', {
    name: 'Sheet Sheet 1'
  });
  await expect(reopenedCanvas).toBeVisible({ timeout: 30_000 });
  // The reopened model rebuilds before the sheet can read ready; headless
  // runs stall seconds on first open, past the default 5 s.
  await expect(reopened.getByRole('status')).toHaveCount(0, {
    timeout: 30_000
  });
  await expect(
    reopenedCanvas.locator('.drawing-view.is-placeholder')
  ).toHaveCount(0, { timeout: 30_000 });
  const reopenedPanel = reopened.getByRole('complementary', {
    name: 'Drawing properties'
  });
  await expect(
    reopenedPanel.getByRole('button', { name: 'PDF', exact: true })
  ).toBeEnabled();
  const after = await exportSheet(page, reopenedPanel);
  expect(after.svg.toString('utf8')).toBe(before.svg.toString('utf8'));
  expect(after.pdf.equals(before.pdf)).toBe(true);
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

test('refuses a drawing-only undo in the View workspace', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('View undo guard');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await mode(page, 'Draw').click();
  const drawings = page.getByRole('region', { name: 'Drawings' });
  await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
  await expect(
    drawings.getByRole('application', { name: 'Sheet Sheet 1' })
  ).toBeVisible();

  // The newest entry adds the sheet; View is read-only for sheets too.
  await mode(page, 'View').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByRole('contentinfo')).toContainText('Cannot undo');
  await mode(page, 'Draw').click();
  await expect(
    drawings.getByRole('application', { name: 'Sheet Sheet 1' })
  ).toBeVisible();
});

test('starts a sheet from the bodies on screen, not the export scope', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Drawing scope');
  await page.getByRole('button', { name: 'Create project' }).click();
  for (const name of ['Lower', 'Upper']) {
    await createPrimitiveInPlace(page, 'box', { name: name });
    await expect(
      page.locator('.feature-row-main', { hasText: name })
    ).toBeVisible();
  }
  // Hide Upper. A new drawing shows the visible bodies regardless of the
  // selected body used by model exports.
  await selectBodyFromObjects(page, 'Upper');
  await page
    .locator('.body-row', { hasText: 'Upper' })
    .getByRole('button', { name: /^Hide body / })
    .click();
  await expect(page.locator('.body-row.hidden-body')).toHaveCount(1);
  await mode(page, 'Draw').click();
  const drawings = page.getByRole('region', { name: 'Drawings' });
  await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
  await drawings
    .getByRole('application', { name: 'Sheet Sheet 1' })
    .getByRole('button', { name: 'Front view' })
    .click();
  const bodies = drawings.getByRole('group', { name: 'Bodies' });
  await expect(bodies.getByRole('checkbox', { name: /^Lower/ })).toBeChecked();
  await expect(
    bodies.getByRole('checkbox', { name: /^Upper/ })
  ).not.toBeChecked();
});
