import type { Page } from '@playwright/test';
import {
  enterCommandValue,
  expect,
  finishInPlaceCommand,
  stubApi,
  test,
  bodyCardFromHistory
} from './openzcad-fixtures';

/**
 * Production QA CAD-004 (2026-10-11), ROADMAP F05: in an inch project the Box
 * form refused `1 in + 25.4 mm` and `50.8 mm`, saying the field did not know
 * the document's units. A primitive size is a length in the document's units
 * from the entry preview through the committed build, undo/redo, reload and
 * STEP export; an angle typed into it is refused by its dimension. A new box
 * runs in place (U09), so its sizes are typed on their chips' keypad.
 */
function keypadOf(page: Page) {
  return page.locator('.numeric-keypad');
}

async function createInchProject(page: Page, name: string) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByLabel('Units').selectOption('inch');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(name);
}

async function bodyReadout(page: Page) {
  const inspector = await bodyCardFromHistory(page);
  await expect(inspector.getByText(/in³/).first()).toBeVisible();
  return inspector;
}

test('sizes a box with mixed-unit expressions in an inch project, through undo, reload and STEP', async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await createInchProject(page, 'QA imperial expressions');

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const keypad = keypadOf(page);
  const entry = keypad.locator('input');
  await page.getByTestId('command-handle-width').click();
  await entry.fill('1 in + 25.4 mm');
  await expect(entry).toHaveAttribute('aria-invalid', 'false');
  await expect(keypad.locator('.keypad-expr-preview')).toHaveText(/^= 2 /);
  await entry.press('Enter');
  await expect(keypad).toHaveCount(0);
  await page.getByTestId('command-handle-depth').click();
  await entry.fill('50.8 mm');
  await expect(keypad.locator('.keypad-expr-preview')).toHaveText(/^= 2 /);
  await entry.fill('25.4 mm');
  await entry.press('Enter');
  await expect(keypad).toHaveCount(0);
  await enterCommandValue(page, 'height', '0.5');
  await testInfo.attach('imperial-expression-form', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  await finishInPlaceCommand(page, 'Box');
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('warnings0', { timeout: 30_000 });

  let readout = await bodyReadout(page);
  await expect(readout).toContainText('2 × 1 × 0.5 in');
  await expect(readout).toContainText(/1 in³/);
  await page.keyboard.press('Escape');

  // Undo removes the box; redo restores the same size.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.body-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  readout = await bodyReadout(page);
  await expect(readout).toContainText('2 × 1 × 0.5 in');
  await page.keyboard.press('Escape');

  // Reopen: the stored expressions rebuild the same body. Reload only once
  // the redone state is saved, as a person closing the tab would.
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page.reload();
  await expect(status).toContainText('warnings0', { timeout: 30_000 });
  readout = await bodyReadout(page);
  await expect(readout).toContainText('2 × 1 × 0.5 in');
  await page.keyboard.press('Escape');

  // STEP is written in millimetres: 2 × 1 × 0.5 in is 50.8 × 25.4 × 12.7.
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await menu.getByRole('button', { name: /Export STEP/ }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of await (await download).createReadStream())
    chunks.push(chunk as Buffer);
  const step = Buffer.concat(chunks).toString('utf8');
  expect(step).toContain('SI_UNIT(.MILLI.,.METRE.)');
  // `#18 = CARTESIAN_POINT('', (0., 0., 1.26999999999999957E1));`
  const coordinates = [
    ...step.matchAll(/CARTESIAN_POINT\('[^']*',\s*\(([^)]*)\)\)/g)
  ].map((match) => match[1]!.split(',').map((value) => Number(value)));
  expect(coordinates.length).toBeGreaterThan(0);
  const extent = (axis: number) =>
    Math.max(...coordinates.map((point) => point[axis]!)) -
    Math.min(...coordinates.map((point) => point[axis]!));
  expect(extent(0)).toBeCloseTo(50.8, 6);
  expect(extent(1)).toBeCloseTo(25.4, 6);
  expect(extent(2)).toBeCloseTo(12.7, 6);
  expect(errors).toEqual([]);
});

test('refuses an angle typed into a box size in an inch project', async ({
  page
}) => {
  await createInchProject(page, 'QA imperial refusal');
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const keypad = keypadOf(page);
  const entry = keypad.locator('input');
  await page.getByTestId('command-handle-width').click();
  await entry.fill('30 deg');
  await expect(entry).toHaveAttribute('aria-invalid', 'true');
  await expect(keypad.locator('.keypad-expr-preview')).toHaveText(
    /expected a length, not an angle or area/
  );
  // Enter refuses it; the width stays the one shown.
  await entry.press('Enter');
  await expect(keypad).toBeVisible();
  await entry.press('Escape');
  await expect(keypad).toHaveCount(0);
  await expect(page.getByTestId('command-handle-width')).toContainText('30');
  await expect(page.locator('.body-row')).toHaveCount(0);
});
