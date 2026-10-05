import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  waitForStillViewport
} from './openzcad-fixtures';
import type { Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === 'passed')
    await testInfo.attach('verified-ui', {
      body: await page.screenshot(),
      contentType: 'image/png'
    });
});

async function create(page: Page, name: string) {
  await page.getByLabel('Project name').fill(name);
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
}
async function sketch(page: Page) {
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)', exact: true }).click();
  await waitForStillViewport(page);
  await expect(page.locator('.viewport-dock-grid')).not.toHaveText('');
  await page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: 'Line', exact: true })
    .click();
  await page.mouse.click(450, 350);
  await page.mouse.click(650, 350);
  await page.keyboard.press('Escape');
}

test('creating a project while sketching clears the old session and accepts a fresh sketch', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await create(page, 'QA switch source');
  await sketch(page);
  await page
    .getByRole('button', { name: 'OpenZCAD Beta', exact: true })
    .click();
  await create(page, 'QA switch destination');
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toHaveCount(
    0
  );
  await sketch(page);
  await expect(page.getByRole('contentinfo')).toContainText('Sketch 01');
  await expect(page.getByRole('contentinfo')).not.toContainText('not found');
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toHaveCount(
    0
  );
});

test('numeric value has a name and light-theme text meets contrast at the rendered surfaces', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await create(page, 'QA numeric accessibility');
  await sketch(page);
  await page
    .getByRole('toolbar', { name: 'Relations' })
    .getByRole('button', { name: 'Distance', exact: true })
    .click();
  await page.mouse.click(450, 350);
  await page.mouse.click(650, 350);
  await page.mouse.click(550, 300);
  const dialog = page.getByRole('dialog', { name: 'Distance value' });
  await expect(
    dialog.getByRole('textbox', { name: 'Distance', exact: true })
  ).toBeVisible();
  const ratios = await page.evaluate(() => {
    const lum = (color: string) => {
      const c = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722;
    };
    return [
      '.keypad-label',
      '.keypad-commit',
      '.keypad-units button:not(.active)',
      '.viewport-dock-filter-label'
    ].map((selector) => {
      const element = document.querySelector(selector)!;
      const foreground = getComputedStyle(element).color;
      let node: Element | null = element,
        background = 'rgb(255,255,255)';
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        if (!['rgba(0, 0, 0, 0)', 'transparent'].includes(bg)) {
          background = bg;
          break;
        }
        node = node.parentElement;
      }
      const a = lum(foreground),
        b = lum(background);
      return {
        selector,
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      };
    });
  });
  for (const { selector, ratio } of ratios)
    expect(ratio, selector).toBeGreaterThanOrEqual(4.5);
});

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [768, 650]
]) {
  test(`a long exact pattern can be terminated without changing the source or undo history at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width: width!, height: height! });
    await stubApi(page);
    await page.goto('/');
    await create(page, 'QA pattern cancel');
    await page.getByRole('button', { name: /^Box \(B\)/ }).click();
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    await inspector
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await expectBodyCount(page, 1);
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('/Circular pattern');
    await page.keyboard.press('Enter');
    await inspector
      .getByRole('textbox', { name: 'Count', exact: true })
      .fill('50');
    await inspector
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Pattern rebuild' })
    ).toBeVisible();
    const cancel = page.getByRole('button', {
      name: 'Cancel pattern',
      exact: true
    });
    // The full label, including the right edge, must clear the viewer rail.
    expect(
      await cancel.evaluate((button) => {
        const box = button.getBoundingClientRect();
        return [box.left + 2, box.left + box.width / 2, box.right - 2].every(
          (x) =>
            button.contains(
              document.elementFromPoint(x, box.top + box.height / 2)
            )
        );
      })
    ).toBe(true);
    await cancel.click();
    await expect(
      page.getByRole('region', { name: 'Pattern rebuild' })
    ).toHaveCount(0);
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).toContainText(
      'Pattern canceled; no change was applied.'
    );
    await page.keyboard.press('Escape');
    await page
      .getByRole('toolbar', { name: 'Viewer bar' })
      .getByRole('button', { name: 'Undo', exact: true })
      .click();
    await expectBodyCount(page, 0);
  });
}
