import {
  createProject,
  ensureToolsDrawerOpen,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * 13 November design review, I30 and I32: after "100 Tab 60 Tab 6 Enter" a
 * second Enter pressed at once was dropped while the last size's preview
 * was checked; and Thread and Gear teeth were offered on a model with no
 * cylindrical face, where neither could succeed.
 */
test('Enter right after the last typed size applies once its preview is checked', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'Enter after typing');
  await page.keyboard.press('b');
  const bar = page.getByRole('group', { name: 'Box command' });
  await expect(
    bar.getByRole('button', { name: 'Done', exact: true })
  ).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.type('100');
  const keypad = page.locator('.numeric-keypad');
  await expect(keypad.getByRole('textbox', { name: 'Width' })).toHaveValue(
    '100'
  );
  await page.keyboard.press('Tab');
  await page.keyboard.type('60');
  await page.keyboard.press('Tab');
  await page.keyboard.type('6');
  // The first Enter commits Height; the second, at once, is Done.
  await page.keyboard.press('Enter');
  await expect(keypad).toHaveCount(0);
  await expect(bar).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(bar).toHaveCount(0, { timeout: 30_000 });
  await expectBodyCount(page, 1);
});

test('Thread and Gear teeth say they need a cylindrical face on a box-only model', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'No cylinder');
  await page.keyboard.press('b');
  const bar = page.getByRole('group', { name: 'Box command' });
  const done = bar.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await done.click();
  await expect(bar).toHaveCount(0, { timeout: 30_000 });
  await expectBodyCount(page, 1);

  await ensureToolsDrawerOpen(page);
  const drawer = page.getByRole('group', { name: 'Tools drawer' });
  for (const tool of ['Thread', 'Gear teeth']) {
    const tile = drawer.getByRole('button', {
      name: new RegExp(`^(On rail: )?${tool}\\b.*Needs a cylindrical face`)
    });
    await expect(tile).toHaveAttribute('aria-disabled', 'true', {
      timeout: 30_000
    });
  }
  // A hole needs no cylinder: it stays offered.
  await expect(
    drawer.getByRole('button', { name: /^(On rail: )?Hole\b/ })
  ).toHaveAttribute('aria-disabled', 'false');
});
