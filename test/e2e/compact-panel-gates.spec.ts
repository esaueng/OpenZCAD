import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  sharedProjectSnapshotDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { expectReachable } from './compactHelpers';
import { expect, stubAnonymousApi, stubApi, test } from './openzcad-fixtures';

const LAYOUT_KEY = 'openzcad.layout:v1';
const APP_SETTINGS_KEY = 'openzcad-app-settings:v1';

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

/** Base, a box, and Placement, a move of its body: two History steps. */
function twoStepDocument(name: string) {
  let document = createProjectDocument(name, toUserId('local'));
  document = addPrimitiveFeature(document, {
    name: 'Base',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 30 }
  });
  return transformBody(document, {
    name: 'Placement',
    targetBodyId: document.bodyOrder[0]!,
    translation: { x: 10, y: 0, z: 0 }
  }).document;
}

/** Opens `document` in the compact workspace through Import project. */
async function openCompactDocument(
  page: Page,
  document: ReturnType<typeof createProjectDocument>
) {
  await stubApi(page);
  await preferCompact(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Import project' }).tap();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'compact-gates.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: []
      })
    )
  });
  await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible({
    timeout: 60_000
  });
}

/** Raises the sheet to full height by its grabber's End key. */
async function sheetToFull(page: Page) {
  const grabber = sheet(page).getByRole('slider', { name: 'Sheet height' });
  await grabber.focus();
  await grabber.press('End');
  await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
  await expect(page.locator('.app-shell > .workspace')).toHaveAttribute(
    'inert',
    ''
  );
}

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

/** Opens History through the header's More › Panels, by taps. */
async function openHistoryFromMore(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).tap();
  await sheet(page).getByRole('button', { name: 'Panels', exact: true }).tap();
  await sheet(page)
    .getByRole('tablist', { name: 'Panels' })
    .getByRole('tab', { name: 'History', exact: true })
    .tap();
  await expect(sheet(page).locator('[data-page="panels"]')).toBeVisible();
}

/**
 * Box's tray row shows at once, at the peek a running tool comes up at:
 * no page is left over it, and its Done and Cancel take a tap. Cancel
 * then ends it.
 */
async function expectBoxRowShown(page: Page) {
  const bar = sheet(page).getByRole('group', { name: 'Box command' });
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(sheet(page).locator('[data-page]')).toHaveCount(0);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  const row = sheet(page).locator('.compact-command-row .compact-tray-row');
  const done = row.getByRole('button', { name: 'Done' });
  const cancel = row.getByRole('button', { name: 'Cancel' });
  await expectReachable(done);
  await expectReachable(cancel);
  await cancel.tap();
  await expect(bar).toHaveCount(0);
}

async function closeSheet(page: Page) {
  await sheet(page).getByRole('button', { name: 'Close sheet' }).tap();
  await expect(sheet(page).locator('[data-page="panels"]')).toHaveCount(0);
}

/**
 * The regular workspace's gates, kept in the compact one (U12 review):
 * confirmations checked against the live document, Comments for a link's
 * visitor, and the global keys over a full-height sheet. Unlike
 * `compact-panels.spec.ts`, which reaches every entry by touch alone, these
 * use a key where the gate is about a key.
 */
test.describe('the compact workspace keeps the regular gates', () => {
  test.use({ hasTouch: true, isMobile: true });

  test(
    'a row menu checks Delete against the document when Delete is chosen',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactDocument(page, twoStepDocument('Live menu'));
      await searchAndTap(page, 'History', /^History/);
      const rows = sheet(page).locator('.compact-row');
      await expect(rows).toHaveCount(2);
      const actions = page.locator(
        '.compact-action-sheet-scrim:not(.closing) .compact-action-sheet'
      );

      // The placement goes: nothing builds on Base any more.
      await swipe(page, rows.nth(1), -170);
      await rows.nth(1).getByRole('button', { name: 'Delete Placement' }).tap();
      await expect(rows).toHaveCount(1);
      // Base's menu, opened while nothing builds on it.
      await rows
        .nth(0)
        .getByRole('button', { name: 'More actions for Base' })
        .tap();
      await expect(actions).toBeVisible();
      // Undo by key, under the open menu, brings the placement back.
      await page.keyboard.press('ControlOrMeta+z');
      await expect(rows).toHaveCount(2);
      // Delete asks first, as it does for Base with the placement on it.
      await actions
        .getByRole('menuitem', { name: 'Delete', exact: true })
        .tap();
      const dialog = page.getByRole('alertdialog', { name: 'Delete “Base”?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Placement');
      await dialog.getByRole('button', { name: 'Cancel' }).tap();
      await expect(dialog).toHaveCount(0);
      await expect(rows).toHaveCount(2);

      // And the other way: opened with the placement on Base, a redo under
      // the menu takes it away, and Delete runs without asking.
      await expect(page.locator('.compact-action-sheet-scrim')).toHaveCount(0);
      await rows
        .nth(0)
        .getByRole('button', { name: 'More actions for Base' })
        .tap();
      await expect(actions).toBeVisible();
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect(rows).toHaveCount(1);
      await actions
        .getByRole('menuitem', { name: 'Delete', exact: true })
        .tap();
      await expect(rows).toHaveCount(0);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
    }
  );

  test(
    'Ctrl+\\ shuts and opens the panel sheet at full height',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactProject(page, 'Panels key');
      await searchAndTap(page, 'History', /^History/);
      const tabs = sheet(page).getByRole('tablist', { name: 'Panels' });
      await expect(tabs).toBeVisible();
      const grabber = sheet(page).getByRole('slider', { name: 'Sheet height' });
      await grabber.focus();
      await grabber.press('End');
      await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
      await expect(page.locator('.app-shell > .workspace')).toHaveAttribute(
        'inert',
        ''
      );
      // The stage is inert under the sheet; the global key still applies.
      await page.keyboard.press('ControlOrMeta+Backslash');
      await expect(sheet(page).locator('[data-page="panels"]')).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+Backslash');
      await expect(tabs).toBeVisible();
      await grabber.focus();
      await grabber.press('End');
      await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
      await page.keyboard.press('ControlOrMeta+Backslash');
      await expect(sheet(page).locator('[data-page="panels"]')).toHaveCount(0);
    }
  );

  test(
    'a row menu follows the rollback marker as undo and redo move it',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactDocument(page, twoStepDocument('Live rollback'));
      await searchAndTap(page, 'History', /^History/);
      const rows = sheet(page).locator('.compact-row');
      await expect(rows).toHaveCount(2);
      const actions = page.locator(
        '.compact-action-sheet-scrim:not(.closing) .compact-action-sheet'
      );

      // Roll back to Base, then undo it: the full history again.
      await swipe(page, rows.nth(0), 120);
      await rows
        .nth(0)
        .getByRole('button', { name: 'Roll back to Base' })
        .tap();
      await expect(rows.nth(1)).toHaveClass(/is-paused/);
      await page.keyboard.press('ControlOrMeta+z');
      await expect(rows.nth(1)).not.toHaveClass(/is-paused/);

      // Base's menu, opened with nothing rolled back.
      await rows
        .nth(0)
        .getByRole('button', { name: 'More actions for Base' })
        .tap();
      await expect(actions).toBeVisible();
      await expect(
        actions.getByRole('menuitem', { name: 'Roll back to here' })
      ).toBeVisible();
      // A redo under the menu pauses Placement again: the menu offers what
      // the row now does, Resume full history, and it runs.
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect(rows.nth(1)).toHaveClass(/is-paused/);
      await expect(
        actions.getByRole('menuitem', { name: 'Roll back to here' })
      ).toHaveCount(0);
      await actions
        .getByRole('menuitem', { name: 'Resume full history' })
        .tap();
      await expect(rows.nth(1)).not.toHaveClass(/is-paused/);
    }
  );

  test(
    'the global keys open usable surfaces over a full-height sheet',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactProject(page, 'Full sheet keys');
      await searchAndTap(page, 'History', /^History/);
      await sheetToFull(page);

      // Ctrl+K: the command bar opens on the stage, which the sheet gives
      // back, so its field has focus and takes typing.
      await page.keyboard.press('ControlOrMeta+k');
      const field = page.getByRole('combobox', { name: 'Search commands' });
      await expect(field).toBeFocused();
      await page.keyboard.type('box');
      await expect(field).toHaveValue('box');
      await expect(page.locator('.app-shell > .workspace')).not.toHaveAttribute(
        'inert',
        ''
      );
      const boxRow = page.getByRole('option', { name: /^Box/ }).first();
      await expect(boxRow).toBeVisible();
      await page.keyboard.press('Enter');
      // The Box runs: its size chips stand on the stage, and its row in the
      // sheet, the History page gone from over it.
      await expect(page.getByRole('button', { name: /^Width \d/ })).toBeVisible(
        { timeout: 30_000 }
      );
      const bar = sheet(page).getByRole('group', { name: 'Box command' });
      await expect(bar).toBeVisible();
      await bar.getByRole('button', { name: /Cancel/ }).tap();
      await expect(bar).toHaveCount(0);

      // Settings and a named save are dialogs over the whole frame: each
      // opens with focus in it at full height too.
      await searchAndTap(page, 'History', /^History/);
      await sheetToFull(page);
      await page.keyboard.press('ControlOrMeta+Shift+s');
      const naming = page.getByRole('dialog', { name: 'Name this save' });
      await expect(naming).toBeVisible();
      await expect(naming.getByRole('textbox').first()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(naming).toHaveCount(0);

      await sheetToFull(page);
      await page.keyboard.press('ControlOrMeta+,');
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await expect(settings).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean(document.activeElement?.closest('[role="dialog"]'))
          )
        )
        .toBe(true);
    }
  );

  test(
    'a tool run over an open panel takes the sheet, its row in reach at once',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactProject(page, 'Tool over panel');

      // Ctrl+K over History at full height: Box from the command bar.
      await openHistoryFromMore(page);
      await sheetToFull(page);
      await page.keyboard.press('ControlOrMeta+k');
      const field = page.getByRole('combobox', { name: 'Search commands' });
      await expect(field).toBeFocused();
      await page.keyboard.type('box');
      await expect(
        page.getByRole('option', { name: /^Box/ }).first()
      ).toBeVisible();
      await page.keyboard.press('Enter');
      await expectBoxRowShown(page);

      // The header's search over History at half (at full the header is
      // under the sheet's inert background).
      await openHistoryFromMore(page);
      await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
      await searchAndTap(page, 'Box', /^Box/);
      await expectBoxRowShown(page);

      // Box's own key, B, over History at half (over a full sheet only a
      // global key goes on).
      await openHistoryFromMore(page);
      await page.keyboard.press('b');
      await expectBoxRowShown(page);
    }
  );

  test(
    'a global command on a bare digit waits for an armed command, as in the regular workspace',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(150_000);
      // Save a revision on 1, which Front view gives up.
      await page.addInitScript((key) => {
        localStorage.setItem(
          key,
          JSON.stringify({ keymap: { overrides: { 'file-save': ['1'] } } })
        );
      }, APP_SETTINGS_KEY);
      const keypadValue = page.locator('.numeric-keypad input.keypad-value');

      // The regular workspace: 1 at an armed Box is the Box's first size.
      await page.setViewportSize({ width: 1280, height: 800 });
      await stubApi(page);
      await page.goto('/');
      await page.getByLabel('Project name').fill('Digit save');
      await page.getByRole('button', { name: 'New project' }).click();
      await expect(page.locator('.viewer-host canvas')).toBeVisible({
        timeout: 60_000
      });
      await expect(
        page.locator('.app-shell[data-shell="compact"]')
      ).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+k');
      await page.keyboard.type('box');
      await page.getByRole('option', { name: /^Box/ }).first().click();
      await expect(
        page.getByRole('group', { name: 'Box command' })
      ).toBeVisible({
        timeout: 30_000
      });
      await page.keyboard.press('1');
      await expect(keypadValue).toHaveValue('1');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('group', { name: 'Box command' })
      ).toHaveCount(0);

      // The compact workspace at full height takes the key the same way:
      // the global command goes on, and the armed Box takes the digit first.
      await preferCompact(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await expect(
        page.locator('.app-shell[data-shell="compact"]')
      ).toBeVisible({
        timeout: 60_000
      });
      await searchAndTap(page, 'Box', /^Box/);
      const bar = sheet(page).getByRole('group', { name: 'Box command' });
      await expect(bar).toBeVisible({ timeout: 30_000 });
      await sheetToFull(page);
      await page.keyboard.press('1');
      await expect(keypadValue).toHaveValue('1');
    }
  );

  test(
    'a view-only share link with comments offers its visitor Comments',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await stubAnonymousApi(page);
      await preferCompact(page);
      const document = addPrimitiveFeature(
        createProjectDocument('Shared Review', toUserId('owner')),
        {
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: 30, height: 10, depth: 20 }
        }
      );
      const snapshot = sharedProjectSnapshotDocument(document);
      await page.route('**/api/share', (route) =>
        route.fulfill({
          json: {
            document: snapshot,
            project: {
              projectId: snapshot.projectId,
              name: snapshot.name,
              mode: 'view',
              comments: true
            }
          }
        })
      );
      await page.route('**/api/share/comments', (route) =>
        route.fulfill({ json: { comments: [] } })
      );
      await page.goto(`/#share=${'c'.repeat(43)}`);
      await expect(
        page.locator('.app-shell[data-shell="compact"]')
      ).toBeVisible({
        timeout: 60_000
      });

      // More › Panels holds Comments alone: the model panels are Build's,
      // which the link does not open, as in the regular workspace.
      await page.getByRole('button', { name: 'More', exact: true }).tap();
      const panelsRow = sheet(page).getByRole('button', {
        name: 'Panels',
        exact: true
      });
      await expect(panelsRow).toBeEnabled();
      await panelsRow.tap();
      const tabs = sheet(page).getByRole('tablist', { name: 'Panels' });
      await expect(tabs.getByRole('tab')).toHaveCount(1);
      await expect(
        tabs.getByRole('tab', { name: 'Comments', exact: true })
      ).toHaveAttribute('aria-selected', 'true');
      const comments = sheet(page).getByRole('tabpanel', { name: 'Comments' });
      await expect(comments).toContainText('Type your name to comment.');
      await closeSheet(page);

      // Its command-bar row, as the regular workspace lists it.
      await searchAndTap(page, 'Comments', /^Comments/);
      await expect(comments).toBeVisible();
    }
  );
});
