import { expect, test, stubApi } from './openzcad-fixtures';

test('the parameter eye hides and restores a Tweak control', async ({
  page
}) => {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('Parameter curation');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('New parameter name').fill('width_x');
  await page.getByLabel('New parameter expression').fill('300');
  await page.getByRole('button', { name: 'Add parameter' }).click();

  const hide = page.getByRole('button', {
    name: 'Hide width_x in Tweak mode'
  });
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await hide.click();
  const show = page.getByRole('button', {
    name: 'Show width_x in Tweak mode'
  });
  await expect(show).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: 'Tweak', exact: true }).click();
  await expect(page.getByLabel('Expression for width_x')).toHaveCount(0);
  await expect(
    page.getByText('This model offers no parameters to adjust.')
  ).toBeVisible();

  await page.getByRole('button', { name: 'Build', exact: true }).click();
  await show.click();
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Tweak', exact: true }).click();
  await expect(page.getByLabel('Expression for width_x')).toHaveValue('300');
  expect(errors).toEqual([]);
});
