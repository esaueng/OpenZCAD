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
    // Gearbox (archived) is left unmeasured.
    ...(index < 3 ? { documentBytes: (index + 1) * 512 * 1024 } : {}),
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

test(
  'the list shows each project’s size under its Size heading',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLibrary(page);
    await page.getByRole('button', { name: 'List' }).click();
    const lid = page.locator('.start-tile-project', { hasText: 'Lid' });
    await expect(lid.locator('.start-tile-size')).toHaveText('512 KiB');
    // The folder totals its two brackets (1 MiB + 1.5 MiB).
    const folder = page.locator('.start-tile-folder', { hasText: 'Brackets' });
    await expect(folder.locator('.start-tile-size')).toHaveText('2.5 MiB');
    // Each value sits in the column its heading names, on one line.
    const heading = await page.locator('.start-list-head-size').boundingBox();
    const cell = await lid.locator('.start-tile-size').boundingBox();
    expect(Math.abs(cell!.x - heading!.x)).toBeLessThan(2);
    expect(cell!.height).toBeLessThan(24);

    // A narrow window gives the column back to the name.
    await page.setViewportSize({ width: 1050, height: 800 });
    await expect(page.locator('.start-list-head-size')).toBeHidden();
    await expect(lid.locator('.start-tile-size')).toBeHidden();
    const edited = await page
      .locator('.start-list-head span', { hasText: 'Edited' })
      .boundingBox();
    const when = await lid.locator('.start-tile-when').boundingBox();
    expect(Math.abs(when!.x - edited!.x)).toBeLessThan(2);
  }
);

// 15 Nov 2026 screen recording: a list row's actions menu opened under the
// rows after it. The pointer that opened it kept the row lifted (a hover
// transform), which trapped the menu's z-index inside the row, so the rows
// below painted through the menu and took the pointer from its items.
test(
  'a list row’s actions menu stays above the rows under it',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLibrary(page);
    await page.getByRole('button', { name: 'List' }).click();
    // A folder over the folder below it, and the lone pinned part over the
    // next group's rows.
    for (const name of ['Actions for folder Brackets', 'Actions for Lid']) {
      // The click leaves the pointer on the row, as a person's does.
      await page.getByRole('button', { name, exact: true }).click();
      const menu = page.getByRole('menu', { name, exact: true });
      await expect(menu).toBeVisible();
      const items = menu.getByRole('menuitem');
      expect(await items.count()).toBeGreaterThan(1);
      for (const item of await items.all()) {
        const label = await item.textContent();
        // Each item is what the pointer meets at its centre.
        expect(
          await item.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2
            );
            return hit !== null && element.contains(hit);
          }),
          `${name}: ${label}`
        ).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
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
  // Until the listing says the library is empty, the demos stand in the
  // column's one-wide list; measure the first-run grid once it is drawn.
  await expect(page.locator('.start-screen.is-fresh')).toBeVisible();
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

// 14 Nov 2026: a click into the suggested name put the caret where it
// landed, so a typed name ran into "Lucky Quokka" instead of replacing it.
test('a click into the suggested name selects it, so typing replaces it', async ({
  page
}) => {
  await openLibrary(page, false);
  const field = page.getByLabel('Project name');
  const suggestion = await field.inputValue();
  await field.click();
  await page.keyboard.type('Pump housing');
  await expect(field).toHaveValue('Pump housing');
  expect(suggestion).not.toBe('Pump housing');
  // Once typed over, a click places the caret like any field.
  await page.locator('body').click({ position: { x: 900, y: 600 } });
  // Past the text's end: the caret goes there, nothing is selected.
  const box = (await field.boundingBox())!;
  await field.click({ position: { x: box.width - 6, y: box.height / 2 } });
  await page.keyboard.type(' v2');
  await expect(field).toHaveValue('Pump housing v2');
});
