import {
  test,
  expect,
  createProject,
  expectBodyCount,
  stubApi
} from './openzcad-fixtures';
import type { Page } from '@playwright/test';

async function addPrimitive(page: Page, tool: RegExp) {
  await page.getByRole('button', { name: tool }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
}

/**
 * The journey that lost its card: the only capture used to be an idle timer
 * in the workspace, so a part modelled and left straight away listed as a
 * placeholder until it was reopened and left idle. Every step here leaves
 * within the old four-second window on purpose.
 */
test('a part modelled and left at once lists with its card preview', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Thumbnail Box');
  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);
  await page.getByTitle('Back to projects').click();

  const tile = page.locator('.start-tile', { hasText: 'Thumbnail Box' });
  const image = tile.locator('.start-tile-thumb img');
  await expect(image).toHaveAttribute('src', /^data:image\/webp;base64,/);
  const boxCard = await image.getAttribute('src');

  // The record is on disk, not in React state: a fresh load reads it back.
  await page.reload();
  await expect(tile.locator('.start-tile-thumb img')).toHaveAttribute(
    'src',
    boxCard ?? ''
  );

  // A later edit followed by the same quick exit replaces the card rather
  // than leaving the earlier picture standing.
  await tile.locator('.start-tile-open').click();
  await expectBodyCount(page, 1);
  await addPrimitive(page, /^Cylinder \(C\)/);
  await expectBodyCount(page, 2);
  await page.getByTitle('Back to projects').click();
  await expect(tile.locator('.start-tile-thumb img')).not.toHaveAttribute(
    'src',
    boxCard ?? ''
  );
  await expect(tile.locator('.start-tile-thumb img')).toHaveAttribute(
    'src',
    /^data:image\/webp;base64,/
  );
});
