import {
  test,
  expect,
  stubApi,
  selectBodyFromObjects
} from './openzcad-fixtures';

/**
 * Surfaces a click opens are loaded while the page is idle, so their first
 * open is not an empty frame. React.lazy suspends on a first render even with
 * the chunk prefetched (the module still evaluates asynchronously): Settings
 * opened blank and Move left a gap with neither the selection card nor its
 * panel for a few frames.
 */

declare global {
  interface Window {
    __firstUse?: { settingsBlank: number; moveGap: number; moving: boolean };
  }
}

test('Settings and Move open complete the first time', async ({ page }) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('First use');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  // The warm-up runs when the page is first idle, at the latest 5 s in.
  await page.waitForTimeout(6_000);
  await page.evaluate(() => {
    window.__firstUse = { settingsBlank: 0, moveGap: 0, moving: false };
    const sample = () => {
      const tally = window.__firstUse!;
      const settings = document.querySelector(
        '[role="dialog"][aria-label*="Settings"]:not([aria-busy="true"]), .settings-page'
      );
      if (settings && !/Settings/.test((settings as HTMLElement).innerText))
        tally.settingsBlank += 1;
      if (
        tally.moving &&
        !document.querySelector('.selection-card') &&
        !document.querySelector('form[aria-label="Move controls"]')
      )
        tally.moveGap += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings' }).first()
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to workspace' }).click();

  await selectBodyFromObjects(page);
  await expect(
    page.getByRole('button', { name: 'Selection: Move', exact: true })
  ).toBeVisible();
  await page.evaluate(() => {
    window.__firstUse!.moving = true;
  });
  await page
    .getByRole('button', { name: 'Selection: Move', exact: true })
    .click();
  await expect(page.locator('form[aria-label="Move controls"]')).toBeVisible();
  await page.waitForTimeout(300);

  expect(await page.evaluate(() => window.__firstUse)).toMatchObject({
    settingsBlank: 0,
    moveGap: 0
  });
});

test('Settings opened before the warm-up never shows an empty overlay', async ({
  page
}) => {
  await stubApi(page);
  // Hold the Settings chunk back so the click lands before it can load.
  await page.route(/SettingsPage[^/]*\.(js|tsx)(\?|$)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.addInitScript(() => {
    window.__firstUse = { settingsBlank: 0, moveGap: 0, moving: false };
    const sample = () => {
      const settings = document.querySelector(
        '[role="dialog"][aria-label*="Settings"]:not([aria-busy="true"])'
      );
      if (settings && !/Settings/.test((settings as HTMLElement).innerText))
        window.__firstUse!.settingsBlank += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('/');
  const create = page.getByRole('button', { name: 'Create project' });
  await expect(create).toBeVisible();
  const box = (await create.boundingBox())!;
  await page.getByRole('button', { name: 'Open settings' }).click();
  // Settings is still loading: the start screen behind takes no clicks.
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('.settings-pending') !== null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    )
  ).toBe(true);
  await expect(
    page.getByRole('heading', { name: 'Settings' }).first()
  ).toBeVisible();
  expect(await page.evaluate(() => window.__firstUse?.settingsBlank)).toBe(0);
});

test('Move launched before its panel loads keeps the selection card up', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Hold the Move panel's chunk until the launch is under way.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(/MoveOverlay[^/]*\.(js|tsx)(\?|$)/, async (route) => {
    await released;
    await route.continue();
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Early move');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await selectBodyFromObjects(page);
  const move = page.getByRole('button', {
    name: 'Selection: Move',
    exact: true
  });
  await expect(move).toBeVisible();
  await page.evaluate(() => {
    window.__firstUse = { settingsBlank: 0, moveGap: 0, moving: true };
    const sample = () => {
      if (
        !document.querySelector('.selection-card') &&
        !document.querySelector('form[aria-label="Move controls"]')
      )
        window.__firstUse!.moveGap += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await move.click();
  await page.waitForTimeout(500);
  release();
  await expect(page.locator('form[aria-label="Move controls"]')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__firstUse?.moveGap)).toBe(0);
});

test('a Move held for its panel is dropped when its selection is cleared', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(/MoveOverlay[^/]*\.(js|tsx)(\?|$)/, async (route) => {
    await released;
    await route.continue();
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Abandoned move');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await selectBodyFromObjects(page);
  await page
    .getByRole('button', { name: 'Selection: Move', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.selection-card')).toHaveCount(0);
  release();
  await page.waitForTimeout(1_000);
  await expect(page.locator('form[aria-label="Move controls"]')).toHaveCount(0);
});

test('Save-Data loads neither Settings nor the keypad speculatively', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await stubApi(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { saveData: true }
    });
  });
  const fetched: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    // MoveOverlay is left out: the command-card prefetch takes it as a card.
    if (/(NumericKeypad|SettingsPage)[^/]*\.js/.test(url)) fetched.push(url);
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Saving data');
  await page.getByRole('button', { name: 'Create project' }).click();
  // A tool card is up: within reach of the keypad, but nobody opened it.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await expect(
    page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
  ).toBeVisible();
  await page.waitForTimeout(6_000);
  expect(fetched).toEqual([]);
});

test('a Move held for its panel is dropped when the project is replaced', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(/MoveOverlay[^/]*\.(js|tsx)(\?|$)/, async (route) => {
    await released;
    await route.continue();
  });
  const createBoxProject = async (name: string) => {
    await page.getByLabel('Project name').fill(name);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('button', { name: /^Box \(B\)/ }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.selection-card')).toHaveCount(0);
  };
  await page.goto('/');
  await createBoxProject('First held');
  await page.getByTitle('Back to projects').click();
  await createBoxProject('Second held');
  // Move with nothing selected: its source is the project alone.
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  // Opening another project launches no tool, so only the source can tell
  // the held launch it no longer applies.
  await page.getByTitle('Back to projects').click();
  await page.locator('.start-tile-open', { hasText: 'First held' }).click();
  await expect(page.getByRole('button', { name: /^Move \(M\)/ })).toBeVisible();
  release();
  await page.waitForTimeout(1_000);
  await expect(page.locator('form[aria-label="Move controls"]')).toHaveCount(0);
});
