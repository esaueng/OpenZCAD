import { expect, test } from '@playwright/test';
import {
  createProject,
  seedDismissedWorkspaceTour,
  stubApi
} from './openzcad-fixtures';

/*
  Menus whose geometry outlived the layout they were written for. Both are
  correct CSS that lands in the wrong place, so no type or unit test sees
  them: the File menu kept a 320px cap after it grew to ~470px of content,
  and View mode's standard-views panel still opened upward after its bar
  moved to the top of the viewport.
*/

test('the File menu shows every section on a desktop window', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page);
  await seedDismissedWorkspaceTour(page);
  await createProject(page, 'File menu');

  await page.locator('details.file-menu > summary').click();
  const panel = page.locator('.topbar-menu-panel');
  await expect(panel).toBeVisible();
  const { clientHeight, scrollHeight } = await panel.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(scrollHeight).toBeLessThanOrEqual(clientHeight);
  await expect(
    panel.getByRole('button', { name: /Export interaction log/ })
  ).toBeInViewport();
});

test('View mode opens its standard views inside the window', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page);
  await seedDismissedWorkspaceTour(page);
  await createProject(page, 'Views panel');
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: 'View' })
    .click();
  await page
    .locator('.view-mode-bar')
    .getByRole('button', { name: 'Standard views' })
    .click();
  const front = page
    .locator('.view-mode-views-panel')
    .getByRole('button', { name: 'Front' });
  // Opened upward it sat at -67px: Front was off the top of the window.
  await expect(front).toBeInViewport({ ratio: 1 });
  await front.click();
  await expect(page.locator('.view-mode-views-panel')).toHaveCount(0);
});
