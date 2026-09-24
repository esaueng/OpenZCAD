import { expect, test } from '@playwright/test';
import {
  createProject,
  seedDismissedWorkspaceTour,
  stubApi
} from './openzcad-fixtures';

// The quiet stage: the top bar is three islands floating over the viewport,
// and the column is an island of its own one gap below them, not a panel
// sharing the bar's divider.
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
    const columnBounds = await column.boundingBox();
    expect(columnBounds!.y).toBeCloseTo(
      topbarBounds!.y + topbarBounds!.height + ISLAND_GAP,
      1
    );
    expect(columnBounds!.x).toBeCloseTo(ISLAND_GAP, 1);
    // Search lives in the bar at the foot of the stage now.
    await page.locator('.command-bar').click();
    await expect(
      page.getByRole('textbox', { name: 'Search commands' })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('textbox', { name: 'Search commands' })
    ).toBeHidden();
    if (process.env.DIVIDER_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.DIVIDER_SCREENSHOT_DIR}/column-island-${width}.png`
      });
    }
  });
}
