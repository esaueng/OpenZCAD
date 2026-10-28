import {
  test,
  expect,
  stubApi,
  createProject,
  createPrimitiveInPlace,
  expectBodyCount
} from './openzcad-fixtures';

for (const width of [1440, 390]) {
  test(`reload reveals the model and lazy workspace surfaces together at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubApi(page);
    await createProject(page, 'Reload workspace');
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    await page.route(
      /\/assets\/(?:ModelPanel|ViewerShell|CommandBar)-[^/]+\.js$/,
      async (route) => {
        held++;
        await gate;
        await route.continue();
      }
    );
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => held).toBeGreaterThan(0);
      await expect(
        page.getByRole('status', { name: 'Restoring workspace' })
      ).toBeVisible();
      await expect(page.locator('.workspace-reveal')).toHaveAttribute('inert');
      await expect(
        page.getByText('Loading model panels…').filter({ visible: true })
      ).toHaveCount(0);
      await expect(page.getByText('Loading 3D viewport…')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Back to parts' })
      ).toBeVisible();
      await page.keyboard.press('b');
      await expect(
        page.getByRole('group', { name: 'Box command' })
      ).toHaveCount(0);
      if (process.env.OZ_RELOAD_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.OZ_RELOAD_SCREENSHOTS}/workspace-${width}-loading.png`
        });
    } finally {
      release();
    }
    await expect(page.locator('.workspace-reveal')).toHaveClass(/is-ready/, {
      timeout: 30_000
    });
    await expectBodyCount(page, 1);
    await expect(
      page.getByRole('status', { name: 'Restoring workspace' })
    ).toHaveCount(0);
    await expect(page.locator('.command-bar input')).toBeVisible();
    if (process.env.OZ_RELOAD_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.OZ_RELOAD_SCREENSHOTS}/workspace-${width}-ready.png`
      });
  });
}
