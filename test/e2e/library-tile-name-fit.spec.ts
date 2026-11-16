import type { Page } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

// A long folder name ran to five lines in its card, and a long project name
// lost its distinguishing end ("… VERSION 2") to an end ellipsis. Both now
// keep to two lines, shortened in the middle.
const LONG_FOLDER =
  'awpodjpopojwapjodpjoawpojapwdjopjoawdpojaopwjdpoajwdpojapowjdopjawd';
const LONG_PROJECT = 'OAWIHDOIAWHDOIHAWawdawdOAWIHDOIAWHDOIHAWawdawd VERSION 2';

const projects = ['Lid', LONG_PROJECT].map((name, index) => ({
  projectId: `fit-${index}`,
  name,
  revisionCount: 1,
  updatedAt: '2026-11-13T12:00:00.000Z',
  organization: { status: 'active', pinned: false, sortOrder: index }
}));

async function openLibrary(page: Page) {
  await stubApi(page);
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: { projects } })
  );
  await page.route('**/api/library-folders', (route) =>
    route.fulfill({
      status: 501,
      json: { code: 'LIBRARY_FOLDERS_DISABLED', error: 'Disabled.' }
    })
  );
  await page.addInitScript((name) => {
    localStorage.setItem(
      'openzcad.library.folders.v1:user_e2e',
      JSON.stringify({
        folders: [
          {
            id: 'long',
            name,
            projectIds: [],
            pinned: false,
            createdAt: '2026-11-13T00:00:00.000Z'
          }
        ]
      })
    );
  }, LONG_FOLDER);
  await page.goto('/');
  await expect(
    page.locator('.start-tile-name', { hasText: 'Lid' })
  ).toBeVisible();
}

/** Rendered lines of a tile name, from its height and its line height. */
async function lineCount(page: Page, tile: string) {
  return page
    .locator('.start-tile', { has: page.locator(`[title="${tile}"]`) })
    .locator('.start-tile-name')
    .evaluate((element) => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(element).lineHeight
      );
      const line = Number.isFinite(lineHeight)
        ? lineHeight
        : Number.parseFloat(getComputedStyle(element).fontSize) * 1.2;
      return Math.round(element.getBoundingClientRect().height / line);
    });
}

test(
  'long folder and project names keep to two lines, shortened in the middle',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLibrary(page);

    const folder = page.locator(`.start-tile-name[title="${LONG_FOLDER}"]`);
    const project = page.locator(`.start-tile-name[title="${LONG_PROJECT}"]`);

    const folderShort = folder.locator('.start-tile-name-short');
    await expect(folderShort).toHaveText(/^awpodjpopo.*….*jawd$/);
    expect(await lineCount(page, LONG_FOLDER)).toBeLessThanOrEqual(2);

    const projectShort = project.locator('.start-tile-name-short');
    await expect(projectShort).toHaveText(/^OAWIHDOIAWHD.*….*VERSION 2$/);
    expect(await lineCount(page, LONG_PROJECT)).toBeLessThanOrEqual(2);
    // Two lines are used, not one: the fit is the longest that still fits.
    expect(await lineCount(page, LONG_PROJECT)).toBe(2);

    // A wider card refits to show more of the name.
    const before = (await projectShort.textContent())!.length;
    await page.setViewportSize({ width: 1900, height: 900 });
    await expect
      .poll(async () => (await projectShort.textContent())?.length ?? 0)
      .toBeGreaterThanOrEqual(before);
    expect(await lineCount(page, LONG_PROJECT)).toBeLessThanOrEqual(2);

    // The full names stay on the tile buttons for assistive technology.
    await expect(
      page.getByRole('button', {
        name: `Open folder ${LONG_FOLDER}, 0 projects`
      })
    ).toBeVisible();
  }
);
