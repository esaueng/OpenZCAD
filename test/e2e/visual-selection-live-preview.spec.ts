import { expect, test, stubApi } from './openzcad-fixtures';

// Streamed preview frames arrive much later on the 2-core CI runners under
// SwiftShader than on a workstation. Budgets are upper bounds, not waits.
const PREVIEW_BUDGET_MS = process.env.CI ? 60_000 : 30_000;

test('streams exact planar previews and restores invalid or canceled offsets', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Planar Live Preview');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const selectTopCap = () =>
    canvas.evaluate((element) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: { surface: 'top-cap' }
        })
      );
    });
  const readAxisLength = () =>
    canvas.evaluate(
      (element) =>
        new Promise<number | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: {
                surface: 'wall',
                select: false,
                resolve: (geometry: {
                  axisStart?: { x: number; y: number; z: number };
                  axisEnd?: { x: number; y: number; z: number };
                } | null) => {
                  if (!geometry?.axisStart || !geometry.axisEnd) {
                    resolve(null);
                    return;
                  }
                  resolve(
                    Math.hypot(
                      geometry.axisEnd.x - geometry.axisStart.x,
                      geometry.axisEnd.y - geometry.axisStart.y,
                      geometry.axisEnd.z - geometry.axisStart.z
                    )
                  );
                }
              }
            })
          );
        })
    );

  await expect
    .poll(
      async () => {
        await selectTopCap();
        return canvas.getAttribute('data-e2e-handle-x');
      },
      { timeout: 120_000 }
    )
    .not.toBeNull();
  const chip = page.getByTestId('direct-manipulation-value');
  await expect(chip).toHaveText('Total 28 mm');
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  expect(Object.values(handle).every(Number.isFinite)).toBe(true);
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const start = { x: bounds!.x + handle.x, y: bounds!.y + handle.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 2,
    start.y + handle.dy * handle.pixelsPerUnit * 2,
    { steps: 1 }
  );
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(30, 4);
  // A second pointer value after the first exact frame must replace it rather
  // than leaving the coalescer stuck on the first sample. Offset-face runs with
  // continueAfterSlow false, so a rebuild over the slow-frame budget instead
  // pauses previewing for the rest of the gesture and says so on the chip --
  // routine on the 2-core CI runners. Both outcomes are correct; silently
  // holding the first sample is the regression worth catching.
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 5,
    start.y + handle.dy * handle.pixelsPerUnit * 5,
    { steps: 1 }
  );
  const secondSample = async () => {
    if ((await chip.getAttribute('data-state')) === 'deferred') {
      return 'paused';
    }
    const length = await readAxisLength();
    return length !== null && Math.abs(length - 33) < 5e-5
      ? 'advanced'
      : 'stale';
  };
  await expect
    .poll(secondSample, { timeout: PREVIEW_BUDGET_MS })
    .not.toBe('stale');
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toContainText('Dragging');
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();

  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(28, 4);
  await expect(chip).toHaveText('Total 28 mm');
  await expect(chip).toHaveAttribute('data-state', 'ready');

  await chip.click();
  let keypad = page.getByRole('dialog', { name: 'Total value' });
  await keypad.getByRole('textbox').fill('-1');
  const apply = keypad.getByRole('button', { name: 'Apply total' });
  await expect(apply).toBeDisabled({ timeout: PREVIEW_BUDGET_MS });
  await expect(keypad.getByRole('alert')).toBeVisible();
  await expect(chip).toHaveAttribute('data-state', 'warning');
  await expect(chip).toContainText('⚠ Total -1 mm');
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(28, 4);
  await page.keyboard.press('Escape');
  await expect(keypad).toBeHidden();
  await expect(chip).toHaveText('Total 28 mm');
  await expect(chip).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();

  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Total value' });
  await keypad.getByRole('textbox').fill('35.7');
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(35.7, 4);
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
  await expect(keypad.getByRole('button', { name: 'Apply total' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await keypad.getByRole('button', { name: 'Apply total' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cylinder height set to 35.7 mm.'
  );
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(35.7, 4);
  expect(consoleErrors).toEqual([]);
});
