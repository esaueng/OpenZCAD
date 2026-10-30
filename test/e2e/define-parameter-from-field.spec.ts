import {
  createPrimitiveInPlace,
  expect,
  test,
  stubApi
} from './openzcad-fixtures';

/**
 * G5 (11 Oct 2026 design review): `width` typed into a Box's Width before
 * any parameter of that name existed ended at "Unknown identifier" and a
 * disabled Create. The field now offers to define it in place, with the value
 * it replaced; the definition is its own undo step, before the edit. A new
 * box runs in place (U09), so the field is its History card's.
 */
test('defines a parameter from the Box field that first names it', async ({
  page
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Define from a field');
  await page.getByRole('button', { name: 'New project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await createPrimitiveInPlace(page, 'box');
  await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
  const width = inspector.getByRole('textbox', { name: 'Width (X)' });
  const apply = inspector.getByRole('button', { name: 'Apply', exact: true });
  await width.fill('width');
  await expect(inspector.getByText('is not defined yet')).toBeVisible();
  await expect(inspector.getByText(/Unknown identifier/)).toHaveCount(0);
  await expect(apply).toBeDisabled();

  // The value it replaced is offered; Enter there defines, and does not
  // reach the card.
  const value = inspector.getByRole('textbox', {
    name: 'Value for new parameter width'
  });
  await expect(value).toHaveValue('30');
  await value.fill('80');
  await value.press('Enter');
  await expect(inspector.getByText('= 80')).toBeVisible();
  await expect(value).toHaveCount(0);
  await expect(apply).toBeEnabled();
  await expect(width).toBeFocused();

  // Back in the field, Enter applies the box over the new parameter.
  await width.press('Enter');
  await expect(inspector).toHaveCount(0);

  const parametersPanel = page.getByRole('button', {
    name: 'Parameters panel'
  });
  if ((await parametersPanel.getAttribute('aria-pressed')) !== 'true')
    await parametersPanel.click();
  const expression = page.getByRole('textbox', {
    name: 'Expression for width'
  });
  await expect(expression).toHaveValue('80');

  // Two steps: undo takes the edit, then the parameter; the box stays.
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  await expect(expression).toHaveValue('80');
  await undo.click();
  await expect(expression).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  expect(errors).toEqual([]);
});
