import type { Locator, Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * The 13 November design review's I47: on a phone, Measure hid what it
 * measures. Build's "More view tools" stayed open over the workbench (Angle
 * and Ø/R under it), and View's workbench across the foot had the scale
 * rule drawn over its text and the cube under it.
 */

async function openBracket(page: Page, width: number, height: number) {
  await stubApi(page, { commandFoldClosed: true });
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(
    page.getByRole('button', { name: 'Tweak', exact: true })
  ).toBeVisible({ timeout: 90_000 });
}

/** Whether a press at the control's centre reaches the control itself. */
function reachable(control: Locator) {
  return control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2
    );
    return hit !== null && element.contains(hit);
  });
}

// A phone: the short rail and its "More view tools" are drawn for a
// coarse pointer only.
test.use({ hasTouch: true, isMobile: true });

for (const width of [360, 390]) {
  test(`Build's Measure folds the view tools away at ${width}px`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    await openBracket(page, width, width === 360 ? 640 : 844);
    const more = page.getByRole('button', { name: 'More view tools' });
    await more.tap();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'Measure', exact: true }).tap();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    const workbench = page.locator('.measurement-dock');
    await expect(workbench).toBeVisible();
    for (const mode of ['Smart', 'Distance', 'Angle']) {
      const tab = workbench.getByRole('radio', { name: mode, exact: true });
      const control = (await tab.count())
        ? tab
        : workbench.getByRole('button', { name: mode, exact: true });
      await expect(control).toBeVisible();
      await expect.poll(() => reachable(control)).toBe(true);
    }
  });
}

test('View’s Measure on a phone keeps the rule and the cube off its sheet', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openBracket(page, 360, 640);
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: 'View' })
    .tap();
  const rule = page.locator('.viewport-scale-indicator');
  const cube = page.locator('.viewer-rail-stack');
  await expect(cube).toBeVisible();
  await page.getByRole('button', { name: 'Measure', exact: true }).tap();
  const workbench = page.locator('.measurement-dock');
  await expect(workbench).toBeVisible();
  await expect(rule).toBeHidden();
  await expect(cube).toBeHidden();
  await page.getByRole('button', { name: 'Measure', exact: true }).tap();
  await expect(workbench).toBeHidden();
  await expect(cube).toBeVisible();
});

test('View’s Measure on a tall phone shortens the rule to the room under its sheet', async ({
  page
}) => {
  test.setTimeout(120_000);
  // Tall enough that the rule stays on screen with the sheet up: it has to
  // re-measure when the sheet opens, without waiting for a window resize.
  await openBracket(page, 390, 844);
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: 'View' })
    .tap();
  const rule = page.getByTestId('viewport-scale-indicator');
  await expect(rule).toBeVisible();
  await page.getByRole('button', { name: 'Measure', exact: true }).tap();
  const workbench = page.locator('.measurement-dock');
  await expect(workbench).toBeVisible();
  await expect(rule).toBeVisible();
  await expect
    .poll(async () => {
      const scale = await rule.boundingBox();
      const dock = await workbench.boundingBox();
      return (
        scale !== null &&
        dock !== null &&
        (scale.y + scale.height <= dock.y ||
          scale.y >= dock.y + dock.height ||
          scale.x >= dock.x + dock.width)
      );
    })
    .toBe(true);
});
