import { expect, test, type Locator, type Page } from '@playwright/test';
import { createPrimitiveInPlace, stubApi } from './openzcad-fixtures';

/**
 * The verb rail is the user's: tools are pinned by dragging them from the
 * More tools drawer onto it, reordered by dragging along it, and unpinned by
 * dragging them back onto the drawer. These run the browser's own drag and
 * drop, which the component tests can only imitate.
 */

const pinnedTools = (page: Page) =>
  page
    .locator('nav[aria-label="Feature tools"] [data-pinned-tool]')
    .evaluateAll((buttons) =>
      buttons.map((button) => (button as HTMLElement).dataset.pinnedTool)
    );

/**
 * Drags with the pointer the way a hand does: down on the source, across in
 * steps, a pause and a nudge over the target, then up. The landing slot
 * opens under the pointer as it arrives; the browser only drops onto what
 * the latest dragover accepted, and a hand keeps sending them.
 */
async function drag(page: Page, source: Locator, target: Locator, y = 4) {
  const from = (await source.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const to = (await target.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + y, { steps: 8 });
  await page.waitForTimeout(100);
  const settled = (await target.boundingBox())!;
  await page.mouse.move(settled.x + settled.width / 2, settled.y + y - 2, {
    steps: 2
  });
  await page.mouse.up();
}

async function openFreshDevice(page: Page) {
  // A new device: the drawer closed, simple and listing what fits.
  await stubApi(page, { commandFoldClosed: true });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Pinned Rail');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await page.keyboard.press('Escape');
}

test(
  'pins a tool dragged from the simple drawer onto the rail, and keeps it',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await openFreshDevice(page);
    await page.getByRole('button', { name: /^More tools/ }).click();
    const drawer = page.locator('.command-flyout');
    await expect(drawer).toHaveClass(/is-simple/);
    // Simple: no search, and nothing the rail already carries.
    await expect(drawer.getByRole('searchbox')).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: /^Sphere/ })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /Box/ })).toHaveCount(0);

    // Dropped on Cylinder's upper half, Sphere lands just before it.
    const cylinder = page.locator('[data-pinned-tool="cylinder"]');
    await drag(page, drawer.getByRole('button', { name: /^Sphere/ }), cylinder);
    await expect
      .poll(() => pinnedTools(page))
      .toEqual([
        'sketch',
        'extrude',
        'box',
        'sphere',
        'cylinder',
        'fillet',
        'hole',
        'transform',
        'union'
      ]);
    // Pinned, it leaves the simple list for the rail.
    await expect(drawer.getByRole('button', { name: /^Sphere/ })).toHaveCount(
      0
    );

    await page.reload();
    await expect.poll(() => pinnedTools(page)).toContain('sphere');
  }
);

test('reorders a pin along the rail and unpins one dropped on the drawer', async ({
  page
}) => {
  await openFreshDevice(page);
  await page.getByRole('button', { name: /^More tools/ }).click();
  await page.getByRole('button', { name: /^All tools & pins/ }).click();
  const drawer = page.locator('.command-flyout');
  await expect(drawer).toHaveClass(/is-advanced/);

  // Union, greyed with one body, still drags: onto Sketch's upper half it
  // heads the rail.
  await drag(
    page,
    page.locator('[data-pinned-tool="union"]'),
    page.locator('[data-pinned-tool="sketch"]')
  );
  await expect.poll(async () => (await pinnedTools(page))[0]).toBe('union');

  // Hole, dropped on the drawer, comes off the rail; its row's pin clears.
  await drag(
    page,
    page.locator('[data-pinned-tool="hole"]'),
    drawer.locator('.command-flyout-list'),
    60
  );
  await expect.poll(() => pinnedTools(page)).not.toContain('hole');
  await expect(
    drawer.getByRole('button', { name: 'Pin Hole to the rail' })
  ).toHaveAttribute('aria-pressed', 'false');
});
