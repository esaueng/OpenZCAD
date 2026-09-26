import { expect, test } from '@playwright/test';
import {
  createProject,
  seedDismissedWorkspaceTour,
  stubApi
} from './openzcad-fixtures';

// The quiet stage: the top bar is three islands floating over the viewport,
// and the column is an island of its own — the verb rail, centred on the
// stage under them — not a panel sharing the bar's divider.
const ISLAND_GAP = 10;

for (const width of [1440, 390]) {
  test(`the column floats as an island under the top islands at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page);
    await seedDismissedWorkspaceTour(page);
    await createProject(page, 'Divider check');

    const column = page.locator('.workspace-column');
    await expect(column).toBeVisible();
    await expect(column).toHaveCSS('border-top-width', '1px');
    await expect(column).toHaveCSS('border-top-right-radius', '4px');
    // The bar draws no divider of its own; its islands carry the frames.
    await expect(page.locator('.topbar')).toHaveCSS(
      'border-bottom-width',
      '0px'
    );
    const topbarBounds = await page.locator('.topbar').boundingBox();
    // In Build the column is the verb rail, and both rails stand at the
    // middle of the stage under the top islands rather than hanging from
    // them: their centres share the stage's centre line, clear of the bar.
    const stageTop = topbarBounds!.y + topbarBounds!.height + ISLAND_GAP;
    const stageMiddle = stageTop + (900 - stageTop - ISLAND_GAP) / 2;
    // The rail's entry slides it in over 200ms; measure once it has landed.
    await expect
      .poll(async () => {
        const bounds = await column.boundingBox();
        return bounds!.y + bounds!.height / 2;
      })
      .toBeCloseTo(stageMiddle, 0);
    const columnBounds = await column.boundingBox();
    expect(columnBounds!.y).toBeGreaterThanOrEqual(stageTop - 0.5);
    // The instrument rail rises into place too; within 2px once it has,
    // since the translate lands on a half pixel for an odd height.
    const rail = page.locator('.instrument-rail');
    await expect
      .poll(async () => {
        const bounds = await rail.boundingBox();
        return Math.abs(bounds!.y + bounds!.height / 2 - stageMiddle);
      })
      .toBeLessThanOrEqual(2);
    await expect
      .poll(async () => (await column.boundingBox())!.x)
      .toBeCloseTo(ISLAND_GAP, 1);
    // Search lives in the bar at the foot of the stage now.
    await page.locator('.command-bar').click();
    await expect(
      page.getByRole('combobox', { name: 'Search commands' })
    ).toBeFocused();
    await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: 'Commands' })).toBeHidden();
    if (process.env.DIVIDER_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.DIVIDER_SCREENSHOT_DIR}/column-island-${width}.png`
      });
    }
  });
}
