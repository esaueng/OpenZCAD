import { test, expect, stubApi } from './openzcad-fixtures';

// The new-version notice rides above the cloud card at the foot of the
// library column. It used to live in a 30px footer bar, where the shared button's 32px
// minimum overflowed the bar and the window clipped its bottom; the bar is
// gone, but the pill must still sit wholly inside the window.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`new-version notice fits the window at ${viewport.width}px`, async ({
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

    await expect(page.locator('.start-foot')).toHaveCount(0);
    await expect(
      page.getByRole('complementary', { name: 'Cloud sync' })
    ).toContainText('A new version of OpenZCAD');
    // On a phone the card joins the page's flow at the end, so bring it in.
    await notice.scrollIntoViewIfNeeded();
    const pill = await notice.boundingBox();
    const button = await notice
      .getByRole('button', { name: 'Reload' })
      .boundingBox();
    expect(pill && button).toBeTruthy();
    expect(button!.y).toBeGreaterThanOrEqual(pill!.y);
    expect(button!.y + button!.height).toBeLessThanOrEqual(
      pill!.y + pill!.height
    );
    for (const box of [pill!, button!]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(viewport.width);
  });
}
