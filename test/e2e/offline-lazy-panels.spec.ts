import {
  createPrimitiveInPlace,
  test,
  expect,
  createProject,
  expectBodyCount,
  MODEL_ONLY,
  promptField,
  stubApi
} from './openzcad-fixtures';
import type { Page } from '@playwright/test';

async function baseline(page: Page) {
  await stubApi(page, { panelLayout: MODEL_ONLY, commandFoldClosed: true });
  await createProject(page, 'QA panel recovery');
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  return page.evaluate(() => performance.timeOrigin);
}

async function preservedWorkspace(page: Page, timeOrigin: number) {
  await expect(page.locator('.viewer-host canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeEnabled();
  await expectBodyCount(page, 1);
  await expect(page.locator('.error-page')).toHaveCount(0);
  await expect(page.getByText('OpenZCAD has been updated')).toHaveCount(0);
  await expect(
    page.getByText('A newer OpenZCAD build is available.')
  ).toHaveCount(0);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
}

async function historyUndoRedo(page: Page) {
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 0);
  await expect(page.locator('.feature-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 1);
  await expect(page.locator('.feature-row')).toHaveCount(1);
}

test('offline first-open History waits locally and reconnects without reloading', async ({
  page,
  context
}, testInfo) => {
  const timeOrigin = await baseline(page);
  const coldRequests: string[] = [];
  page.on('request', (request) => {
    if (
      /\/(ModelPanel|ParameterRows|FeatureHistoryPanel)-.*\.js$/.test(
        request.url()
      )
    )
      coldRequests.push(request.url());
  });
  await context.setOffline(true);
  await page
    .getByRole('button', { name: 'History panel', exact: true })
    .click();
  await expect(
    page.getByText('Connect to the internet to load this panel.')
  ).toBeVisible();
  expect(coldRequests).toEqual([]);
  await preservedWorkspace(page, timeOrigin);
  await page
    .getByRole('button', { name: 'History panel', exact: true })
    .click();
  await expect(
    page.getByText('Connect to the internet to load this panel.')
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'History panel', exact: true })
    .click();
  await expect(
    page.getByText('Connect to the internet to load this panel.')
  ).toBeVisible();
  await testInfo.attach('offline-local-waiting-panel', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  await context.setOffline(false);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await expect(
    page.getByText('Connect to the internet to load this panel.')
  ).toHaveCount(0);
  await preservedWorkspace(page, timeOrigin);
  await historyUndoRedo(page);
  await context.setOffline(true);
  await page
    .getByRole('button', { name: 'History panel', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'History panel', exact: true })
    .click();
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await expect(
    page.getByText('Connect to the internet to load this panel.')
  ).toHaveCount(0);
  await testInfo.attach('history-recovered-without-navigation', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
});

test('opening Tweak offline cannot poison the shared Parameters download before History', async ({
  page,
  context
}) => {
  const timeOrigin = await baseline(page);
  const coldRequests: string[] = [];
  page.on('request', (request) => {
    if (
      /\/(TweakPanel|ViewModeBar|ModelPanel|ParameterRows|FeatureHistoryPanel)-.*\.js$/.test(
        request.url()
      )
    )
      coldRequests.push(request.url());
  });
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Tweak', exact: true }).click();
  const parametersLoading = page
    .getByRole('status')
    .filter({ hasText: 'Parameters panel is not loaded yet.' });
  await expect(parametersLoading).toBeVisible();
  await expect(parametersLoading).toContainText(
    'Connect to the internet to load this panel.'
  );
  expect(coldRequests).toEqual([]);
  await expect(page.locator('.error-page')).toHaveCount(0);
  await page.getByRole('button', { name: 'Build', exact: true }).click();
  await page
    .getByRole('button', { name: 'History panel', exact: true })
    .click();
  expect(coldRequests).toEqual([]);
  await preservedWorkspace(page, timeOrigin);
  await context.setOffline(false);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await preservedWorkspace(page, timeOrigin);
});

test('a parameter command focuses its cached expression while offline', async ({
  page,
  context
}) => {
  const timeOrigin = await baseline(page);
  const parameters = page.getByRole('button', {
    name: 'Parameters panel',
    exact: true
  });
  await parameters.click();
  await page.getByLabel('New parameter name').fill('panel_width');
  await page.getByLabel('New parameter expression').fill('30');
  await page
    .getByRole('button', { name: 'Add parameter', exact: true })
    .click();
  const expression = page.getByRole('textbox', {
    name: 'Expression for panel_width',
    exact: true
  });
  await expect(expression).toHaveValue('30');
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  await parameters.click();
  await expect(expression).toHaveCount(0);

  const coldRequests: string[] = [];
  page.on('request', (request) => {
    if (
      /\/(ModelPanel|ParameterRows|FeatureHistoryPanel)-.*\.js$/.test(
        request.url()
      )
    )
      coldRequests.push(request.url());
  });
  await context.setOffline(true);
  await promptField(page).fill('/panel_width');
  await page
    .getByRole('option')
    .filter({ hasText: 'panel_width' })
    .filter({ hasText: 'Parameter' })
    .click();
  await expect(expression).toBeVisible();
  await expect(expression).toBeFocused();
  await expect(expression).toHaveValue('30');
  expect(coldRequests).toEqual([]);
  await expect(
    page.getByText('Connect to the internet to load this panel.')
  ).toHaveCount(0);
  await preservedWorkspace(page, timeOrigin);
});

for (const chunk of ['ModelPanel', 'ParameterRows', 'FeatureHistoryPanel']) {
  test(`an online ${chunk} rejection stays local and offers an honest durable reload`, async ({
    page
  }) => {
    const timeOrigin = await baseline(page);
    let blocked = true;
    let failures = 0;
    await page.route(`**/assets/${chunk}-*.js`, (route) => {
      if (blocked) {
        failures += 1;
        return route.abort('internetdisconnected');
      }
      return route.continue();
    });
    await page
      .getByRole('button', { name: 'History panel', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Reload workspace', exact: true })
    ).toBeVisible();
    expect(failures).toBeGreaterThan(0);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await preservedWorkspace(page, timeOrigin);
    await expect(page.getByRole('button', { name: 'Retry panel' })).toHaveCount(
      0
    );
    blocked = false;
    await page
      .getByRole('button', { name: 'Reload workspace', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: /^Box \(B\)/ })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Reload workspace', exact: true })
    ).toHaveCount(0);
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
      timeOrigin
    );
    await historyUndoRedo(page);
  });
}
