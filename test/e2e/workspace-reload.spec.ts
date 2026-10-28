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

test('offline boot keeps restoring a saved local workspace without a connection demand', async ({
  page,
  context
}) => {
  await stubApi(page);
  await createProject(page, 'Offline local restore');
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/session', async (route) => {
    await gate;
    await route.fulfill({
      json: { userId: 'user_e2e', displayName: 'E2E user', mode: 'development' }
    });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('status', { name: 'Restoring workspace' })
    ).toBeVisible();
    await context.setOffline(true);
    await expect(
      page.getByText('Preparing your model and workspace')
    ).toBeVisible();
    await expect(page.getByText(/Connect to finish/)).toHaveCount(0);
    await expect(page.locator('.startup-card button')).toBeHidden();
  } finally {
    await context.setOffline(false);
    release();
  }
  await expect(page.locator('.workspace-reveal')).toHaveClass(/is-ready/, {
    timeout: 30_000
  });
  await expectBodyCount(page, 1);
});

for (const width of [1440, 390]) {
  test(`drawing reload keeps the restoration screen until its stage is ready at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page);
    await createProject(page, 'Drawing reload');
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    await page
      .getByRole('group', { name: 'Workspace mode' })
      .getByRole('button', { name: /^Draw(?: —|$)/ })
      .click();
    await expect(page.getByRole('region', { name: 'Drawings' })).toBeVisible();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route('**/assets/DrawingWorkspace-*.js', async (route) => {
      held = true;
      await gate;
      await route.continue();
    });
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => held).toBe(true);
      // All the other initial surfaces can prepare while just Draw is held.
      await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
        'data-e2e-rendered-bodies',
        '1'
      );
      await expect(page.locator('.command-bar input')).toBeAttached();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve())
              )
            );
          })
      );
      await expect(page.locator('.workspace-reveal')).toHaveAttribute('inert');
      await expect(
        page.getByRole('status', { name: 'Restoring workspace' })
      ).toBeVisible();
      await expect(page.getByRole('region', { name: 'Drawings' })).toHaveCount(
        0
      );
    } finally {
      release();
    }
    await expect(page.getByRole('region', { name: 'Drawings' })).toBeVisible();
    await expect(page.locator('.workspace-reveal')).not.toHaveAttribute(
      'inert'
    );
    await expect(
      page.getByRole('status', { name: 'Restoring workspace' })
    ).toHaveCount(0);
  });
}
