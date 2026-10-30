import { test, expect, MODEL_ONLY, stubApi } from './openzcad-fixtures';

for (const width of [1440, 390]) {
  test(`cold workspace loading coordinates its reveal and keeps later View tools in their rail at ${width}px`, async ({
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
      await page.goto('/');
      await page.getByLabel('Project name').fill('Loading placeholders');
      await page.getByRole('button', { name: 'New project' }).click();
      const startup = page.getByRole('status', { name: 'Restoring workspace' });
      await expect(startup).toBeVisible();
      await expect(page.locator('.workspace-reveal')).toHaveAttribute('inert');
      await expect(page.locator('.viewport-loading')).toHaveCount(0);
      const card = (await page.locator('.startup-card').boundingBox())!;
      expect(Math.abs(card.x + card.width / 2 - width / 2)).toBeLessThan(2);
      expect(card.y).toBeGreaterThan(0);
      expect(card.y + card.height).toBeLessThan(844);
      await expect(page.locator('.startup-progress')).toHaveCSS(
        'animation-name',
        'none'
      );
      await context.setOffline(true);
      await expect(
        page.getByText(
          'You’re offline. Connect to finish loading the workspace.'
        )
      ).toBeVisible();
      await context.setOffline(false);
      releaseViewport();
      await expect(
        page.getByRole('button', { name: /^Box \(B\)/ })
      ).toBeVisible();
      await expect(startup).toHaveCount(0);
      await expect(page.locator('.viewer-host canvas')).toBeVisible();
      await page.getByRole('button', { name: /^View(?: —|$)/ }).click();
      const tools = page.locator('.view-tools-loading');
      await expect(tools).toBeVisible();
      await expect(tools).toContainText('Loading view tools…');
      await expect(tools).toHaveCSS('translate', 'none');
      await expect(page.locator('.error-boundary, .error-page')).toHaveCount(0);
      const waitingRail = (await tools.boundingBox())!;
      expect(waitingRail.x).toBeGreaterThan(width - 70);
      expect(waitingRail.x + waitingRail.width).toBeLessThanOrEqual(width);
      expect(waitingRail.width).toBeLessThanOrEqual(44);
      expect(waitingRail.y).toBeGreaterThan(60);
      await expect(tools.locator('.spin')).toHaveCSS('animation-name', 'none');
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
