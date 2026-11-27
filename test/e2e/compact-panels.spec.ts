import type { Locator, Page } from '@playwright/test';
import { dropTapAfterFling } from './compactHelpers';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * The compact workspace's panels, selection sheet and action sheets (U12
 * slice 5), driven by touch alone: taps, swipes and holds, never a key, a
 * hover, a right button or a double-click.
 *
 * Each `reached(id)` names the registry action the steps just above it ran.
 * `lib/actions/registry.test.ts` reads them: every action this slice marks
 * as reached from the panel, selection or action sheet must be one of them.
 */
function reached(action: string) {
  void action;
}

/**
 * An action these sheets also run whose compact home is another surface
 * (View's tray, slice 7): named for the reader, not counted as reached here.
 */
function alsoReached(action: string) {
  void action;
}

const LAYOUT_KEY = 'openzcad.layout:v1';

async function preferCompact(page: Page) {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem('compact-seeded')) {
      sessionStorage.setItem('compact-seeded', '1');
      localStorage.setItem(key, 'compact');
    }
  }, LAYOUT_KEY);
}

async function openCompactProject(page: Page, name: string) {
  await stubApi(page);
  await preferCompact(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).tap();
  await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible({
    timeout: 60_000
  });
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 60_000
  });
}

const sheet = (page: Page) => page.locator('.compact-sheet');

/** Runs a command-bar row from the header's search, by taps. */
async function searchAndTap(page: Page, query: string, option: RegExp) {
  await page
    .getByRole('button', { name: 'Open the command bar', exact: true })
    .tap();
  const field = page.getByRole('combobox', { name: 'Search commands' });
  await expect(field).toBeFocused();
  await field.fill(query);
  await page.getByRole('option', { name: option }).first().tap();
}

async function placeBox(page: Page) {
  await searchAndTap(page, 'Box', /^Box/);
  const bar = sheet(page).getByRole('group', { name: 'Box command' });
  const done = bar.getByRole('button', { name: /Done/ });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await done.tap();
  await expect(bar).toHaveCount(0);
}

/** A finger on the screen, through the browser's own touch input. */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }]
    });
  return { send, detach: () => cdp.detach() };
}

/** Swipes the row's face across by `dx` pixels. */
async function swipe(page: Page, row: Locator, dx: number) {
  await row.scrollIntoViewIfNeeded();
  const box = (await row.locator('.compact-row-main').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const touch = await finger(page);
  await touch.send('touchStart', x, y);
  for (let step = 1; step <= 8; step += 1) {
    await touch.send('touchMove', x + (dx * step) / 8, y);
  }
  await touch.send('touchEnd');
  await touch.detach();
}

/** Holds a finger still at a point until the action sheet opens. */
async function holdAt(page: Page, x: number, y: number) {
  // The last sheet fades out first: still drawn, it is no sign of this one.
  await expect(page.locator('.compact-action-sheet-scrim')).toHaveCount(0);
  const touch = await finger(page);
  await touch.send('touchStart', x, y);
  const actions = page.locator(
    '.compact-action-sheet-scrim:not(.closing) .compact-action-sheet'
  );
  await expect(actions).toBeVisible({ timeout: 10_000 });
  await touch.send('touchEnd');
  await touch.detach();
  return actions;
}

/**
 * A long press on the model, as the browser reports one: a touch
 * `contextmenu` (Chrome on Android fires it; the viewer's own touch layer
 * opens the same menu where the browser fires none). A finger held through
 * this harness's touch input lifts outside the canvas once the sheet is up,
 * which the viewer never hears, so the model takes the browser's route.
 */
async function holdModel(page: Page, x: number, y: number) {
  await expect(page.locator('.compact-action-sheet-scrim')).toHaveCount(0);
  await page.locator('.viewer-host canvas').evaluate(
    (element, point) => {
      element.dispatchEvent(
        new PointerEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
          pointerType: 'touch'
        })
      );
    },
    { x, y }
  );
  const actions = page.locator(
    '.compact-action-sheet-scrim:not(.closing) .compact-action-sheet'
  );
  await expect(actions).toBeVisible();
  return actions;
}

async function holdRow(page: Page, row: Locator) {
  await row.scrollIntoViewIfNeeded();
  const box = (await row.locator('.compact-row-main').boundingBox())!;
  return holdAt(page, box.x + box.width / 2, box.y + box.height / 2);
}

/** A point on the stage clear of the model and the floating controls. */
async function emptyStagePoint(page: Page) {
  const stage = (await page.locator('.viewer-host canvas').boundingBox())!;
  return { x: stage.x + 20, y: stage.y + 72 };
}

async function modelCenter(page: Page) {
  const stage = (await page.locator('.viewer-host canvas').boundingBox())!;
  return { x: stage.x + stage.width / 2, y: stage.y + stage.height * 0.4 };
}

/** Where the stage's own controls stand: the handles' value and mode chips. */
function stageControlRects(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.viewer-area button, [data-testid^="direct-manipulation"]'
      )
    ].map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].map(Math.round).join(',');
    })
  );
}

/**
 * A point on the model that a tap picks: its middle, or the nearest point to
 * it that a fingertip's width away still lands on the canvas. A picked
 * face's handles stand their value chips on the model, and a tap on one
 * opens the keypad rather than picking. The chips are read once they stand
 * still, so none moves under the point after it is chosen.
 */
async function modelPoint(page: Page) {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await stageControlRects(page));
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [300] }
    )
    .toBe(true);
  const center = await modelCenter(page);
  const point = await page
    .locator('.viewer-host canvas')
    .evaluate((canvas, middle) => {
      const reach = 16;
      const clear = (x: number, y: number) =>
        [-reach, 0, reach].every((dx) =>
          [-reach, 0, reach].every(
            (dy) => document.elementFromPoint(x + dx, y + dy) === canvas
          )
        );
      const offsets: [number, number][] = [];
      for (let dx = -64; dx <= 64; dx += 16) {
        for (let dy = -48; dy <= 48; dy += 16) offsets.push([dx, dy]);
      }
      offsets.sort(
        ([ax, ay], [bx, by]) => ax * ax + ay * ay - bx * bx - by * by
      );
      for (const [dx, dy] of offsets) {
        if (clear(middle.x + dx, middle.y + dy)) {
          return { x: middle.x + dx, y: middle.y + dy };
        }
      }
      return null;
    }, center);
  expect(point, 'a point on the model clear of the handles').not.toBeNull();
  return point!;
}

async function openPanelsFromMore(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).tap();
  await sheet(page).getByRole('button', { name: 'Panels', exact: true }).tap();
  await expect(
    sheet(page).getByRole('tablist', { name: 'Panels' })
  ).toBeVisible();
}

async function closeSheet(page: Page) {
  await sheet(page).getByRole('button', { name: 'Close sheet' }).tap();
  await expect(sheet(page).locator('[data-page="panels"]')).toHaveCount(0);
}

const PANELS = [
  ['History'],
  ['Objects'],
  ['Parameters'],
  ['Revisions'],
  ['Diagnostics'],
  ['Comments']
] as const;

test.describe('the compact workspace panels', () => {
  test.use({ hasTouch: true, isMobile: true });
  // The row swipes here end in taps CI's Linux Chromium drops.
  test.beforeEach(({ page }) => dropTapAfterFling(page));

  for (const size of [
    { width: 390, height: 844 },
    { width: 360, height: 640 }
  ]) {
    const smoke = size.width === 390 ? { tag: '@ci-smoke' } : {};
    test(
      `opens every panel from More and from the command bar at ${size.width}×${size.height}`,
      smoke,
      async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize(size);
        await openCompactProject(page, `Panels ${size.width}`);
        const layoutBefore = await page.evaluate(() =>
          localStorage.getItem('openzcad-panel-layout:v1')
        );
        await placeBox(page);

        // More › Panels opens the segmented sheet on History.
        await openPanelsFromMore(page);
        const tabs = sheet(page).getByRole('tablist', { name: 'Panels' });
        await expect(
          tabs.getByRole('tab', { name: 'History', exact: true })
        ).toHaveAttribute('aria-selected', 'true');
        for (const [title] of PANELS) {
          const tab = tabs.getByRole('tab', { name: title, exact: true });
          await tab.tap();
          await expect(tab).toHaveAttribute('aria-selected', 'true');
          await expect(
            sheet(page).getByRole('tabpanel', { name: title })
          ).toBeVisible();
          // One word on the active segment; a finger's size on each.
          await expect(tab).toHaveText(title);
          const box = (await tab.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(44);
        }
        // The sheet shuts as it opened: Hide or show the model panels.
        await closeSheet(page);
        reached('panels-hide-all');

        // Each panel has a command-bar row of its own.
        for (const [title] of PANELS) {
          await searchAndTap(page, title, new RegExp(`^${title}`));
          await expect(
            sheet(page).getByRole('tab', { name: title, exact: true })
          ).toHaveAttribute('aria-selected', 'true');
          await expect(
            sheet(page).getByRole('tabpanel', { name: title })
          ).toBeVisible();
        }
        // Every panel, from More and from its own row.
        reached('panel-history');
        reached('panel-objects');
        reached('panel-parameters');
        reached('panel-revisions');
        reached('panel-diagnostics');
        reached('panel-comments');
        await closeSheet(page);

        // The regular workspace's panel layout was never rewritten.
        expect(
          await page.evaluate(() =>
            localStorage.getItem('openzcad-panel-layout:v1')
          )
        ).toBe(layoutBefore);
      }
    );
  }

  test(
    'edits, suppresses, rolls back, renames and deletes History steps by touch',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: 360, height: 640 });
      await openCompactProject(page, 'Panels history');
      await placeBox(page);
      await placeBox(page);
      await placeBox(page);
      await openPanelsFromMore(page);
      const rows = sheet(page).locator('.compact-row');
      await expect(rows).toHaveCount(3);
      const first = rows.nth(0);
      const second = rows.nth(1);
      const firstName = (await first
        .locator('.compact-row-name')
        .textContent())!.trim();
      const secondName = (await second
        .locator('.compact-row-name')
        .textContent())!.trim();

      // Swipe left: Suppress.
      await swipe(page, second, -170);
      await second
        .getByRole('button', { name: `Suppress ${secondName}` })
        .tap();
      await expect(second).toHaveClass(/is-suppressed/);
      // The row's long press offers it too, without a swipe.
      let actions = await holdRow(page, second);
      await expect(actions).toHaveAccessibleName(secondName);
      await actions.getByRole('menuitem', { name: 'Resume' }).tap();
      await expect(actions).toHaveCount(0);
      await expect(second).not.toHaveClass(/is-suppressed/);
      reached('feature-suppress');

      // Swipe right: Roll back to here, then resume.
      await swipe(page, first, 120);
      await first
        .getByRole('button', { name: `Roll back to ${firstName}` })
        .tap();
      await expect(second).toHaveClass(/is-paused/);
      await sheet(page)
        .getByRole('button', { name: 'Resume full history' })
        .tap();
      await expect(second).not.toHaveClass(/is-paused/);
      reached('history-rollback');

      // The long press holds the row's whole menu, Duplicate among it
      // (which covers Move and Mirror steps, and says so on a Box).
      actions = await holdRow(page, first);
      await expect(
        actions.getByRole('menuitem', { name: /^Duplicate/ })
      ).toBeDisabled();
      await actions.getByRole('menuitem', { name: 'Rename' }).tap();
      const field = sheet(page).getByRole('textbox', {
        name: `Rename ${firstName}`
      });
      await expect(field).toBeFocused();
      await field.fill('Base plate');
      // Leaving the field keeps the name, as a phone's keyboard does.
      await sheet(page)
        .getByRole('tab', { name: 'History', exact: true })
        .tap();
      await expect(first.locator('.compact-row-name')).toHaveText('Base plate');
      reached('feature-rename');

      actions = await holdRow(page, first);
      await actions.getByRole('menuitem', { name: 'Hide body' }).tap();
      actions = await holdRow(page, first);
      await expect(
        actions.getByRole('menuitem', { name: 'Show body' })
      ).toBeVisible();
      await actions.getByRole('menuitem', { name: 'Cancel' }).tap();
      await expect(actions).toHaveCount(0);
      alsoReached('body-visibility');

      // Swipe left: Delete.
      const last = rows.nth(2);
      const lastName = (await last
        .locator('.compact-row-name')
        .textContent())!.trim();
      await swipe(page, last, -170);
      await last.getByRole('button', { name: `Delete ${lastName}` }).tap();
      await expect(rows).toHaveCount(2);
      reached('feature-delete');

      // A tap opens the step's edit: the panel gives way to its form, and
      // so does More, which Panels was opened from. Nothing covers it.
      await second.locator('.compact-row-main').tap();
      await expect(sheet(page).locator('[data-page]')).toHaveCount(0);
      await expect(sheet(page)).toHaveAttribute('data-detent', /half|full/);
      const form = sheet(page).locator('.compact-sheet-body:not([data-page])');
      await expect(form).toBeVisible();
      const inspector = form.getByRole('region', { name: 'Feature inspector' });
      await expect(inspector).toBeVisible();
      await expect(
        inspector.getByRole('heading', { name: secondName })
      ).toBeVisible();
      await expect(
        sheet(page).getByRole('heading', { name: 'More' })
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: `Selection: ${secondName}` })
      ).toBeVisible();
      reached('feature-edit');
    }
  );

  test('opens the selection sheet from the chip and the model’s long press as action sheets', async ({
    page
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCompactProject(page, 'Panels selection');
    await placeBox(page);

    // A hold on empty stage: the viewport's menu, as an action sheet.
    const empty = await emptyStagePoint(page);
    for (const item of [
      /^Fit view$/,
      /^(Show|Hide) grid$/,
      /^Switch to (orthographic|perspective)$/,
      /^Turn X-ray (on|off)$/
    ]) {
      const actions = await holdModel(page, empty.x, empty.y);
      const row = actions.getByRole('menuitem', { name: item });
      const box = (await row.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      await row.tap();
      await expect(actions).toHaveCount(0);
    }
    alsoReached('view-fit');
    alsoReached('view-grid');
    alsoReached('view-projection');
    alsoReached('view-xray');

    // A tap on the model picks; the chip opens the selection sheet.
    let center = await modelPoint(page);
    await page.touchscreen.tap(center.x, center.y);
    const chip = page.locator('.compact-selection-chip');
    await expect(chip).toBeVisible();
    await chip.tap();
    const filter = sheet(page).getByRole('radiogroup', {
      name: 'Selection filter'
    });
    await expect(filter).toBeVisible();
    await filter.getByRole('radio', { name: 'Face' }).tap();
    await expect(filter.getByRole('radio', { name: 'Face' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await filter.getByRole('radio', { name: 'Any' }).tap();
    await expect(filter.getByRole('radio', { name: 'Any' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    reached('selection-filter');

    // A face pick: Select body takes its whole body, as a double-click does.
    await sheet(page).getByRole('button', { name: 'Back' }).tap();
    // The first pick's handles are up now: the tap keeps clear of them.
    center = await modelPoint(page);
    await page.touchscreen.tap(center.x, center.y);
    await expect(chip).toHaveAccessibleName(/face/i);
    await chip.tap();
    await sheet(page)
      .getByRole('button', { name: 'Select body', exact: true })
      .tap();
    await expect(chip).not.toHaveAccessibleName(/face/i);
    reached('selection-whole-body');

    // A hold on the model: the selection's menu.
    let actions = await holdModel(page, center.x, center.y);
    await actions.getByRole('menuitem', { name: 'Look at face' }).tap();
    await expect(actions).toHaveCount(0);
    reached('view-normal-to-face');

    actions = await holdModel(page, center.x, center.y);
    await actions.getByRole('menuitem', { name: 'Isolate body' }).tap();
    await expect(actions).toHaveCount(0);
    alsoReached('view-isolate-body');

    actions = await holdModel(page, center.x, center.y);
    await actions.getByRole('menuitem', { name: 'Exit isolation' }).tap();
    await expect(actions).toHaveCount(0);

    // With the body hidden, Show all bodies brings it back.
    actions = await holdModel(page, center.x, center.y);
    await actions.getByRole('menuitem', { name: 'Hide body' }).tap();
    await expect(actions).toHaveCount(0);
    actions = await holdModel(page, empty.x, empty.y);
    await actions.getByRole('menuitem', { name: 'Show all bodies' }).tap();
    await expect(actions).toHaveCount(0);
    alsoReached('view-show-all');
  });
});
