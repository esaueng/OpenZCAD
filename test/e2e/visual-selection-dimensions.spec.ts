import { expect, test, stubApi } from './openzcad-fixtures';

test('round-trips diameter entry and edits a cylinder cap by total height', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  // At this width the top-cap anchor used to land under the floating
  // inspector, leaving the Total chip visible only as an unclickable sliver.
  await page.setViewportSize({ width: 1200, height: 800 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Dimension Labels');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const selectCylinderSurface = async (surface: 'wall' | 'top-cap') => {
    await canvas.evaluate((element, requestedSurface) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: { surface: requestedSurface }
        })
      );
    }, surface);
  };
  const readWallGeometry = (select = true) =>
    canvas.evaluate(
      (element, shouldSelect) =>
        new Promise<{
          radius?: number;
          diameter?: number;
          surfaceType: string;
          axisStart?: { x: number; y: number; z: number };
          axisEnd?: { x: number; y: number; z: number };
        } | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: { surface: 'wall', select: shouldSelect, resolve }
            })
          );
        }),
      select
    );
  const readCylinderHeight = async () => {
    const geometry = await readWallGeometry(false);
    if (!geometry?.axisStart || !geometry.axisEnd) {
      return null;
    }
    return Math.hypot(
      geometry.axisEnd.x - geometry.axisStart.x,
      geometry.axisEnd.y - geometry.axisStart.y,
      geometry.axisEnd.z - geometry.axisStart.z
    );
  };

  await expect
    .poll(async () => (await readWallGeometry())?.diameter)
    .toBeCloseTo(28, 5);
  const valueChip = page.getByTestId('direct-manipulation-value');
  await expect(valueChip).toHaveText('Ø 28 mm');

  await page.getByRole('button', { name: 'Switch to radius entry' }).click();
  await expect(valueChip).toHaveText('R 14 mm');
  await page.getByRole('button', { name: 'Switch to diameter entry' }).click();
  await expect(valueChip).toHaveText('Ø 28 mm');

  await page.locator('.handle-label-chip').click();
  const radialKeypad = page.getByRole('dialog');
  await expect(radialKeypad).toHaveAccessibleName('Diameter value');
  await radialKeypad.getByRole('radio', { name: 'R Radius' }).click();
  await expect(radialKeypad).toHaveAccessibleName('Radius value');
  await expect(radialKeypad.getByRole('textbox')).toHaveValue('14');
  await radialKeypad.getByRole('radio', { name: 'Ø Diameter' }).click();
  await expect(radialKeypad).toHaveAccessibleName('Diameter value');
  await expect(radialKeypad.getByRole('textbox')).toHaveValue('28');
  await radialKeypad.getByRole('textbox').fill('Ø17.4');
  await radialKeypad.getByRole('button', { name: 'Apply diameter' }).click();
  await expect(radialKeypad).toBeHidden();
  await expect
    .poll(async () => (await readWallGeometry())?.diameter)
    .toBeCloseTo(17.4, 5);

  await selectCylinderSurface('top-cap');
  await expect(valueChip).toHaveText('Total 28 mm');
  await valueChip.click();
  const totalKeypad = page.getByRole('dialog', { name: 'Total value' });
  await totalKeypad.getByRole('textbox').fill('35.7');
  await expect(valueChip).toHaveText('Total 35.7 mm');
  // The value chip updates immediately, before the exact preview replaces the
  // rendered body and rebuilds its handle. Prove that replacement has landed
  // before checking that the dimension survived it.
  await expect.poll(readCylinderHeight).toBeCloseTo(35.7, 5);
  await expect(canvas).toHaveAttribute(
    'data-e2e-offset-dimension-visible',
    'true'
  );
  await totalKeypad.getByRole('button', { name: 'Apply total' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cylinder height set to 35.7 mm.'
  );
  await expect(
    page.locator('.feature-row', { hasText: 'Offset Face' })
  ).toHaveCount(0);
  await expect.poll(readCylinderHeight).toBeCloseTo(35.7, 5);
  expect(consoleErrors).toEqual([]);
});
