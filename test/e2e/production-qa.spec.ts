import {
  createPrimitiveInPlace,
  finishInPlaceCommand,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

test('invalid primitive dimensions never enter saved history', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('QA dimension validation');
  await page.getByRole('button', { name: 'Create project' }).click();
  // A box runs in place (U09): a typed size it cannot build is refused in
  // its bar, and the chip keeps the size it had.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const bar = page.getByRole('group', { name: 'Box command' });
  const width = page.getByTestId('command-handle-width');
  await width.click();
  const entry = page.locator('.numeric-keypad input');
  await entry.fill('-5');
  await entry.press('Enter');
  await expect(bar).toContainText('Box width takes at least 0.001, not -5.');
  await expect(width).toContainText('Width 30');
  await expect(
    page.getByText(
      'No features yet. Pick a tool from the tool rail on the left to start.'
    )
  ).toBeVisible();
  await finishInPlaceCommand(page, 'Box');
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expect(
    page.getByRole('heading', { name: 'History 1', exact: true })
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
  await createPrimitiveInPlace(page, 'box');
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await page.getByText('File', { exact: true }).click();
  await page.getByRole('button', { name: /Export mesh/ }).click();
  const unavailable = page.getByRole('dialog', { name: 'Export unavailable' });
  await expect(unavailable).toBeVisible();
  await expect(
    unavailable.getByRole('button', { name: 'Close' })
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(unavailable).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'History 1', exact: true })
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
