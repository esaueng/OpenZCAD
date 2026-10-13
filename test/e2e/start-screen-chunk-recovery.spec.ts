import { test, expect, stubApi } from './openzcad-fixtures';

for (const width of [1440, 390]) {
  test(`a failed demo download offers reload without claiming an update at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    let failedDownloads = 0;
    await page.route(/\/assets\/demos-.*\.js$/, async (route) => {
      failedDownloads += 1;
      await route.abort('failed');
    });
    await page.goto('/');
    await expect(page).toHaveTitle(/OpenZCAD/);
    const demo = page.getByRole('button', {
      name: /^Open demo: Mounting Bracket/
    });
    await expect(demo).toBeEnabled();
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await demo.click();
    await expect(page.locator('.toast')).toContainText('Check your connection');
    const reload = page
      .locator('.toast')
      .getByRole('button', { name: 'Reload' });
    await expect(reload).toBeVisible();
    expect(failedDownloads).toBeGreaterThan(0);
    await expect(
      page.getByText('A newer OpenZCAD build is available.')
    ).toHaveCount(0);
    await expect(page.locator('.error-page, vite-error-overlay')).toHaveCount(
      0
    );
    await expect(page.locator('.start-screen')).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    await testInfo.attach('start-screen-download-recovery', {
      body: await page.screenshot(),
      contentType: 'image/png'
    });
    expect(pageErrors).toEqual([]);
    await Promise.all([page.waitForEvent('domcontentloaded'), reload.click()]);
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
      timeOrigin
    );
    await expect(demo).toBeEnabled();
  });
}
