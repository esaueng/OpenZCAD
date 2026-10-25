import { DEFAULT_APP_SETTINGS } from '@openzcad/shared';
import {
  createProject,
  expect,
  stubApi,
  test,
  createPrimitiveInPlace
} from './openzcad-fixtures';

for (const directManipulation of [true, false]) {
  test(`a pick opens no card and History opens the feature with direct manipulation ${directManipulation ? 'on' : 'off'}`, async ({
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
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    const featureName = 'CylinderDefinition'.repeat(16);
    await createPrimitiveInPlace(page, 'cylinder', {
      sizes: { radius: '14' },
      name: featureName
    });
    await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
    // An Objects row pick opens no card: the Selection card names the body.
    await page.locator('.body-row-main').first().click();
    await expect(inspector).toHaveCount(0);
    // Nor does the shell hold an empty lane for one: on a phone that lane
    // reads as a full-width card and hides the viewer rail.
    await expect(page.locator('.viewer-area')).not.toHaveClass(/has-inspector/);
    await expect(
      page.locator('.selection-card .selection-callout-name')
    ).toContainText(`${featureName} 1`);
    const canvas = page.locator('.viewer-host canvas');
    const selectWall = () =>
      canvas.evaluate((element) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: { surface: 'wall' }
          })
        );
      });
    // Nor does a viewport pick: the Selection card names the face.
    await selectWall();
    await expect(inspector).toHaveCount(0);
    await expect(page.locator('.viewer-area')).not.toHaveClass(/has-inspector/);
    await expect(
      page.locator('.selection-card .selection-callout-name')
    ).toContainText(/wall|face/i);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    const operation = page.getByRole('region', {
      name: 'Resize Cylinder operation'
    });
    if (directManipulation) await expect(operation).toBeVisible();
    else await expect(operation).toHaveCount(0);
    // An inferred feature is never deleted from a pick.
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.feature-row')).toHaveCount(1);

    // The feature's details and form open from its History row.
    const row = page.locator('.feature-row-main').first();
    await row.click();
    await expect(inspector).not.toHaveClass(/object-readout/);
    await expect(inspector).toContainText('Measurements');
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
      '14'
    );
    await expect(operation).toHaveCount(0);
    await expect(canvas).not.toHaveAttribute('data-e2e-selected-face', /.+/);
    await page.screenshot({
      path: `/tmp/inspector-pinned-${directManipulation}.png`
    });

    // A new viewport pick closes even the same feature's card. Its row must
    // reopen it rather than toggling off the row it had selected.
    await selectWall();
    await expect(inspector).toHaveCount(0);
    await row.click();
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
