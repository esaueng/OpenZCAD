import { test, expect, stubApi } from './openzcad-fixtures';

test('invalid primitive dimensions never enter saved history', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('QA dimension validation');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  const width = inspector.getByRole('textbox', { name: 'Width (X)' });
  await width.fill('-5');
  await expect(width).toHaveAttribute('aria-invalid', 'true');
  await expect(width).toHaveAccessibleDescription('Must be greater than zero.');
  await expect(
    inspector.getByRole('button', { name: 'Create', exact: true })
  ).toBeDisabled();
  await width.press('Enter');
  await expect(inspector).toBeVisible();
  await expect(
    page.getByText('No features yet. Pick a tool from the Feature tools rail.')
  ).toBeVisible();
  await width.fill('30');
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'History 1', exact: true })
  ).toBeVisible();
});

test('a missing export chunk leaves the workspace usable without reload', async ({
  page
}) => {
  await stubApi(page);
  await page.route('**/assets/ExportDialog-*.js', (route) =>
    route.abort('failed')
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill('QA export recovery');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await page.getByText('File', { exact: true }).click();
  await page.getByRole('button', { name: 'Export Mesh… 3MF · STL' }).click();
  const unavailable = page.getByRole('dialog', { name: 'Export unavailable' });
  await expect(unavailable).toBeVisible();
  await expect(
    unavailable.getByRole('button', { name: 'Close' })
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(unavailable).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'History 1', exact: true })
  ).toBeVisible();
  await page.getByText('File', { exact: true }).click();
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: 'View', exact: true })
    .click();
  await expect(page.getByRole('toolbar', { name: 'View tools' })).toBeVisible();
  await expect(
    page.getByText('OpenZCAD workspace could not be rendered.')
  ).not.toBeVisible();
});
