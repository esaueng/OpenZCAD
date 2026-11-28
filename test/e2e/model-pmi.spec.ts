import {
  createPrimitiveInPlace,
  expect,
  modelPanel,
  pickPlanarFace,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * D07 slice C (schema v106): model-based definition. Datum A on a box's
 * bottom face and a frame on its top, made parallel to A in Objects; both
 * label the viewport and come back from the saved document after a reload.
 */
test(
  'puts a datum and a feature control frame on the model',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Toleranced block');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '30', depth: '20', height: '10' }
    });
    await expect(
      page.locator('.feature-row-main', { hasText: 'Box' })
    ).toBeVisible();
    await revealModelPanel(page, 'Objects');
    const objects = modelPanel(page, 'Objects');

    // Datum A on the bottom face.
    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: -1 }))
      .not.toBeNull();
    await objects.getByRole('button', { name: 'Datum feature' }).click();
    await expect(
      objects.getByRole('button', { name: 'Datum A', exact: true })
    ).toBeVisible();
    await expect(page.locator('.pmi-label[aria-label="Datum A"]')).toHaveCount(
      1
    );

    // A frame on the top face, made parallel to A.
    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }))
      .not.toBeNull();
    await objects
      .getByRole('button', { name: 'Feature control frame' })
      .click();
    await expect(
      objects.getByRole('button', { name: 'Flatness | 0.1', exact: true })
    ).toBeVisible();
    await objects
      .getByRole('combobox', { name: 'Characteristic' })
      .selectOption('parallelism');
    const frame = objects.getByRole('button', {
      name: 'Parallelism | 0.1 | A',
      exact: true
    });
    await expect(frame).toBeVisible();
    await expect(
      page.locator('.pmi-label[aria-label="Parallelism | 0.1 | A"]')
    ).toHaveCount(1);
    await expect(page.locator('.pmi-label.is-broken')).toHaveCount(0);

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    await revealModelPanel(page, 'Objects');
    const reopened = modelPanel(page, 'Objects');
    await expect(
      reopened.getByRole('button', {
        name: 'Parallelism | 0.1 | A',
        exact: true
      })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      reopened.getByRole('button', { name: 'Datum A', exact: true })
    ).toBeVisible();
    await expect(page.locator('.pmi-label')).toHaveCount(2);
    expect(errors).toEqual([]);
  }
);

/**
 * #2375: renaming a datum carries every frame naming it, in one undoable
 * step; #2321: a planar face offers no cylindricity.
 */
test(
  'renames a datum with the frames that reference it',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Renamed datum block');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '30', depth: '20', height: '10' }
    });
    await expect(
      page.locator('.feature-row-main', { hasText: 'Box' })
    ).toBeVisible();
    await revealModelPanel(page, 'Objects');
    const objects = modelPanel(page, 'Objects');

    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: -1 }))
      .not.toBeNull();
    await objects.getByRole('button', { name: 'Datum feature' }).click();
    await expect(
      objects.getByRole('button', { name: 'Datum A', exact: true })
    ).toBeVisible();

    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }))
      .not.toBeNull();
    await objects
      .getByRole('button', { name: 'Feature control frame' })
      .click();
    const characteristic = objects.getByRole('combobox', {
      name: 'Characteristic'
    });
    // A flat face takes flatness, never cylindricity.
    await expect(
      characteristic.locator('option[value="cylindricity"]')
    ).toHaveJSProperty('disabled', true);
    await characteristic.selectOption('parallelism');
    await expect(
      objects.getByRole('button', {
        name: 'Parallelism | 0.1 | A',
        exact: true
      })
    ).toBeVisible();

    // Datum A becomes F, and the frame follows it.
    await objects.getByRole('button', { name: 'Datum A', exact: true }).click();
    await objects.getByRole('combobox', { name: 'Letter' }).selectOption('F');
    await expect(
      objects.getByRole('button', { name: 'Datum F', exact: true })
    ).toBeVisible();
    await expect(
      objects.getByRole('button', {
        name: 'Parallelism | 0.1 | F',
        exact: true
      })
    ).toBeVisible();
    await expect(page.locator('.pmi-label.is-broken')).toHaveCount(0);

    // One undo restores both.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      objects.getByRole('button', { name: 'Datum A', exact: true })
    ).toBeVisible();
    await expect(
      objects.getByRole('button', {
        name: 'Parallelism | 0.1 | A',
        exact: true
      })
    ).toBeVisible();
    await expect(page.locator('.pmi-label.is-broken')).toHaveCount(0);
    expect(errors).toEqual([]);
  }
);
