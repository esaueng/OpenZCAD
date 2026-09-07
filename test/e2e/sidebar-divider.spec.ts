import { expect, test } from '@playwright/test';
import {
  createProject,
  seedDismissedWorkspaceTour,
  stubApi
} from './openzcad-fixtures';

for (const width of [1440, 390]) {
  test(`sidebar shares the top bar divider at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page);
    await seedDismissedWorkspaceTour(page);
    await createProject(page, 'Divider check');

    const column = page.locator('.workspace-column');
    await expect(column).toBeVisible();
    await expect(column).toHaveCSS('border-top-width', '0px');
    await expect(column).toHaveCSS('border-top-right-radius', '0px');
    await expect(page.locator('.topbar')).toHaveCSS(
      'border-bottom-width',
      '1px'
    );
    const topbarBounds = await page.locator('.topbar').boundingBox();
    const columnBounds = await column.boundingBox();
    expect(columnBounds!.y).toBeCloseTo(
      topbarBounds!.y + topbarBounds!.height,
      1
    );
    await column.locator('.workspace-column-search').click();
    await expect(
      page.getByRole('textbox', { name: 'Search commands' })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('textbox', { name: 'Search commands' })
    ).toBeHidden();
    if (process.env.DIVIDER_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.DIVIDER_SCREENSHOT_DIR}/divider-${width}.png`
      });
    }
  });
}
