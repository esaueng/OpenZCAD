import { createProject, expect, stubApi, test } from './openzcad-fixtures';

test('a remapped shortcut works, refuses a taken key by name and survives a reload', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'Keymap remap');
  const grid = page.getByRole('button', { name: /^Toggle grid/ });
  await expect(grid).toHaveAccessibleName('Toggle grid (G)');

  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings
    .getByRole('button', { name: 'Shortcuts', exact: true })
    .click();
  const add = settings.getByRole('button', {
    name: 'Add a shortcut for Toggle the grid'
  });
  await add.click();
  // F is Fit view's: refused, with the holder named, and still listening.
  await page.keyboard.press('f');
  await expect(settings.getByRole('alert')).toHaveText(
    'F is already Fit view. Remove it there first.'
  );
  await page.keyboard.press('h');
  await settings
    .getByRole('button', { name: 'Remove G from Toggle the grid' })
    .click();
  await expect(
    settings.locator('[data-keymap-command="view-grid"] kbd')
  ).toHaveText(['H']);
  await page
    .getByRole('button', { name: /Back to workspace|Close settings/ })
    .first()
    .click();

  // Every surface that names the key names the new one.
  await expect(grid).toHaveAccessibleName('Toggle grid (H)');
  const before = await grid.getAttribute('aria-pressed');
  // G no longer toggles the grid and H does: one flip across both presses.
  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(grid).not.toHaveAttribute('aria-pressed', before ?? '');

  await page.reload();
  await expect(grid).toHaveAccessibleName('Toggle grid (H)', {
    timeout: 30_000
  });
  const reloaded = await grid.getAttribute('aria-pressed');
  await page.keyboard.press('h');
  await expect(grid).not.toHaveAttribute('aria-pressed', reloaded ?? '');

  // The shortcut reference shows the live binding.
  await page.keyboard.press('?');
  const reference = page.getByRole('dialog', { name: 'Controls' });
  await expect(
    reference.locator('.shortcut-row', { hasText: 'Toggle the grid' })
  ).toContainText('H');
});
