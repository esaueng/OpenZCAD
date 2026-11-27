import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  sharedProjectSnapshotDocument
} from '@openzcad/document-core';
import {
  DEFAULT_APP_SETTINGS,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import { dropTapAfterFling } from './compactHelpers';
import { expect, stubAnonymousApi, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  installE2eeServer,
  seedE2eeDevice
} from './e2ee-fixtures';
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
// The row swipes here end in taps CI's Linux Chromium drops.
test.beforeEach(({ page }) => dropTapAfterFling(page));

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
      // Each shelf's word whole beside its count (at 360px "Projects" read
      // "Projec…"), and every row control a finger's size.
      expect(
        await page
          .locator('.compact-segmented .compact-segment-label')
          .evaluateAll((labels) =>
            labels
              .filter((label) => label.scrollWidth > label.clientWidth)
              .map((label) => label.textContent)
          )
      ).toEqual([]);
      await expectTouchSized(page, '.start-tile-grid');

      // The list: each row's checkbox, pin and ⋯ inside its own row (they
      // stood half a button low, over the next one), at a finger's size.
      const layout = page.getByRole('group', { name: 'Layout' });
      await layout.getByRole('button', { name: 'List' }).tap();
      await expect(page.locator('.start-tile-grid.is-list')).toBeVisible();
      await settled(page);
      expect(
        await page.locator('.start-tile-project').evaluateAll((tiles) =>
          tiles.flatMap((tile) => {
            const row = tile.getBoundingClientRect();
            return [
              ...tile.querySelectorAll<HTMLElement>(
                '.start-tile-select, .start-tile-action'
              )
            ]
              .filter((control) => {
                const box = control.getBoundingClientRect();
                return box.top < row.top - 0.5 || box.bottom > row.bottom + 0.5;
              })
              .map((control) => control.getAttribute('aria-label'));
          })
        )
      ).toEqual([]);
      await expectTouchSized(page, '.start-tile-grid');
      await layout.getByRole('button', { name: 'Grid' }).tap();
      await expect(page.locator('.start-tile-grid.is-list')).toHaveCount(0);

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
    // The owner's own project offers sharing, as the top bar's chip does.
    await expect(
      sheet.getByRole('button', { name: 'Share', exact: true })
    ).toBeVisible();

    // Rename in place.
    const field = sheet.getByRole('textbox', { name: 'Project name' });
    await field.fill('Sheet renamed');
    await sheet.getByRole('button', { name: 'Rename', exact: true }).tap();
    await expect(
      page
        .locator('.compact-header')
        .getByRole('button', { name: 'Sheet renamed', exact: true })
    ).toBeVisible();

    // Properties, as the library tile's, under the name just given.
    await sheet.getByRole('button', { name: 'Properties', exact: true }).tap();
    const properties = page.getByRole('dialog', { name: 'Project properties' });
    await expect(properties).toBeVisible();
    await expect(
      properties.getByRole('textbox', { name: 'Project name' })
    ).toHaveValue('Sheet renamed');
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

    // Account storage opens Settings on Account itself, not on its list.
    sheet = await openProjectSheet(page, 'Sheet renamed');
    await sheet
      .getByRole('button', { name: 'Account storage', exact: true })
      .tap();
    const settings = page.getByRole('dialog', {
      name: 'Settings',
      exact: true
    });
    await expect(
      settings.getByRole('heading', { level: 1, name: 'Account' })
    ).toBeVisible();
    await expect(
      settings.getByRole('button', { name: 'Back to all settings' })
    ).toBeVisible();
    await settings.getByRole('button', { name: /^Close settings/ }).tap();
    await expect(settings).toHaveCount(0);

    // Duplicate project, which the regular workspace has no button for: the
    // copy takes the name the project has now, not the library's old one.
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
    await expect(copyTiles(page, 'Sheet renamed (copy)')).toHaveCount(1);
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
    // A section's switches, segmented choices and toggle buttons take a
    // finger. Opening one puts focus on its heading, and Back on its row.
    for (const section of ['Appearance', 'Controls', 'Sketching']) {
      const row = settings.getByRole('button', { name: section, exact: true });
      await row.tap();
      const heading = settings.getByRole('heading', {
        level: 1,
        name: section
      });
      await expect(heading).toBeFocused();
      await settled(page);
      expect(
        await settings
          .locator(
            '.settings-content :is(.settings-toggle, .settings-segmented label, .space-mouse-axis-toggle, .relation-glyph-toggle)'
          )
          .evaluateAll((controls) =>
            controls
              .map((control) => {
                const box = control.getBoundingClientRect();
                return { control, box };
              })
              .filter(
                ({ box }) =>
                  box.width > 0 && (box.width < 44 || box.height < 44)
              )
              .map(
                ({ control, box }) =>
                  `${control.className} "${control.getAttribute('aria-label') ?? control.textContent?.trim()}" ${Math.round(box.width)}×${Math.round(box.height)}`
              )
          ),
        `${section}'s choices under 44 px`
      ).toEqual([]);
      await settings
        .getByRole('button', { name: 'Back to all settings' })
        .tap();
      await expect(row).toBeFocused();
    }
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

const PHONE = SIZES[0]!;

/** A view-only share link of a one-box model, opened on the compact layout. */
async function openShareLink(page: Page) {
  const snapshot = sharedProjectSnapshotDocument(
    addPrimitiveFeature(
      createProjectDocument('Shared Review', toUserId('share_owner')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 10, depth: 20 }
      }
    )
  );
  await page.route('**/api/share', (route) =>
    route.fulfill({
      json: {
        document: snapshot,
        project: {
          projectId: snapshot.projectId,
          name: snapshot.name,
          mode: 'view'
        }
      }
    })
  );
  await preferCompact(page);
  await page.setViewportSize(PHONE);
  await page.goto(`/#share=${'s'.repeat(43)}`);
  await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible({
    timeout: 60_000
  });
}

for (const signedIn of [true, false]) {
  const who = signedIn ? 'signed in' : 'signed out';
  test(
    `a share link's project sheet (${who}) offers no sharing, as the top bar does not`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(180_000);
      if (signedIn) await stubApi(page);
      else await stubAnonymousApi(page);
      await openShareLink(page);
      const sheet = await openProjectSheet(page, 'Shared Review');
      // The regular header withholds sharing, Sign in to share, comments a
      // view-only link does not take, and the owner's Properties and rename.
      for (const name of [
        'Share',
        'Sign in to share',
        'Comments',
        'Properties'
      ]) {
        await expect(
          sheet.getByRole('button', { name, exact: true }),
          name
        ).toHaveCount(0);
      }
      await expect(
        sheet.getByRole('textbox', { name: 'Project name' })
      ).toBeDisabled();
      // What a share link does offer is still there: a copy of the model.
      await expect(
        sheet.getByRole('button', { name: /^Export STEP/ })
      ).toBeVisible();
    }
  );
}

test(`trash at ${PHONE.width}×${PHONE.height}: a swipe trashes with Undo, and never deletes forever`, async ({
  page
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize(PHONE);
  await openCompactLibrary(page);
  await newProject(page, 'Trash part');
  await backToLibrary(page);

  // Swiped to Trash: the tile menu's toast and its Undo.
  await swipeLeft(page, tile(page, 'Trash part'));
  let actions = tile(page, 'Trash part').getByRole('group', {
    name: 'Row actions'
  });
  await actions.getByRole('button', { name: 'Move Trash part to trash' }).tap();
  await expect(tile(page, 'Trash part')).toHaveCount(0);
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Moved Trash part to the trash.');
  await toast.getByRole('button', { name: 'Undo' }).tap();
  await expect(tile(page, 'Trash part')).toBeVisible();

  await swipeLeft(page, tile(page, 'Trash part'));
  await tile(page, 'Trash part')
    .getByRole('group', { name: 'Row actions' })
    .getByRole('button', { name: 'Move Trash part to trash' })
    .tap();
  await expect(tile(page, 'Trash part')).toHaveCount(0);

  // In Trash a swipe only restores. A trashed row opens nothing, so it is
  // named as a group rather than an open button.
  const shelves = page.getByRole('group', { name: 'Shelves' });
  await shelves.getByRole('button', { name: 'Trash' }).tap();
  const trashed = page.locator('.start-tile-project', {
    has: page.getByRole('group', { name: /^Trash part,/ })
  });
  await swipeLeft(page, trashed);
  actions = trashed.getByRole('group', { name: 'Row actions' });
  await expect(actions).toBeVisible();
  await expect(actions.getByRole('button')).toHaveCount(1);
  await expect(
    actions.getByRole('button', { name: 'Restore Trash part' })
  ).toBeVisible();

  // A tap elsewhere puts the row back, and restores nothing.
  await trashed.getByText('Deletes in 30 days').tap();
  await expect(actions).toHaveCount(0);
  await expect(trashed).toBeVisible();

  // Delete forever stays in the row's sheet, behind the tile menu's confirm.
  await page.getByRole('button', { name: 'Actions for Trash part' }).tap();
  await page
    .getByRole('menu', { name: 'Actions for Trash part' })
    .getByRole('menuitem', { name: 'Delete forever' })
    .tap();
  const confirm = page.getByRole('alertdialog', {
    name: 'Delete “Trash part” forever?'
  });
  await expect(confirm).toBeVisible();
  await expectDrawnSized(page, '.confirm-dialog-actions');
  await confirm.getByRole('button', { name: 'Cancel' }).tap();
  await expect(confirm).toHaveCount(0);
  await expect(trashed).toBeVisible();
});

test(`settings at ${PHONE.width}×${PHONE.height}: Test connection's error is shown and announced in its section`, async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  // A personal token stored on the account, which the provider refuses.
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.assistant.enabled = true;
  settings.assistant.credentialSource = 'personal';
  await page.route('**/api/settings', (route) =>
    route.fulfill({
      json: {
        settings,
        revision: 1,
        synced: true,
        credential: { stored: true, hint: '…1234', storageAvailable: true },
        effectiveAssistant: {
          configured: true,
          source: 'personal',
          provider: settings.assistant.provider,
          model: settings.assistant.model,
          reasoningEffort: settings.assistant.reasoningEffort
        }
      }
    })
  );
  await page.route('**/api/settings/assistant/test', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'The provider refused the API key.' }
    })
  );
  await preferCompact(page);
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Shelves' })).toBeVisible({
    timeout: 60_000
  });
  await page
    .locator('.compact-library-head')
    .getByRole('button', { name: 'Open settings', exact: true })
    .tap();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'AI Assistant', exact: true }).tap();
  await expect(
    dialog.getByRole('heading', { level: 1, name: 'AI Assistant' })
  ).toBeVisible();
  const testButton = dialog.getByRole('button', { name: 'Test connection' });
  await testButton.scrollIntoViewIfNeeded();
  await expect(testButton).toBeEnabled({ timeout: 30_000 });
  await testButton.tap();
  const region = dialog.locator('.settings-save-message[aria-live="polite"]');
  await expect(region).toContainText('The provider refused the API key');
  await expect(region).toBeVisible();
  await expectOnScreen(page, region);
  // In the accessibility tree: not hidden from it, and its words read out.
  expect(
    await region.evaluate(
      (element) =>
        element.closest('[aria-hidden="true"]') === null &&
        getComputedStyle(element).display !== 'none' &&
        getComputedStyle(element).visibility === 'visible'
    )
  ).toBe(true);
  await expect(dialog).toMatchAriaSnapshot(
    '- text: /The provider refused the API key/'
  );
});

// PR #2219 review: a search left in Settings, then Settings closed, hid the
// Encryption section a device-approval link opened it on, since compact
// Settings shows a search's results before any section.
test(`settings at ${PHONE.width}×${PHONE.height}: a device-approval link opens Encryption over an earlier search`, async ({
  page
}) => {
  test.setTimeout(180_000);
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(page.context(), server);
  await preferCompact(page);
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Shelves' })).toBeVisible({
    timeout: 60_000
  });
  await seedE2eeDevice(page, server, { label: 'Laptop' });

  await page
    .locator('.compact-library-head')
    .getByRole('button', { name: 'Open settings', exact: true })
    .tap();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByLabel('Find a setting').fill('appearance');
  const results = dialog.getByRole('list', { name: 'Matching settings' });
  await expect(results).toBeVisible();
  await dialog.getByRole('button', { name: /^Close settings/ }).tap();
  await expect(dialog).toHaveCount(0);

  // A new device's approval link, opened as a camera app would.
  await page.goto(`/#approve-device=${'0'.repeat(52)}`);
  await expect(
    dialog.getByRole('heading', { level: 1, name: 'Encryption' })
  ).toBeVisible({ timeout: 15_000 });
  await expect(results).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('');
  // Back on the list, the search is empty.
  await dialog.getByRole('button', { name: 'Back to all settings' }).tap();
  await expect(dialog.getByLabel('Find a setting')).toHaveValue('');
});

/**
 * Holds every account listing from now until released, then answers it with
 * one marker row (and any `rows`): an account snapshot taken before any copy
 * was stored, and a way to tell when that listing has reached the shelf.
 */
async function holdAccountListing(page: Page, rows: object[] = []) {
  let sent!: () => void;
  const out = new Promise<void>((resolve) => (sent = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    sent();
    await held;
    return route.fulfill({
      json: {
        projects: [
          {
            projectId: 'proj_listing_marker',
            name: 'Listing marker',
            revisionCount: 1,
            updatedAt: new Date().toISOString()
          },
          ...rows
        ]
      }
    });
  });
  return { out, release };
}

/** Holds each copy the account is asked to store until `until` settles. */
async function holdCopies(page: Page, until: Promise<unknown>) {
  await page.route('**/api/projects/*/duplicate', async (route) => {
    await until;
    await route.fallback();
  });
}

const copyTiles = (page: Page, name: string) =>
  page.locator('.start-tile-project', {
    has: page.getByRole('button', {
      name: new RegExp(`^${name.replace(/[()]/g, '\\$&')},`)
    })
  });

test(
  'a copy made just before Back to projects is listed once',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(SIZES[0]!);
    await openCompactLibrary(page);
    await newProject(page, 'Race part');

    // The account stores the copy only once the shelf's listing has gone
    // out, and that listing is held until the copy's row is up: the shelf
    // then reads this device before the copy has landed, and applies what it
    // read after, which is when its listing used to drop the copy.
    const listing = await holdAccountListing(page);
    await holdCopies(page, listing.out);

    const sheet = await openProjectSheet(page, 'Race part');
    await sheet
      .getByRole('button', { name: 'Duplicate project', exact: true })
      .tap();
    await backToLibrary(page);
    const copies = copyTiles(page, 'Race part (copy)');
    await expect(copies).toHaveCount(1, { timeout: 60_000 });
    listing.release();
    await expect(tile(page, 'Listing marker')).toBeVisible({
      timeout: 60_000
    });
    await expect(copies).toHaveCount(1);
  }
);

test(
  'a second copy made while the shelf is still listing stays listed too',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(SIZES[0]!);
    await openCompactLibrary(page);
    await newProject(page, 'Pair part');

    // The first copy lands once Back to projects has started its listing,
    // whose account read is held; the second is made from the shelf after
    // that listing has read this device. Both land before it is applied.
    const listing = await holdAccountListing(page);
    await holdCopies(page, listing.out);
    const sheet = await openProjectSheet(page, 'Pair part');
    await sheet
      .getByRole('button', { name: 'Duplicate project', exact: true })
      .tap();
    await backToLibrary(page);
    const first = copyTiles(page, 'Pair part (copy)');
    await expect(first).toHaveCount(1, { timeout: 60_000 });

    await page
      .getByRole('button', { name: 'Actions for Pair part', exact: true })
      .tap();
    await page
      .getByRole('menu', { name: 'Actions for Pair part', exact: true })
      .getByRole('menuitem', { name: 'Duplicate', exact: true })
      .tap();
    const copies = page
      .locator('.start-tile-project')
      .filter({ hasText: /Pair part \(copy/ });
    await expect(copies).toHaveCount(2, { timeout: 60_000 });

    listing.release();
    await expect(tile(page, 'Listing marker')).toBeVisible({
      timeout: 60_000
    });
    await expect(copies).toHaveCount(2);
    await expect(first).toHaveCount(1);
  }
);

test(
  'a copy the account stored after its listing was taken stays an account project',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(SIZES[0]!);
    await openCompactLibrary(page);
    await newProject(page, 'Cloud part');

    // The account's snapshot is taken before it stores the copy, so the
    // listing names every account project but this one.
    const listing = await holdAccountListing(page);
    await holdCopies(page, listing.out);
    const copied = page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith('/duplicate')
      )
      .then(
        async (response) =>
          ((await response.json()) as { document: ProjectDocument }).document
      );
    const sheet = await openProjectSheet(page, 'Cloud part');
    await sheet
      .getByRole('button', { name: 'Duplicate project', exact: true })
      .tap();
    await backToLibrary(page);
    const copy = await copied;
    const copyTile = copyTiles(page, 'Cloud part (copy)');
    await expect(copyTile).toHaveCount(1, { timeout: 60_000 });
    listing.release();
    await expect(tile(page, 'Listing marker')).toBeVisible({
      timeout: 60_000
    });

    // Listed as the account's, not as this device's alone, so renaming it
    // on the shelf writes the account's copy.
    await expect(copyTile).toHaveCount(1);
    await expect(copyTile.getByLabel('On this device only')).toHaveCount(0);
    await page.route(
      `**/api/projects/${encodeURIComponent(copy.projectId)}`,
      (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: copy })
          : route.fallback()
    );
    const accountRename = page.waitForRequest(
      (request) =>
        request.method() === 'PUT' &&
        new URL(request.url()).pathname ===
          `/api/projects/${encodeURIComponent(copy.projectId)}/document`
    );
    await page
      .getByRole('button', {
        name: 'Actions for Cloud part (copy)',
        exact: true
      })
      .tap();
    await page
      .getByRole('menu', { name: 'Actions for Cloud part (copy)', exact: true })
      .getByRole('menuitem', { name: 'Rename' })
      .tap();
    const field = page.getByRole('textbox', {
      name: 'Rename Cloud part (copy)'
    });
    await field.fill('Cloud copy renamed');
    await field.press('Enter');
    const renamed = (await accountRename).postDataJSON() as {
      document: ProjectDocument;
    };
    expect(renamed.document.name).toBe('Cloud copy renamed');
    await expect(tile(page, 'Cloud copy renamed')).toHaveCount(1);
  }
);

test(
  'a copy the account never answers holds up neither the shelf nor sign-out',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(SIZES[0]!);
    await openCompactLibrary(page);
    await newProject(page, 'Stalled part');

    // The account never answers the copy; its listing answers at once.
    let signedIn = true;
    await page.route('**/api/session', (route) =>
      signedIn
        ? route.fallback()
        : route.fulfill({
            status: 401,
            json: { error: 'Authentication required.', code: 'AUTH_REQUIRED' }
          })
    );
    await page.route('**/api/auth/logout', (route) => {
      signedIn = false;
      return route.fulfill({ json: { ok: true } });
    });
    const listing = await holdAccountListing(page);
    listing.release();
    let copyAsked!: () => void;
    const asked = new Promise<void>((resolve) => (copyAsked = resolve));
    await page.route('**/api/projects/*/duplicate', () => {
      copyAsked();
      // Never fulfilled.
    });

    const sheet = await openProjectSheet(page, 'Stalled part');
    await sheet
      .getByRole('button', { name: 'Duplicate project', exact: true })
      .tap();
    await asked;
    await backToLibrary(page);
    await expect(tile(page, 'Listing marker')).toBeVisible({
      timeout: 30_000
    });
    await expect(tile(page, 'Stalled part')).toHaveCount(1);

    await page
      .locator('.compact-library-head')
      .getByRole('button', { name: 'Open settings', exact: true })
      .tap();
    const settings = page.getByRole('dialog', {
      name: 'Settings',
      exact: true
    });
    await settings.getByRole('button', { name: 'Account', exact: true }).tap();
    await settings.getByRole('button', { name: 'Sign out', exact: true }).tap();
    await expect(page.locator('.settings-save-message')).toContainText(
      'Signed out',
      { timeout: 30_000 }
    );
    await expect(tile(page, 'Listing marker')).toHaveCount(0);
  }
);

test(
  'a copy deleted forever while the shelf is listing is not listed again',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(SIZES[0]!);
    await openCompactLibrary(page);
    await newProject(page, 'Gone part');

    const copied = page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith('/duplicate')
      )
      .then(
        async (response) =>
          ((await response.json()) as { document: ProjectDocument }).document
      );
    const sheet = await openProjectSheet(page, 'Gone part');
    await sheet
      .getByRole('button', { name: 'Duplicate project', exact: true })
      .tap();
    const copy = await copied;
    await page.route(
      `**/api/projects/${encodeURIComponent(copy.projectId)}`,
      (route) =>
        route.request().method() === 'DELETE'
          ? route.fulfill({ status: 204 })
          : route.fallback()
    );

    // Back to projects' account snapshot already holds the copy, and is held
    // until the copy has been trashed and deleted forever.
    const listing = await holdAccountListing(page, [
      {
        projectId: copy.projectId,
        name: copy.name,
        revisionCount: 1,
        updatedAt: new Date().toISOString()
      }
    ]);
    await backToLibrary(page);
    await listing.out;
    const copyTile = copyTiles(page, 'Gone part (copy)');
    await expect(copyTile).toHaveCount(1, { timeout: 60_000 });
    await page
      .getByRole('button', {
        name: 'Actions for Gone part (copy)',
        exact: true
      })
      .tap();
    await page
      .getByRole('menu', { name: 'Actions for Gone part (copy)', exact: true })
      .getByRole('menuitem', { name: 'Move to trash' })
      .tap();
    await expect(copyTile).toHaveCount(0);

    const shelves = page.getByRole('group', { name: 'Shelves' });
    await shelves.getByRole('button', { name: 'Trash' }).tap();
    const trashed = page.locator('.start-tile-project', {
      has: page.getByRole('group', { name: /^Gone part \(copy\),/ })
    });
    await expect(trashed).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Actions for Gone part (copy)',
        exact: true
      })
      .tap();
    await page
      .getByRole('menu', { name: 'Actions for Gone part (copy)', exact: true })
      .getByRole('menuitem', { name: 'Delete forever' })
      .tap();
    await page
      .getByRole('alertdialog', { name: 'Delete “Gone part (copy)” forever?' })
      .getByRole('button', { name: 'Delete forever' })
      .tap();
    await expect(trashed).toHaveCount(0);

    // The listing that read the copy before it was deleted reaches the
    // shelf (its marker shows) without it, on either shelf.
    listing.release();
    await shelves.getByRole('button', { name: 'Projects' }).tap();
    await expect(tile(page, 'Listing marker')).toBeVisible({
      timeout: 60_000
    });
    await expect(copyTile).toHaveCount(0);
    await expect(tile(page, 'Gone part')).toHaveCount(1);
    await shelves.getByRole('button', { name: 'Trash' }).tap();
    await expect(trashed).toHaveCount(0);
  }
);
