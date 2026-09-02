import { expect, test, type Page } from '@playwright/test';
import {
  expectBodyCount,
  stubAnonymousApi,
  stubApi
} from './openzcad-fixtures';

/**
 * The history panel in the browser it ships in.
 *
 * Restore and branch are covered from several angles in the unit suites — the
 * document algebra, the command manager, the device store, the worker routes.
 * What none of them can see is the part that broke first in practice: the
 * panel makes a request when a project opens, the rows are only clickable once
 * both stores have answered, and a restore has to survive a real exact rebuild
 * before the viewport agrees anything happened.
 */

const revisions = (page: Page) => page.locator('.revision-list .revision-row');

/**
 * Waits for the pending write to this device to land.
 *
 * A restore is stored by the ordinary debounced autosave, exactly like any
 * other edit, so the viewport shows the restored model a moment before the
 * device holds it. Reloading inside that window legitimately reopens the
 * pre-restore document — the safe direction, and not what this is testing.
 */
async function expectSaveSettled(page: Page) {
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).not.toContainText('Saving');
}

/** The row for one save point, named by the reason the panel prints. */
function revisionRow(page: Page, reason: string) {
  return page.locator('.revision-row', { hasText: reason });
}

async function addPrimitive(page: Page, primitive: RegExp) {
  await page.getByRole('button', { name: primitive }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
}

/**
 * A project holding a box at an explicit save point, then a cylinder added
 * after it. Restoring the save has something to remove and something to keep,
 * which "restore an empty project" would not.
 */
async function projectSavedWithOneBodyThenTwo(page: Page, name: string) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();

  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);

  await page.keyboard.press('ControlOrMeta+s');
  await expect(revisionRow(page, 'Manual save')).toBeVisible();
  // The account echoes the save back at the same version with a checkpoint
  // appended, and the box's meshes have to survive that echo. Dropped, with
  // no rebuild posted for an unchanged version, the box read as failed and the
  // viewport stayed blank until a reload.
  await expectSaveSettled(page);
  await expect(page.locator('.feature-flag.error')).toHaveCount(0);
  await expect(page.getByText('No bodies yet')).toHaveCount(0);

  await addPrimitive(page, /^Cylinder/);
  await expectBodyCount(page, 2);
}

test('restores a save state and undoes the restore', async ({ page }) => {
  await projectSavedWithOneBodyThenTwo(page, 'Restore Part');

  const savedRow = revisionRow(page, 'Manual save');
  await savedRow.hover();
  await savedRow.getByRole('button', { name: 'Restore Manual save' }).click();

  // The cylinder added after the save is gone; the box that was there when it
  // was taken is not. That pair is the whole meaning of restoring a save.
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).toContainText('Restored');

  // The state being left is itself a save point, written before anything was
  // replaced — the way back when the undo stack is gone.
  await expect(revisionRow(page, 'Before restore')).toBeVisible();
  await expect(revisionRow(page, 'Restored')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+z');
  await expectBodyCount(page, 2);
});

test('a restored project reopens restored', async ({ page }) => {
  await projectSavedWithOneBodyThenTwo(page, 'Durable Restore Part');

  const savedRow = revisionRow(page, 'Manual save');
  await savedRow.hover();
  await savedRow.getByRole('button', { name: 'Restore Manual save' }).click();
  await expectBodyCount(page, 1);
  await expectSaveSettled(page);

  // Reopening is where an in-memory-only restore would show itself: the undo
  // stack does not survive, so what comes back has to be what was stored.
  await page.reload();
  await expectBodyCount(page, 1);
  await expect(revisionRow(page, 'Before restore')).toBeVisible();
});

test('branches a save state into its own project, leaving the original alone', async ({
  page
}) => {
  await projectSavedWithOneBodyThenTwo(page, 'Branch Source');

  const savedRow = revisionRow(page, 'Manual save');
  await savedRow.hover();
  await savedRow
    .getByRole('button', { name: 'Branch Manual save into a new project' })
    .click();

  await expect(page.getByRole('contentinfo')).toContainText('Branched');
  // Branching copies; the project it was taken from keeps both its bodies.
  await expectBodyCount(page, 2);

  await page.getByTitle('Back to projects').click();
  const branch = page.locator('.start-tile-open', {
    hasText: 'Branch Source (copy)'
  });
  await expect(branch).toBeVisible();

  await branch.click();
  // The branch starts from the save that was picked, not from where the
  // source project had got to by the time it was picked.
  await expectBodyCount(page, 1);
});

test('offers no action for a save state whose model is not stored', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Pruned History Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(revisionRow(page, 'Manual save')).toBeVisible();
  await expectSaveSettled(page);

  // Retention can drop a stored document while the checkpoint naming it lives
  // on in the project, so the panel has to be able to say "listed, but not
  // openable" instead of offering a button that fails when pressed.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('openzcad-v2');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error('Could not open local storage.'));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(
        'projectCheckpointDocuments',
        'readwrite'
      );
      tx.objectStore('projectCheckpointDocuments').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(new Error('Could not drop stored save states.'));
    });
    database.close();
  });
  await page.reload();

  const savedRow = revisionRow(page, 'Manual save');
  await expect(savedRow).toContainText('not stored');
  await savedRow.hover();
  await expect(savedRow.getByRole('button')).toHaveCount(0);
});

test('offers no restore for the save the project is already sitting on', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Current Save Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);
  await page.keyboard.press('ControlOrMeta+s');

  // Straight after saving, the newest row IS the open document. Restoring it
  // would be an action that does nothing, so only Branch is offered.
  const savedRow = revisionRow(page, 'Manual save');
  await expect(savedRow).toBeVisible();
  await savedRow.hover();
  await expect(
    savedRow.getByRole('button', {
      name: 'Branch Manual save into a new project'
    })
  ).toBeVisible();
  await expect(
    savedRow.getByRole('button', { name: 'Restore Manual save' })
  ).toHaveCount(0);

  // One edit later the project has moved off that save, and restoring it means
  // something again.
  await addPrimitive(page, /^Cylinder/);
  await expectBodyCount(page, 2);
  await savedRow.hover();
  await expect(
    savedRow.getByRole('button', { name: 'Restore Manual save' })
  ).toBeVisible();
});

test('lists a project’s save points newest first', async ({ page }) => {
  await projectSavedWithOneBodyThenTwo(page, 'Ordered History Part');

  // The explicit save is newer than the one the project was born with.
  await expect(revisions(page)).toHaveCount(2);
  await expect(revisions(page).first()).toContainText('Manual save');
  await expect(revisions(page).last()).not.toContainText('Manual save');
});

test('names a save point, and the name is what history shows', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Named Save Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);

  // Ctrl+S is a reflex and stays one; naming is its own gesture.
  await page.keyboard.press('ControlOrMeta+Shift+s');
  const dialog = page.getByRole('dialog', { name: 'Name this save' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Save name').fill('Before the fillet pass');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();

  // The name is the only thing the panel shows for a save afterwards, which
  // is the whole reason for typing one.
  await expect(dialog).toHaveCount(0);
  await expect(revisionRow(page, 'Before the fillet pass')).toBeVisible();
  await expect(revisionRow(page, 'Manual save')).toHaveCount(0);
});

test('a named save can be restored by its name', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Named Restore Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);

  await page.keyboard.press('ControlOrMeta+Shift+s');
  const dialog = page.getByRole('dialog', { name: 'Name this save' });
  await dialog.getByLabel('Save name').fill('Just the box');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(revisionRow(page, 'Just the box')).toBeVisible();

  await addPrimitive(page, /^Cylinder/);
  await expectBodyCount(page, 2);

  const named = revisionRow(page, 'Just the box');
  await named.hover();
  await named.getByRole('button', { name: 'Restore Just the box' }).click();
  await expectBodyCount(page, 1);
  await expect(revisionRow(page, 'Restored')).toBeVisible();
});

test('refuses an empty name rather than saving an unnamed one', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Empty Name Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);

  await page.keyboard.press('ControlOrMeta+Shift+s');
  const dialog = page.getByRole('dialog', { name: 'Name this save' });
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  // An unnamed named-save is Ctrl+S with extra steps, so it is not offered.
  await expect(save).toBeDisabled();
  await dialog.getByLabel('Save name').fill('   ');
  await expect(save).toBeDisabled();

  // Escape leaves without marking anything.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(revisions(page)).toHaveCount(1);
});

test('marks a named save point with no account behind it', async ({ page }) => {
  // Signed out, the project lives only on this device and no server will
  // checkpoint it. That is exactly where restore and branch matter most, so
  // the save point — and the name — have to be made here or not at all.
  await stubAnonymousApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Offline Named Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);

  await page.keyboard.press('ControlOrMeta+Shift+s');
  const dialog = page.getByRole('dialog', { name: 'Name this save' });
  await dialog.getByLabel('Save name').fill('Local milestone');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(revisionRow(page, 'Local milestone')).toBeVisible();
  await expectSaveSettled(page);

  // And it is a real save point: it survives a reload and can be restored.
  await addPrimitive(page, /^Cylinder/);
  await expectBodyCount(page, 2);
  const named = revisionRow(page, 'Local milestone');
  await named.hover();
  await named.getByRole('button', { name: 'Restore Local milestone' }).click();
  await expectBodyCount(page, 1);
});
