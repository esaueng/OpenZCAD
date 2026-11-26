import type { Locator, Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';
import { smallTouchTargets } from './touch-hit-area';

/**
 * The compact layout's pages beyond the stage (U12 slice 10): the library,
 * the project sheet, Settings as a pushed list, the full-screen command
 * search and the modeling guide. Turned on for this device with
 * Settings › Appearance › Layout (`openzcad.layout:v1`), and driven with
 * taps alone: no keyboard shortcut, no hover, no right button. Typing a
 * name or a search into a field is the only text entry.
 */
const SIZES = [
  { width: 390, height: 844 },
  { width: 360, height: 640 }
];

const LAYOUT_KEY = 'openzcad.layout:v1';

test.use({ hasTouch: true, isMobile: true });

async function preferCompact(page: Page) {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem('compact-seeded')) {
      sessionStorage.setItem('compact-seeded', '1');
      localStorage.setItem(key, 'compact');
    }
  }, LAYOUT_KEY);
}

async function openCompactLibrary(
  page: Page,
  options: { workspaceTour?: boolean } = {}
) {
  await stubApi(page, options);
  await preferCompact(page);
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Shelves' })).toBeVisible({
    timeout: 60_000
  });
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'compact');
}

/** From the compact library: a new project, open in the compact workspace. */
async function newProject(page: Page, name: string) {
  await page.getByLabel('Project name').first().fill(name);
  await page.getByRole('button', { name: 'New project' }).tap();
  await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible({
    timeout: 60_000
  });
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 60_000
  });
}

async function backToLibrary(page: Page) {
  await page
    .locator('.compact-header')
    .getByRole('button', { name: 'Back to projects' })
    .tap();
  await expect(page.getByRole('group', { name: 'Shelves' })).toBeVisible({
    timeout: 60_000
  });
}

/** Every finite animation at rest: a sheet fading in reads as transparent. */
function settled(page: Page) {
  return page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getComputedTiming().iterations === Infinity
      )
  );
}

/** No control under 44 px, measured from its centre as a finger meets it. */
async function expectTouchSized(page: Page, within: string) {
  await settled(page);
  const small = await smallTouchTargets(page, { within });
  expect(
    small.map(
      (target) =>
        `${target.kind} "${target.name}" ${target.hit.width}×${target.hit.height} — ${target.blockedBy.join('; ')}`
    ),
    `controls under 44 px in ${within}`
  ).toEqual([]);
}

/**
 * Every control drawn at least 44 px on both axes: for a scrolling sheet,
 * whose rows at its scroll edge are cut by it whatever their size.
 */
async function expectDrawnSized(page: Page, within: string) {
  await settled(page);
  const small = await page.evaluate((selector) => {
    const found: string[] = [];
    for (const root of document.querySelectorAll(selector)) {
      for (const control of root.querySelectorAll<HTMLElement>(
        'button, input:not([type="hidden"]), select, a[href], [role="radio"], [role="menuitem"]'
      )) {
        const box = control.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (getComputedStyle(control).visibility !== 'visible') continue;
        if (box.width < 44 || box.height < 44) {
          found.push(
            `${control.getAttribute('aria-label') ?? control.textContent?.trim()} ${Math.round(box.width)}×${Math.round(box.height)}`
          );
        }
      }
    }
    return found;
  }, within);
  expect(small, `controls drawn under 44 px in ${within}`).toEqual([]);
}

/** Wholly on screen. */
async function expectOnScreen(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 0.5);
  return box!;
}

/** A finger dragged left across a row, as a swipe. */
async function swipeLeft(page: Page, row: Locator) {
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const y = box.y + box.height / 2;
  let x = box.x + box.width * 0.45;
  const touch = (type: string, points: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type: type as 'touchStart',
      touchPoints: points
    });
  await touch('touchStart', [{ x, y }]);
  for (let step = 0; step < 10; step += 1) {
    x -= 16;
    await touch('touchMove', [{ x, y }]);
  }
  await touch('touchEnd', []);
  await cdp.detach();
}

const tile = (page: Page, name: string) =>
  page.locator('.start-tile-project', {
    has: page.getByRole('button', { name: new RegExp(`^${name},`) })
  });

/** Runs a command from the header's search, full-screen, by taps. */
async function runCommand(page: Page, name: string) {
  await page
    .getByRole('button', { name: 'Open the command bar', exact: true })
    .tap();
  const field = page.getByRole('combobox', { name: 'Search commands' });
  await expect(field).toBeVisible();
  await field.fill(name);
  await page
    .getByRole('option', { name: new RegExp(`^${name}`) })
    .first()
    .tap();
  const bar = page
    .locator('.compact-sheet')
    .getByRole('group', { name: `${name} command` });
  await expect(bar).toBeVisible();
  const done = bar.getByRole('button', { name: /Done/ });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await done.tap();
  await expect(bar).toHaveCount(0);
}

async function openProjectSheet(page: Page, name: string) {
  await page
    .locator('.compact-header')
    .getByRole('button', { name, exact: true })
    .tap();
  const sheet = page.locator('.compact-sheet');
  await expect(sheet.getByRole('heading', { name: 'Project' })).toBeVisible();
  return sheet;
}

for (const size of SIZES) {
  const at = `${size.width}×${size.height}`;
  // The phone the design reviews measure runs in CI's smoke shards.
  const smoke = size.width === 390 ? { tag: '@ci-smoke' } : {};

  test(
    `library at ${at}: shelves, search, archive by swipe and by the action sheet, a demo`,
    smoke,
    async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(size);
      await openCompactLibrary(page);
      for (const name of ['Alpha part', 'Beta part']) {
        await newProject(page, name);
        await backToLibrary(page);
      }
      await expectTouchSized(page, '.compact-library-head');

      const shelves = page.getByRole('group', { name: 'Shelves' });
      const projects = shelves.getByRole('button', { name: 'Projects' });
      await expect(projects).toHaveAttribute('aria-pressed', 'true');
      await expect(tile(page, 'Alpha part')).toBeVisible();
      await expect(tile(page, 'Beta part')).toBeVisible();

      // Search on top narrows the shelf.
      const search = page.getByRole('searchbox', { name: 'Search projects' });
      await search.tap();
      await search.fill('Beta');
      await expect(tile(page, 'Alpha part')).toHaveCount(0);
      await expect(tile(page, 'Beta part')).toBeVisible();
      await page
        .locator('.compact-library-head')
        .getByRole('button', { name: 'Clear search' })
        .tap();
      await expect(tile(page, 'Alpha part')).toBeVisible();

      // Swiped left, a row offers Archive and Trash.
      await swipeLeft(page, tile(page, 'Alpha part'));
      const actions = tile(page, 'Alpha part').getByRole('group', {
        name: 'Row actions'
      });
      await expect(actions).toBeVisible();
      await expectTouchSized(page, '.compact-swipe-actions');
      await expect(
        actions.getByRole('button', { name: 'Move Alpha part to trash' })
      ).toBeVisible();
      await actions.getByRole('button', { name: 'Archive Alpha part' }).tap();
      await expect(tile(page, 'Alpha part')).toHaveCount(0);

      // The same action from the row's ⋯ sheet, at the screen's foot.
      await page.getByRole('button', { name: 'Actions for Beta part' }).tap();
      const sheet = page.getByRole('menu', { name: 'Actions for Beta part' });
      await settled(page);
      const box = await expectOnScreen(page, sheet);
      expect(box.y + box.height).toBeGreaterThan(size.height - 4);
      await expectTouchSized(page, '.start-tile-menu');
      await sheet.getByRole('menuitem', { name: 'Archive' }).tap();
      await expect(tile(page, 'Beta part')).toHaveCount(0);

      // Both wait on Archive; Shared and Trash switch too.
      await shelves.getByRole('button', { name: 'Archive' }).tap();
      await expect(
        shelves.getByRole('button', { name: 'Archive' })
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(tile(page, 'Alpha part')).toBeVisible();
      await expect(tile(page, 'Beta part')).toBeVisible();
      for (const name of ['Shared', 'Trash', 'Projects']) {
        await shelves.getByRole('button', { name }).tap();
        await expect(shelves.getByRole('button', { name })).toHaveAttribute(
          'aria-pressed',
          'true'
        );
      }

      // An example opens in the compact workspace.
      const demo = page.getByRole('button', {
        name: /^Open demo: Mounting Bracket/
      });
      await demo.scrollIntoViewIfNeeded();
      await demo.tap();
      await expect(
        page.getByRole('group', { name: 'Workspace mode' })
      ).toBeVisible({ timeout: 120_000 });
    }
  );

  test(`project sheet at ${at}: rename, properties, duplicate, export STEP`, async ({
    page
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    await openCompactLibrary(page);
    await newProject(page, 'Sheet part');
    await runCommand(page, 'Box');

    let sheet = await openProjectSheet(page, 'Sheet part');
    await expectTouchSized(page, '.compact-sheet-head');
    await expectDrawnSized(page, '.compact-sheet-body[data-page]');

    // Rename in place.
    const field = sheet.getByRole('textbox', { name: 'Project name' });
    await field.fill('Sheet renamed');
    await sheet.getByRole('button', { name: 'Rename', exact: true }).tap();
    await expect(
      page
        .locator('.compact-header')
        .getByRole('button', { name: 'Sheet renamed', exact: true })
    ).toBeVisible();

    // Properties, as the library tile's.
    await sheet.getByRole('button', { name: 'Properties', exact: true }).tap();
    const properties = page.getByRole('dialog', { name: 'Project properties' });
    await expect(properties).toBeVisible();
    await expectOnScreen(page, properties);
    await properties
      .getByRole('button', { name: 'Close project properties' })
      .tap();
    await expect(properties).toHaveCount(0);

    // Export STEP downloads the model.
    sheet = await openProjectSheet(page, 'Sheet renamed');
    const download = page.waitForEvent('download');
    await sheet.getByRole('button', { name: 'Export STEP', exact: true }).tap();
    expect((await download).suggestedFilename()).toMatch(/\.step$/i);

    // Duplicate project, which the regular workspace has no button for.
    sheet = await openProjectSheet(page, 'Sheet renamed');
    await sheet
      .getByRole('button', { name: 'Duplicate project', exact: true })
      .tap();
    await backToLibrary(page);
    await expect
      .poll(
        () =>
          page
            .locator('.start-tile-project')
            .filter({ hasText: '(copy)' })
            .count(),
        { timeout: 60_000 }
      )
      .toBe(1);
  });

  test(`settings and search at ${at}: find a setting and change it, run a command`, async ({
    page
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    await openCompactLibrary(page);

    // Settings: the sections as a pushed list with search on top.
    await page
      .locator('.compact-library-head')
      .getByRole('button', { name: 'Open settings', exact: true })
      .tap();
    const settings = page.getByRole('dialog', {
      name: 'Settings',
      exact: true
    });
    await expect(
      settings.getByRole('button', { name: 'Appearance', exact: true })
    ).toBeVisible();
    await expectTouchSized(page, '.settings-nav');
    await settings.getByLabel('Find a setting').fill('Theme');
    await settings
      .getByRole('list', { name: 'Matching settings' })
      .getByRole('button', { name: /^Theme/ })
      .tap();
    await expect(
      settings.getByRole('heading', { level: 1, name: 'Appearance' })
    ).toBeVisible();
    const dark = settings
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: 'Dark' });
    await settings
      .getByRole('radiogroup', { name: 'Theme' })
      .locator('label')
      .filter({ hasText: 'Dark' })
      .tap();
    await expect(dark).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await settings.getByRole('button', { name: 'Back to all settings' }).tap();
    await expect(
      settings.getByRole('button', { name: 'Appearance', exact: true })
    ).toBeVisible();
    await settings.getByRole('button', { name: /^Close settings/ }).tap();
    await expect(settings).toHaveCount(0);

    // The command search, full-screen under the header.
    await newProject(page, 'Search part');
    await page
      .getByRole('button', { name: 'Open the command bar', exact: true })
      .tap();
    await expect(
      page.getByRole('combobox', { name: 'Search commands' })
    ).toBeVisible();
    const lane = page.locator('.command-bar-lane:has(.command-bar.open)');
    await expect(lane).toBeVisible();
    await settled(page);
    const box = (await lane.boundingBox())!;
    const header = (await page.locator('.compact-header').boundingBox())!;
    expect(box.y).toBeLessThanOrEqual(header.y + header.height + 1);
    expect(box.y + box.height).toBeGreaterThanOrEqual(size.height - 1);
    expect(box.width).toBeGreaterThanOrEqual(size.width - 1);
    await page.getByRole('combobox', { name: 'Search commands' }).fill('Box');
    await expectTouchSized(page, '.command-bar-lane');
    // The header's search is its way out by touch.
    await page
      .getByRole('button', { name: 'Close the command bar', exact: true })
      .tap();
    await expect(
      page.getByRole('combobox', { name: 'Search commands' })
    ).toBeHidden();
    await runCommand(page, 'Box');
    await expect(
      page.getByRole('button', { name: 'Undo', exact: true })
    ).toBeEnabled();
  });

  test(`modeling guide at ${at} stays on screen and comes back from More`, async ({
    page
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size);
    // The first-model guide shows here; other specs start with it dismissed.
    await openCompactLibrary(page, { workspaceTour: true });
    await newProject(page, 'Guide part');
    const guide = page.getByRole('region', { name: 'Modeling guide' });
    await expect(guide).toBeVisible({ timeout: 30_000 });
    await expectOnScreen(page, guide);
    await guide.getByRole('button', { name: 'Expand modeling guide' }).tap();
    await settled(page);
    const open = await expectOnScreen(page, guide);
    // Clear of the header, the tabs and the undo pair.
    for (const selector of [
      '.compact-header',
      '.compact-tabs',
      '.compact-history'
    ]) {
      const other = (await page.locator(selector).boundingBox())!;
      const overlap =
        Math.min(open.x + open.width, other.x + other.width) -
          Math.max(open.x, other.x) >
          0 &&
        Math.min(open.y + open.height, other.y + other.height) -
          Math.max(open.y, other.y) >
          0;
      expect(overlap, selector).toBe(false);
    }
    await expectTouchSized(page, '.workspace-tour');
    await guide.getByRole('button', { name: 'Skip the tour' }).tap();
    await expect(guide).toHaveCount(0);

    await page.getByRole('button', { name: 'More', exact: true }).tap();
    await page
      .locator('.compact-sheet')
      .getByRole('button', { name: 'Modeling guide' })
      .tap();
    await expect(guide).toBeVisible();
    await expectOnScreen(page, guide);
  });
}
