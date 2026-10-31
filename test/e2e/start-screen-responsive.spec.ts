import { test, expect, stubApi } from './openzcad-fixtures';
import type { Page } from '@playwright/test';

async function openLibrary(page: Page, width: number) {
  await page.setViewportSize({ width, height: 860 });
  await stubApi(page);
  const projects = Array.from({ length: 6 }, (_, index) => ({
    projectId: `responsive-part-${index + 1}`,
    name: `Responsive part ${index + 1}`,
    revisionCount: 1,
    updatedAt: '2026-09-29T12:00:00.000Z'
  }));
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: { projects } })
  );
  await page.goto('/');
  await expect(page.locator('.start-tile-project')).toHaveCount(6);
}

test(
  'the units picker leaves its chevron room inside its own border',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await openLibrary(page, 1440);
    const units = page.getByRole('combobox', { name: 'Units' });
    const box = await units.boundingBox();
    const form = await page.locator('.start-launch-form').boundingBox();
    if (!box || !form) throw new Error('Launch form is missing');
    expect(box.x + box.width).toBeLessThanOrEqual(form.x + form.width);
    const style = await units.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        appearance: computed.appearance,
        paddingRight: parseFloat(computed.paddingRight)
      };
    });
    // The drawn chevron sits in the padding, clear of the option text.
    expect(style.appearance).toBe('none');
    expect(style.paddingRight).toBeGreaterThanOrEqual(24);
  }
);

test(
  'a long sync sentence ellipsizes inside the column',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await openLibrary(page, 1440);
    // An auto grid track sized to the unwrapped sentence, so a long one ran
    // past the column's edge instead of ellipsizing.
    const text = page.locator('.start-account-text');
    await text.evaluate((element) => {
      element.textContent = 'All 89 projects saved to your account and more';
    });
    const box = await text.boundingBox();
    const column = await page.locator('.start-column-foot').boundingBox();
    if (!box || !column) throw new Error('Sync readout is missing');
    expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width);
    expect(
      await text.evaluate(
        (element) => element.scrollWidth > element.clientWidth
      )
    ).toBe(true);
  }
);

test(
  'a phone shows two cards a row and keeps the wordmark',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await openLibrary(page, 390);
    const cards = page.locator('.start-tile-project');
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    if (!first || !second) throw new Error('Cards are missing');
    expect(Math.abs(first.y - second.y)).toBeLessThan(1);
    await expect(page.locator('.start-brand .beta-tag')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
  }
);

for (const width of [1200, 1000, 901, 700, 561]) {
  test(`the shelf toolbar stays on one line at ${width}px`, async ({
    page
  }) => {
    await openLibrary(page, width);
    const toolbar = page.locator('.start-toolbar');
    const filters = await page.locator('.start-filters').boundingBox();
    const tools = await page.locator('.start-toolbar-tools').boundingBox();
    if (!filters || !tools) throw new Error('Toolbar is missing');
    expect(
      Math.abs(filters.y + filters.height / 2 - (tools.y + tools.height / 2))
    ).toBeLessThan(4);
    expect(
      await toolbar.evaluate(
        (element) => element.scrollWidth <= element.clientWidth
      )
    ).toBe(true);

    // A folded search opens over the line without moving it.
    await page.getByLabel('Search projects').fill('part 1');
    await expect(page.getByLabel('Search projects')).toHaveValue('part 1');
    const after = await page.locator('.start-toolbar-tools').boundingBox();
    expect(after?.y).toBeCloseTo(tools.y, 0);
    expect(
      await page
        .getByLabel('Search projects')
        .evaluate((element) => element.getBoundingClientRect().width)
    ).toBeGreaterThan(120);
  });
}

test('a phone wraps the shelf tools under the filters', async ({ page }) => {
  await openLibrary(page, 390);
  const filters = await page.locator('.start-filters').boundingBox();
  const tools = await page.locator('.start-toolbar-tools').boundingBox();
  if (!filters || !tools) throw new Error('Toolbar is missing');
  expect(tools.y).toBeGreaterThanOrEqual(filters.y + filters.height - 1);
});
