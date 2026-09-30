import { test, expect, stubApi } from './openzcad-fixtures';

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`all projects are reachable by scrolling at ${viewport.width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await stubApi(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const projects = Array.from({ length: 96 }, (_, index) => ({
      projectId: `scroll-part-${index + 1}`,
      name: `Library part ${String(index + 1).padStart(2, '0')}`,
      revisionCount: index + 1,
      updatedAt: '2026-09-29T12:00:00.000Z',
      thumbnailArtifactId: `scroll-preview-${index + 1}`
    }));
    await page.route('**/api/projects', (route) =>
      route.fulfill({ json: { projects } })
    );
    const requestedPreviews = new Set<string>();
    // A small valid WebP keeps the image path real without loading CAD documents.
    await page.route(
      '**/api/artifacts/scroll-preview-*/download',
      async (route) => {
        const artifactId = route.request().url().split('/').at(-2)!;
        requestedPreviews.add(artifactId);
        await route.fulfill({
          contentType: 'image/webp',
          body: Buffer.from(
            'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
            'base64'
          )
        });
      }
    );
    await page.goto('/');
    await expect(page).toHaveTitle(/OpenZCAD/);
    const cards = page.locator('.start-tile-project');
    await expect(cards).toHaveCount(96);
    await expect(
      page.getByRole('button', { name: /Show .*parts/ })
    ).toHaveCount(0);
    await expect(cards.first().locator('img')).toBeVisible();
    expect(requestedPreviews.size).toBeLessThan(96);
    expect(requestedPreviews.has('scroll-preview-96')).toBe(false);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('library-top.png') });

    // Scroll the actual scroll container, including the page shell on mobile.
    const scroller = page.locator(
      viewport.width > 900 ? '.start-body' : '.start-screen'
    );
    await scroller.hover();
    const lastCardBounds = await cards.last().boundingBox();
    if (!lastCardBounds) throw new Error('Last project card is missing');
    await page.mouse.wheel(0, lastCardBounds.y - viewport.height / 3);
    await expect(cards.last()).toBeInViewport();
    await expect(cards.last().locator('img')).toBeVisible();
    expect(requestedPreviews.has('scroll-preview-96')).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('library-bottom.png') });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);

    await page.getByLabel('Search parts').fill('Library part 96');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Library part 96');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(cards).toHaveCount(96);
    expect(errors).toEqual([]);
  });
}
