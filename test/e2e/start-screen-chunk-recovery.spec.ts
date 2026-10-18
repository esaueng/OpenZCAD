import { test, expect, stubApi } from './openzcad-fixtures';
import {
  TOAST_EXIT_MS,
  TOAST_LIFETIME_MS
} from '../../apps/web/src/lib/toasts';

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
    await expect(
      page.locator('.toast').getByRole('button', { name: 'Reload' })
    ).toBeVisible();
    expect(failedDownloads).toBeGreaterThan(0);
    await expect(
      page.getByText('A newer OpenZCAD build is available.')
    ).toHaveCount(0);
    await expect(page.locator('.error-page, vite-error-overlay')).toHaveCount(
      0
    );
    await expect(page.locator('.start-screen')).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    // A failed browser module can remain cached after the transient notice
    // expires. Recovery must remain available without waiting for a poll.
    await expect(page.locator('.toast')).toHaveCount(0, {
      timeout: TOAST_LIFETIME_MS + TOAST_EXIT_MS + 2000
    });
    const notice = page.locator('.start-update');
    await expect(notice).toContainText('Check your connection');
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
