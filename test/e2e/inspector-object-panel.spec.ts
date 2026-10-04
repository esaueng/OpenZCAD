import { DEFAULT_APP_SETTINGS } from '@openzcad/shared';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

for (const directManipulation of [true, false]) {
  test(`inferred objects require Edit with direct manipulation ${directManipulation ? 'on' : 'off'}`, async ({
    page
  }) => {
    await stubApi(page);
    await page.addInitScript(
      ({ defaults, enabled }) => {
        localStorage.setItem(
          'openzcad-app-settings:v1',
          JSON.stringify({
            ...defaults,
            experiments: {
              ...defaults.experiments,
              directManipulation: enabled
            }
          })
        );
      },
      { defaults: DEFAULT_APP_SETTINGS, enabled: directManipulation }
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await createProject(page, 'Object inspector');
    await expect(page).toHaveTitle(/OpenZCAD/);
    await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    await inspector.getByLabel('Radius', { exact: true }).fill('14');
    const featureName = 'CylinderDefinition'.repeat(16);
    await inspector.getByLabel('Name', { exact: true }).fill(featureName);
    await inspector.getByRole('button', { name: /^Create/ }).click();
    await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
    await page.locator('.body-row-main').first().click();
    await expect(inspector).toHaveClass(/object-readout/);
    await expect(inspector.getByRole('heading', { level: 2 })).toHaveText(
      `${featureName} 1`
    );
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveCount(
      0
    );
    await expect(inspector.getByLabel('More actions')).toHaveCount(0);
    const canvas = page.locator('.viewer-host canvas');
    const selectWall = () =>
      canvas.evaluate((element) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: { surface: 'wall' }
          })
        );
      });
    await selectWall();
    await expect(inspector).toHaveClass(/object-readout/);
    await expect(inspector.getByRole('heading', { level: 2 })).toContainText(
      /wall|face/i
    );
    await expect(
      inspector.getByText('Measurements', { exact: true })
    ).toBeVisible();
    await expect(
      inspector.getByText('Defined by', { exact: true })
    ).toBeVisible();
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveCount(
      0
    );
    await expect(inspector.getByLabel('More actions')).toHaveCount(0);
    await expect(page.locator('.vite-error-overlay')).toHaveCount(0);
    const operation = page.getByRole('region', {
      name: 'Resize Cylinder operation'
    });
    if (directManipulation) await expect(operation).toBeVisible();
    else await expect(operation).toHaveCount(0);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.feature-row')).toHaveCount(1);
    await expect(inspector).toHaveClass(/object-readout/);
    await page.setViewportSize({ width: 1024, height: 800 });
    const definitionRow = inspector.locator('.object-definition-row');
    const rowBounds = await definitionRow.boundingBox();
    const editBounds = await definitionRow
      .getByRole('button', { name: 'Edit', exact: true })
      .boundingBox();
    expect(editBounds).not.toBeNull();
    expect(editBounds!.x + editBounds!.width).toBeLessThanOrEqual(
      rowBounds!.x + rowBounds!.width + 1
    );
    expect(
      await definitionRow.evaluate(
        (element) => element.scrollWidth <= element.clientWidth
      )
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/inspector-readout-${directManipulation}.png`
    });
    await page.setViewportSize({ width: 1440, height: 1000 });

    await inspector.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(inspector).not.toHaveClass(/object-readout/);
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
      '14'
    );
    await expect(inspector).toBeFocused();
    await expect(operation).toHaveCount(0);
    await expect(canvas).not.toHaveAttribute('data-e2e-selected-face', /.+/);
    await page.screenshot({
      path: `/tmp/inspector-pinned-${directManipulation}.png`
    });

    // A new viewport pick demotes even the same feature again. Edit must
    // reopen it rather than toggling off the already selected history row.
    await selectWall();
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveCount(
      0
    );
    await inspector.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
      '14'
    );
    await inspector.getByLabel('More actions').click();
    await inspector
      .getByRole('button', { name: 'Delete feature', exact: true })
      .click();
    await expect(page.locator('.feature-row')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
