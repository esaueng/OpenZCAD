import type { Page } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

/*
 * A library card moves by pressing anywhere on it and dragging: there is no
 * grip. The press must stay a click when it does not travel, the drop must
 * not open the part it lands on, and Escape must put the order back.
 */
const names = ['Reorder alpha', 'Reorder bravo', 'Reorder charlie'];
const projects = names.map((name, index) => ({
  projectId: `reorder-${index}`,
  name,
  revisionCount: 1,
  updatedAt: '2026-10-21T12:00:00.000Z',
  organization: { status: 'active', pinned: false, sortOrder: index }
}));

const card = (page: Page, name: string) =>
  page.locator('.start-tile-project', { hasText: name });

async function cardOrder(page: Page) {
  return page.locator('.start-tile-name').allTextContents();
}

/** Presses on a card's preview and drags it onto another card's centre. */
async function dragCard(page: Page, from: string, to: string) {
  const source = await card(page, from)
    .locator('.start-tile-thumb')
    .boundingBox();
  const target = await card(page, to).boundingBox();
  if (!source || !target) {
    throw new Error('Cards have no layout box');
  }
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 12 }
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page);
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: { projects } })
  );
  await page.goto('/');
  await expect.poll(() => cardOrder(page)).toEqual(names);
});

test(
  'drags a library card from anywhere on it into a new place',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await expect(page.locator('.start-tile-grip')).toHaveCount(0);
    await dragCard(page, names[0]!, names[2]!);
    // The others reflow live while the card is held.
    await expect
      .poll(() => cardOrder(page))
      .toEqual([names[1], names[2], names[0]]);
    await expect(card(page, names[0]!)).toHaveClass(/is-dragging/);
    await page.mouse.up();

    await expect(card(page, names[0]!)).not.toHaveClass(/is-dragging/);
    await expect
      .poll(() => cardOrder(page))
      .toEqual([names[1], names[2], names[0]]);
    // The drop is not a click: the library is still on screen.
    await expect(page.locator('.start-tile-project')).toHaveCount(3);
  }
);

test('Escape puts a dragged card back', async ({ page }) => {
  await dragCard(page, names[2]!, names[0]!);
  await expect
    .poll(() => cardOrder(page))
    .toEqual([names[2], names[0], names[1]]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => cardOrder(page)).toEqual(names);
  await expect(page.locator('.start-tile-project')).toHaveCount(3);
});
