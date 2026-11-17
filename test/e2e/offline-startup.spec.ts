import { test, expect, stubApi } from './openzcad-fixtures';

// 13 November design review I5: offline, New project reached the page's
// "Loading interrupted · Part of OpenZCAD could not load" card, with Reload
// as the only action and no way back to the library, and it stayed there
// after the connection returned.
test(
  'a project created offline waits on the startup screen and opens on reconnect',
  { tag: '@ci-smoke' },
  async ({ page, context }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'New project' })
    ).toBeVisible();
    await context.setOffline(true);
    await page.getByLabel('Project name').fill('Offline first');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(
      page.getByText('You’re offline. Connect to finish loading the workspace.')
    ).toBeVisible();
    await expect(page.locator('.error-page')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Reload/ })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Back to projects' })
    ).toBeVisible();

    await context.setOffline(false);
    await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible({
      timeout: 20_000
    });
    await expect(page.locator('.viewer-host canvas')).toBeVisible();
    await expect(page.locator('.error-page')).toHaveCount(0);
    await expect(page.locator('.topbar-reload-chip')).toHaveCount(0);
  }
);

test('Back to projects leaves an offline startup for the library', async ({
  page,
  context
}) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel('Project name').fill('Offline back');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Back to projects' }).click();
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
  await expect(page.locator('.error-page')).toHaveCount(0);
  await expect(page.getByText('Load failed')).toHaveCount(0);
});

// The same review's second route (A6): a one-shot download that failed
// offline raised the library's "Load failed · Reload" foot line and a toast
// suggesting a reload, and both stayed once the connection returned.
test('a download that fails offline never offers Reload, and leaves nothing behind on reconnect', async ({
  page,
  context
}) => {
  await stubApi(page);
  let offline = false;
  await page.route(/\/assets\/demos-.*\.js$/, (route) =>
    offline ? route.abort('internetdisconnected') : route.continue()
  );
  await page.goto('/');
  const demo = page.getByRole('button', {
    name: /^Open demo: Mounting Bracket/
  });
  await expect(demo).toBeEnabled();
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  offline = true;
  await context.setOffline(true);
  await demo.click();
  await expect(page.locator('.toast')).toContainText(/You’re offline/);
  await expect(page.getByRole('button', { name: /Reload/ })).toHaveCount(0);
  await expect(page.locator('.start-update')).toHaveCount(0);
  await expect(page.locator('.error-page')).toHaveCount(0);

  offline = false;
  await context.setOffline(false);
  await expect(page.locator('.start-update')).toHaveCount(0);
  await expect(page.getByText('Load failed')).toHaveCount(0);
  await demo.click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible({
    timeout: 20_000
  });
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
});
