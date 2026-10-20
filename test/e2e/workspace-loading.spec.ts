import {
  test,
  expect,
  createProject,
  MODEL_ONLY,
  stubApi
} from './openzcad-fixtures';

for (const width of [1440, 390]) {
  test(`cold workspace loading stays in its viewport and rail at ${width}px`, async ({
    page,
    context
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubApi(page, { panelLayout: MODEL_ONLY, commandFoldClosed: true });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let releaseViewport!: () => void;
    let releaseTools!: () => void;
    const viewportGate = new Promise<void>((resolve) => {
      releaseViewport = resolve;
    });
    const toolsGate = new Promise<void>((resolve) => {
      releaseTools = resolve;
    });
    await page.route('**/assets/ViewerShell-*.js', async (route) => {
      await viewportGate;
      await route.continue();
    });
    await page.route('**/assets/ViewModeBar-*.js', async (route) => {
      await toolsGate;
      await route.continue();
    });
    try {
      await createProject(page, 'Loading placeholders');
      await page.getByRole('button', { name: /^View(?: —|$)/ }).click();
      const viewport = page.locator('.viewport-loading');
      const tools = page.locator('.view-tools-loading');
      await expect(viewport).toBeVisible();
      await expect(tools).toBeVisible();
      await expect(tools).toContainText('Loading view tools…');
      await expect(tools).toHaveCSS('translate', 'none');
      await expect(page.locator('.error-boundary, .error-page')).toHaveCount(0);
      const stage = (await page.locator('.viewer-area').boundingBox())!;
      const label = (await viewport
        .getByText('Loading 3D viewport…')
        .boundingBox())!;
      expect(
        Math.abs(label.x + label.width / 2 - (stage.x + stage.width / 2))
      ).toBeLessThan(2);
      expect(
        Math.abs(label.y + label.height / 2 - (stage.y + stage.height / 2))
      ).toBeLessThan(25);
      const waitingRail = (await tools.boundingBox())!;
      expect(waitingRail.x).toBeGreaterThan(width - 70);
      expect(waitingRail.x + waitingRail.width).toBeLessThanOrEqual(width);
      expect(waitingRail.width).toBeLessThanOrEqual(44);
      expect(waitingRail.y).toBeGreaterThan(60);
      await expect(tools.locator('.spin')).toHaveCSS('animation-name', 'none');
      await expect(viewport.locator('.spin')).toHaveCSS(
        'animation-name',
        'none'
      );
      await testInfo.attach('cold-workspace-loading', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });

      await context.setOffline(true);
      const guidance = tools.getByText(
        'Connect to the internet to load this panel.'
      );
      await expect(guidance).toBeVisible();
      const message = (await guidance.boundingBox())!;
      expect(message.x).toBeGreaterThanOrEqual(0);
      expect(message.x + message.width).toBeLessThanOrEqual(waitingRail.x);
      await context.setOffline(false);
      releaseViewport();
      await expect(page.locator('.viewer-host canvas')).toBeVisible();
      await expect(viewport).toHaveCount(0);
      await expect(tools).toBeVisible();
      releaseTools();
      const toolbar = page.getByRole('toolbar', { name: 'View tools' });
      await expect(toolbar).toBeVisible();
      await expect(toolbar).toHaveCSS('translate', 'none');
      await expect(tools).toHaveCount(0);
      const readyRail = (await toolbar.boundingBox())!;
      expect(Math.abs(readyRail.x - waitingRail.x)).toBeLessThan(1);
      expect(Math.abs(readyRail.y - waitingRail.y)).toBeLessThan(1);
      expect(Math.abs(readyRail.height - waitingRail.height)).toBeLessThan(1);
      await toolbar
        .getByRole('button', { name: 'Standard views', exact: true })
        .click();
      await expect(
        page.getByRole('group', { name: 'Standard views', exact: true })
      ).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      releaseViewport();
      releaseTools();
    }
  });
}
