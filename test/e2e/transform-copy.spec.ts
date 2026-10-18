import {
  test,
  expect,
  expectBodyCount,
  expectConsumedBodyCount,
  stubApi
} from './openzcad-fixtures';

/**
 * M10: the Move gizmo card's Copy box adds a moved copy as a body of its
 * own. The source stays live, both show in Items, History has one Copy row,
 * and undo and redo take the copy away and bring it back as one step.
 */
test('the Move card copies a body and keeps the source', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Copy');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Width (X)').fill('20');
  await inspector.getByLabel('Depth (Y)').fill('10');
  await inspector.getByLabel('Height (Z)').fill('10');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expectBodyCount(page, 1);

  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await expect(overlay).toBeVisible();
  await overlay.getByLabel('Move X in mm').fill('40');
  await overlay
    .getByRole('checkbox', { name: 'Copy (keep the original)' })
    .check();
  await overlay.getByLabel('Name').fill('Copy');
  await overlay.getByRole('button', { name: 'Apply copy' }).click();
  await expect(overlay).toBeHidden();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  // Two live bodies: the source untouched, the copy a body of its own.
  await expectBodyCount(page, 2);
  await expectConsumedBodyCount(page, 0);
  const rows = page.locator('.body-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: /copy$/ })).toHaveCount(1);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Copy' })
  ).toHaveCount(1);

  // The edit card names the copy rather than offering to undo it.
  await page.locator('.feature-row-main', { hasText: 'Copy' }).click();
  await expect(
    inspector.getByText('Copy: the source body stays in place.')
  ).toBeVisible();
  await expect(
    inspector.getByRole('textbox', { name: 'Move X in mm' })
  ).toHaveValue('40');
  await inspector.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 1);
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 2);
  await expect(rows.filter({ hasText: /copy$/ })).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
});
