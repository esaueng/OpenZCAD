import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  waitForStillViewport,
  clickWorldPoint,
  enterCommandValue,
  finishInPlaceCommand,
  pickObjectsBody,
  revealModelPanel,
  createPrimitiveInPlace
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
      '.viewport-dock-snap'
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
    test.setTimeout(120_000);
    await page.setViewportSize({ width: width!, height: height! });
    await stubApi(page);
    await page.goto('/');
    await create(page, 'QA pattern cancel');
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    // Off the Z axis, so three copies about it stay apart: a world axis
    // through the corner-origin box would run along an edge they all share,
    // which exact union refuses.
    await createPrimitiveInPlace(page, 'box', { at: { x: '20' } });
    await expectBodyCount(page, 1);
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('/Circular pattern');
    await page.keyboard.press('Enter');
    // U09: a new pattern runs in place: the box, a click on the world Z axis
    // below it, the count from its chip's keypad. A short one previews at
    // once; the long rebuild this spec terminates is the edit below.
    const bar = page.getByRole('group', { name: 'Circular pattern command' });
    await expect(bar).toContainText('Click the body to repeat');
    await pickObjectsBody(page, 'Box 1');
    await expect(bar).toContainText('Pick the axis');
    // The More tools fold is seeded open, and at narrow widths it covers
    // the stage the axis is clicked on.
    const fold = page.getByRole('button', { name: /^More tools/ });
    if ((await fold.getAttribute('aria-expanded')) === 'true') {
      await fold.click();
    }
    await waitForStillViewport(page);
    await clickWorldPoint(page, [0, 0, -5]);
    await expect(bar).toContainText('Drag the total angle');
    await enterCommandValue(page, 'count', '3');
    await finishInPlaceCommand(page, 'Circular pattern');
    const counts = page
      .getByRole('group', { name: 'Workspace status' })
      .getByLabel(/ · \d+ features? · \d+ bod(y|ies)\. Sync /);
    const bodiesNow = async () =>
      Number(
        / · (\d+) bod/.exec(
          (await counts.getAttribute('aria-label')) ?? ''
        )?.[1]
      );
    const patterned = await bodiesNow();
    // Editing it to fifty copies is the long exact rebuild.
    await revealModelPanel(page, 'History');
    // U09 phase 7: the row re-arms the pattern in place; its count chip
    // takes the new count, and Done runs the commit through the pattern
    // runner, which can be stopped.
    await page
      .locator('.feature-row-main', { hasText: 'Circular pattern' })
      .click();
    await expect(
      page.getByRole('group', { name: 'Edit Circular pattern command' })
    ).toBeVisible();
    await enterCommandValue(page, 'count', '50');
    await page
      .getByRole('group', { name: 'Edit Circular pattern command' })
      .getByRole('button', { name: /Done/ })
      .click({ timeout: 90_000 });
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
    expect(await bodiesNow()).toBe(patterned);
    await expect(page.getByRole('contentinfo')).toContainText(
      'Pattern canceled; no change was applied.'
    );
    await page.keyboard.press('Escape');
    await page
      .getByRole('toolbar', { name: 'Viewer bar' })
      .getByRole('button', { name: 'Undo', exact: true })
      .click();
    // The canceled edit left no undo step: Undo takes back the pattern.
    await expectBodyCount(page, 1);
  });
}
