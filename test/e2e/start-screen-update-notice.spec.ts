import { test, expect, stubApi } from './openzcad-fixtures';

// The new-version notice lives in the 30px library footer. At the shared
// button's 32px minimum it overflowed the bar: its top edge rode over the
// column above and the window clipped its bottom.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`new-version notice fits the library footer at ${viewport.width}px`, async ({
    page
  }) => {
    await page.setViewportSize(viewport);
    await stubApi(page);
    // Every read names a different build, so the watch reports one whether
    // it compares with the bundle's own commit or with its first read.
    let reads = 0;
    await page.route('**/build-meta.json*', (route) =>
      route.fulfill({ json: { commit: `newer-build-${++reads}` } })
    );
    await page.goto('/');

    const notice = page.locator('.start-update');
    await expect(async () => {
      await page.evaluate(() =>
        document.dispatchEvent(new Event('visibilitychange'))
      );
      await expect(notice).toBeVisible({ timeout: 500 });
    }).toPass();
    await expect(notice).toContainText('A new version of OpenZCAD');

    const foot = await page.locator('.start-foot').boundingBox();
    const pill = await notice.boundingBox();
    const button = await notice
      .getByRole('button', { name: 'Reload' })
      .boundingBox();
    expect(foot && pill && button).toBeTruthy();
    for (const box of [pill!, button!]) {
      expect(box.y).toBeGreaterThanOrEqual(foot!.y);
      expect(box.y + box.height).toBeLessThanOrEqual(foot!.y + foot!.height);
      expect(box.x + box.width).toBeLessThanOrEqual(foot!.x + foot!.width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(viewport.width);
  });
}
