import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * F05 Stage 1a: a parameter's type picker. A unitless parameter used as a
 * length is offered Length (never applied for it); once a length, it mixes
 * with suffixed lengths; and a retype that would break a use is refused in
 * place, leaving the type as it was.
 */
test('types a parameter as a length, mixes it with mm, and refuses a breaking retype', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Typed parameters');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();

  await page.getByLabel('New parameter name').fill('w');
  await page.getByLabel('New parameter expression').fill('10');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  const wType = page.getByLabel('Type of w');
  await expect(wType).toHaveValue('unitless');
  await expect(wType).not.toHaveClass(/suggested/);

  // Used as a box width, w is offered Length but stays unitless.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Width (X)').fill('w');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await expect(wType).toHaveClass(/suggested/);
  await expect(wType).toHaveValue('unitless');

  await wType.selectOption('length');
  await expect(wType).toHaveValue('length');
  await expect(wType).not.toHaveClass(/suggested/);

  // A length adds to millimetres now.
  await page.getByLabel('New parameter name').fill('outer');
  await page.getByLabel('New parameter expression').fill('w + 5 mm');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(
    page.locator('.param-row', { hasText: 'outer' }).locator('.param-value')
  ).toContainText('15');

  // Back to unitless would leave `w + 5 mm` adding a bare number to a
  // length: refused where it was chosen, and w stays a length.
  await wType.selectOption('unitless');
  await expect(
    page.getByText(/Parameter "outer": Incompatible dimensions/).first()
  ).toBeVisible();
  await expect(wType).toHaveValue('length');
});
