import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  sharedProjectSnapshotDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { expect, stubAnonymousApi, stubApi, test } from './openzcad-fixtures';

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
      let document = createProjectDocument('Live menu', toUserId('local'));
      document = addPrimitiveFeature(document, {
        name: 'Base',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 10, depth: 30 }
      });
      document = transformBody(document, {
        name: 'Placement',
        targetBodyId: document.bodyOrder[0]!,
        translation: { x: 10, y: 0, z: 0 }
      }).document;
      await stubApi(page);
      await preferCompact(page);
      await page.goto('/');
      await page.getByRole('button', { name: 'Import project' }).tap();
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'live-menu.openzcad',
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
      await expect(
        page.locator('.app-shell[data-shell="compact"]')
      ).toBeVisible({
        timeout: 60_000
      });
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
