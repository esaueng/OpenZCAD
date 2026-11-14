import type { Page } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

// 13 November design review I15 and I17: the library's list view, shelf
// header, phone heading, Tab order and first-run demo cards.
const projects = ['Lid', 'Bracket A', 'Bracket B', 'Gearbox'].map(
  (name, index) => ({
    projectId: `polish-${index}`,
    name,
    revisionCount: 1,
    updatedAt: '2026-11-13T12:00:00.000Z',
    organization: {
      status: index === 3 ? 'archived' : 'active',
      pinned: index === 0,
      sortOrder: index
    }
  })
);

async function openLibrary(page: Page, withFolders = true) {
  await stubApi(page);
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: { projects } })
  );
  // Folders from this device alone; the account copy is not under test.
  await page.route('**/api/library-folders', (route) =>
    route.fulfill({
      status: 501,
      json: { code: 'LIBRARY_FOLDERS_DISABLED', error: 'Disabled.' }
    })
  );
  if (withFolders) {
    await page.addInitScript(() =>
      localStorage.setItem(
        'openzcad.library.folders.v1:user_e2e',
        JSON.stringify({
          folders: [
            {
              id: 'brackets',
              name: 'Brackets',
              projectIds: ['polish-1', 'polish-2'],
              pinned: false,
              createdAt: '2026-11-13T00:00:00.000Z'
            },
            {
              id: 'empty',
              name: 'Spare',
              projectIds: [],
              pinned: false,
              createdAt: '2026-11-13T00:00:00.000Z'
            }
          ]
        })
      )
    );
  }
  await page.goto('/');
  await expect(
    page.locator('.start-tile-name', { hasText: 'Lid' })
  ).toBeVisible();
}

test(
  'a folder row in the list keeps to the list’s columns',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLibrary(page);
    await page.getByRole('button', { name: 'List' }).click();
    const folder = page.locator('.start-tile-folder', { hasText: 'Brackets' });
    await expect(folder.locator('.start-tile-rev')).toHaveText('2 projects');
    await expect(folder.locator('.start-tile-when')).toHaveText('Nov 13, 2026');
    await expect(folder.locator('.start-tile-flags')).toBeEmpty();
    await expect(folder.locator('.start-folder-count')).toHaveCount(0);
    // No tab drawn over the row above it.
    expect(
      await folder.evaluate(
        (element) => getComputedStyle(element, '::before').display
      )
    ).toBe('none');
    // The count stays on one line in its column.
    const count = await folder.locator('.start-tile-rev').boundingBox();
    expect(count!.height).toBeLessThan(24);
    // The column head names the rows under the first label, not the label.
    const head = await page.locator('.start-list-head').boundingBox();
    const pinned = await page
      .locator('.start-group-label', { hasText: 'Pinned' })
      .boundingBox();
    expect(head!.y).toBeGreaterThan(pinned!.y);
  }
);

test('the shelf header holds still between Projects, Archive and Trash', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLibrary(page);
  const place = () =>
    page.evaluate(() => ({
      title: Math.round(
        document.querySelector('#start-parts-title')!.getBoundingClientRect()
          .top
      ),
      search: Math.round(
        document.querySelector('.start-search')!.getBoundingClientRect().left
      )
    }));
  const projectsShelf = await place();
  await page.getByRole('tab', { name: /^Archive/ }).click();
  await expect(page.locator('#start-parts-title')).toHaveText('Archive');
  expect(await place()).toEqual(projectsShelf);
  await page.getByRole('tab', { name: /^Trash/ }).click();
  await expect(page.locator('#start-parts-title')).toHaveText('Trash');
  expect(await place()).toEqual(projectsShelf);
});

test('a phone names the shelf once, in its strip', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLibrary(page, false);
  const heading = page.locator('#start-parts-title');
  // Kept for focus and assistive technology, clipped from sight.
  await expect(heading).toHaveText('Projects');
  expect((await heading.boundingBox())!.width).toBeLessThanOrEqual(1);
  await expect(
    page.getByRole('textbox', { name: 'Search projects' })
  ).toHaveAttribute('placeholder', 'Search…');
});

test('Tab starts at New project and stops once on each card', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLibrary(page, false);
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'New project' })).toBeFocused();

  const lid = page.getByRole('button', { name: /^Lid, edited Nov 13, 2026/ });
  await lid.focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: /^Bracket A, edited / })
  ).toBeFocused();
  // The card's other controls are an arrow away.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('checkbox', { name: 'Select Lid' })
  ).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+F10');
  await expect(
    page.getByRole('menu', { name: 'Actions for Lid' })
  ).toBeVisible();
});

test('the first-run demo cards go two to a row at 1024px', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await stubApi(page);
  await page.goto('/');
  const cards = page.locator('.start-learn .demo-card');
  await expect(cards.first()).toBeVisible();
  for (const card of await cards.all()) {
    expect((await card.boundingBox())!.width).toBeGreaterThan(240);
  }
});

test('Escape while naming a new folder unmakes it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLibrary(page, false);
  await page.getByRole('button', { name: 'New folder' }).click();
  const field = page.getByRole('textbox', { name: 'Folder name' });
  await expect(field).toBeFocused();
  await field.press('Escape');
  await expect(page.locator('.start-tile-folder')).toHaveCount(0);
  await expect(page.locator('.start-folder-notice')).toHaveText(
    'No folder made.'
  );
});
