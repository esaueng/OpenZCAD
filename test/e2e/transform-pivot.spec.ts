import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi,
  openMoveOptions
} from './openzcad-fixtures';

/**
 * M10: a Move made with the gizmo stores the body's centre as its pivot, the
 * numeric edit card shows it, and an edit to the rotation keeps it — the
 * gizmo and the form write one state.
 */
test('a gizmo rotation stores its pivot, and editing the angle keeps it', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Pivot');
  await page.getByRole('button', { name: 'New project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '40', depth: '20', height: '10' }
  });
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await expect(overlay).toBeVisible();
  await openMoveOptions(overlay);
  await overlay.getByLabel('Move X in mm').fill('12');
  await overlay.getByLabel('Rotate Z in degrees').fill('45');
  await overlay.getByRole('button', { name: 'Done' }).click();
  await expect(overlay).toBeHidden();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  const pivotX = inspector.getByRole('textbox', { name: 'Pivot X in mm' });
  const pivotY = inspector.getByRole('textbox', { name: 'Pivot Y in mm' });
  const open = async () => {
    await page.locator('.feature-row-main', { hasText: 'Move' }).click();
    await expect(pivotX).toBeVisible();
  };
  await open();
  // The block's centre, not a pivot folded into the translation.
  const centre = [await pivotX.inputValue(), await pivotY.inputValue()];
  expect(centre.map(Number).some((value) => value !== 0)).toBe(true);
  await expect(
    inspector.getByRole('textbox', { name: 'Move X in mm' })
  ).toHaveValue('12');

  await inspector
    .getByRole('textbox', { name: 'Rotate Z in degrees' })
    .fill('90');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await open();
  await expect(
    inspector.getByRole('textbox', { name: 'Rotate Z in degrees' })
  ).toHaveValue('90');
  expect([await pivotX.inputValue(), await pivotY.inputValue()]).toEqual(
    centre
  );
});

test('a translation-only gizmo Move still stores its pivot', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Pivot slide');
  await page.getByRole('button', { name: 'New project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '40', depth: '20', height: '10' }
  });
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await openMoveOptions(overlay);
  await overlay.getByLabel('Move X in mm').fill('12');
  await overlay.getByRole('button', { name: 'Done' }).click();
  await expect(overlay).toBeHidden();

  // A turn added later in the edit card stays about the body's centre.
  await page.locator('.feature-row-main', { hasText: 'Move' }).click();
  const pivotX = inspector.getByRole('textbox', { name: 'Pivot X in mm' });
  await expect(pivotX).toBeVisible();
  const centre = [
    await pivotX.inputValue(),
    await inspector.getByRole('textbox', { name: 'Pivot Y in mm' }).inputValue()
  ];
  expect(centre.map(Number).some((value) => value !== 0)).toBe(true);
});
