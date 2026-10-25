import {
  test,
  expect,
  stubApi,
  selectBodyFromObjects
} from './openzcad-fixtures';

/**
 * Surfaces a click opens are loaded while the page is idle, so their first
 * open is not an empty frame. React.lazy suspends on a first render even with
 * the chunk prefetched (the module still evaluates asynchronously): Settings
 * opened blank and Move left a gap with neither the selection card nor its
 * panel for a few frames.
 */

declare global {
  interface Window {
    __firstUse?: { settingsBlank: number; moveGap: number; moving: boolean };
  }
}

test('Settings and Move open complete the first time', async ({ page }) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('First use');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  // The warm-up runs when the page is first idle, at the latest 5 s in.
  await page.waitForTimeout(6_000);
  await page.evaluate(() => {
    window.__firstUse = { settingsBlank: 0, moveGap: 0, moving: false };
    const sample = () => {
      const tally = window.__firstUse!;
      const settings = document.querySelector(
        '[role="dialog"][aria-label*="Settings"], .settings-page'
      );
      if (settings && !/Settings/.test((settings as HTMLElement).innerText))
        tally.settingsBlank += 1;
      if (
        tally.moving &&
        !document.querySelector('.selection-card') &&
        !document.querySelector('form[aria-label="Move controls"]')
      )
        tally.moveGap += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings' }).first()
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to workspace' }).click();

  await selectBodyFromObjects(page);
  await expect(
    page.getByRole('button', { name: 'Selection: Move', exact: true })
  ).toBeVisible();
  await page.evaluate(() => {
    window.__firstUse!.moving = true;
  });
  await page
    .getByRole('button', { name: 'Selection: Move', exact: true })
    .click();
  await expect(page.locator('form[aria-label="Move controls"]')).toBeVisible();
  await page.waitForTimeout(300);

  expect(await page.evaluate(() => window.__firstUse)).toMatchObject({
    settingsBlank: 0,
    moveGap: 0
  });
});

test('Settings opened before the warm-up never shows an empty overlay', async ({
  page
}) => {
  await stubApi(page);
  // Hold the Settings chunk back so the click lands before it can load.
  await page.route(/SettingsPage[^/]*\.(js|tsx)(\?|$)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.addInitScript(() => {
    window.__firstUse = { settingsBlank: 0, moveGap: 0, moving: false };
    const sample = () => {
      const settings = document.querySelector(
        '[role="dialog"][aria-label*="Settings"]'
      );
      if (settings && !/Settings/.test((settings as HTMLElement).innerText))
        window.__firstUse!.settingsBlank += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings' }).first()
  ).toBeVisible();
  expect(await page.evaluate(() => window.__firstUse?.settingsBlank)).toBe(0);
});
