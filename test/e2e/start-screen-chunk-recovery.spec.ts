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
    // No toast over the work: the library foot keeps one quiet line with
    // Reload, which outlives any transient notice and never claims an update.
    const notice = page.locator('.start-update');
    await expect(notice).toBeVisible();
    expect(failedDownloads).toBeGreaterThan(0);
    await expect(
      page.locator('.toast').getByRole('button', { name: 'Reload' })
    ).toHaveCount(0);
    await expect(page.getByText(/newer OpenZCAD/i)).toHaveCount(0);
    await expect(page.locator('.error-page, vite-error-overlay')).toHaveCount(
      0
    );
    await expect(page.locator('.start-screen')).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    // Two words in the column; the full sentence is the tooltip and the
    // screen-reader text.
    await expect(notice.locator('.start-update-text')).toHaveText(
      'Load failed'
    );
    await expect(notice.locator('.start-update-text')).toHaveAttribute(
      'title',
      /check your connection/i
    );
    await expect(notice).toContainText(/check your connection/i);
    await expect(notice).not.toContainText(/new version/i);
    const reload = notice.getByRole('button', { name: 'Reload' });
    await reload.scrollIntoViewIfNeeded();
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
