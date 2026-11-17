import { expect, test, type Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  expectBodyCount,
  stubApi
} from './openzcad-fixtures';

/**
 * L03 versions list: each save point names who made it, on which device and
 * where its model is stored, and can be renamed after the fact. The rename is
 * a document write, so it has to survive the autosave and a reload, and the
 * name it replaces stays readable in the row's details.
 */

function revisionRow(page: Page, name: string) {
  return page.locator('.revision-row', {
    has: page.locator('.revision-reason', { hasText: name })
  });
}

async function expectSaveSettled(page: Page) {
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).not.toContainText('Saving');
}

test(
  'lists who saved each version and renames a save point',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Versions Part');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);

    await page.keyboard.press('ControlOrMeta+s');
    const saved = revisionRow(page, 'Manual save');
    await expect(saved).toBeVisible();
    await expectSaveSettled(page);
    // The signed-in account's own save, this browser, and where it is kept:
    // the stub account lists no stored revisions, so this device only.
    const meta = saved.locator('.revision-meta');
    await expect(meta.locator('.revision-editor')).toHaveText(/^You/);
    await expect(meta.locator('.revision-device')).toHaveText(/ on /);
    await expect(meta.locator('.revision-sync')).toHaveText('This device');

    await saved.locator('.revision-reason').click();
    await saved.getByRole('button', { name: 'Rename Manual save' }).click();
    const field = page.getByRole('textbox', { name: 'Name for Manual save' });
    await field.fill('Before fillets');
    await field.press('Enter');

    const renamed = revisionRow(page, 'Before fillets');
    await expect(renamed).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Renamed the save point'
    );
    await expect(renamed.locator('.revision-details')).toContainText(
      'Saved as “Manual save”'
    );
    // Renaming a save point leaves the model alone.
    await expectBodyCount(page, 1);
    await expectSaveSettled(page);

    await page.reload();
    const reopened = revisionRow(page, 'Before fillets');
    await expect(reopened).toBeVisible();
    await expect(reopened.locator('.revision-editor')).toHaveText(/^You/);
    await expect(revisionRow(page, 'Manual save')).toHaveCount(0);
  }
);

test(
  'previews a saved version read only, then restores it from the preview',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Preview Part');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(revisionRow(page, 'Manual save')).toBeVisible();
    await expectSaveSettled(page);
    await createPrimitiveInPlace(page, 'cylinder');
    await expectBodyCount(page, 2);

    const saved = revisionRow(page, 'Manual save');
    await saved.hover();
    await saved.getByRole('button', { name: 'Preview Manual save' }).click();
    const notice = page.getByRole('region', { name: 'Save preview' });
    await expect(notice).toContainText('Previewing “Manual save”');
    // The saved version builds one body; the project still has two.
    await expect(notice).toContainText('1 body · read only');
    await expectBodyCount(page, 2);
    await expect(saved).toHaveClass(/is-previewing/);
    // The viewport draws the saved version, not the project.
    const canvas = page.locator('canvas[data-e2e-rendered-bodies]');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');

    // Read only: an undo while previewing changes nothing.
    await page.keyboard.press('ControlOrMeta+z');
    await expectBodyCount(page, 2);
    await expect(notice).toBeVisible();

    await notice.getByRole('button', { name: 'Close preview' }).click();
    await expect(notice).toHaveCount(0);
    await expectBodyCount(page, 2);
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2');

    await saved.hover();
    await saved.getByRole('button', { name: 'Preview Manual save' }).click();
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Restore' }).click();
    await expectBodyCount(page, 1);
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).toContainText(
      'Restored “Manual save”'
    );
  }
);
