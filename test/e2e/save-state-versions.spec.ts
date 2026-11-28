import { expect, test, type Page } from '@playwright/test';
import {
  SAVE_PREVIEW_EXPORT_REASON,
  SAVE_PREVIEW_MEASURE_REASON
} from '../../apps/web/src/lib/saveStatePreview';
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
    // This device drew the save's card from the model on screen.
    await expect(
      saved.getByRole('img', { name: 'The model at Manual save' })
    ).toHaveAttribute('src', /^data:image\//);
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

test(
  'a previewed version refuses the exports and Measure that read the project',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    // #2366, #2364: the project has two bodies and the save one, so a file
    // or a reading taken from the project cannot pass for the version's.
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Preview Reads');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    await page.keyboard.press('ControlOrMeta+s');
    const saved = revisionRow(page, 'Manual save');
    await expect(saved).toBeVisible();
    await expectSaveSettled(page);
    await createPrimitiveInPlace(page, 'cylinder');
    await expectBodyCount(page, 2);

    const fileMenu = page.locator('details.file-menu');
    const exportStep = fileMenu.getByRole('button', { name: /^Export STEP/ });
    const exportMesh = fileMenu.getByRole('button', { name: /^Export mesh/ });
    await fileMenu.locator('summary').click();
    await expect(exportStep).toBeEnabled();
    await fileMenu.locator('summary').click();

    await saved.hover();
    await saved.getByRole('button', { name: 'Preview Manual save' }).click();
    const notice = page.getByRole('region', { name: 'Save preview' });
    await expect(notice).toContainText('Previewing “Manual save”');
    const canvas = page.locator('canvas[data-e2e-rendered-bodies]');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');

    // The exports read the project: none is offered over the version, and
    // each says why and what does export.
    await fileMenu.locator('summary').click();
    await expect(exportStep).toBeDisabled();
    await expect(exportStep).toHaveAttribute(
      'title',
      SAVE_PREVIEW_EXPORT_REASON
    );
    await expect(exportMesh).toBeDisabled();
    await fileMenu.locator('summary').click();

    // Measure does not open on the project behind the preview, and the
    // preview stays, saying how to measure.
    await page
      .getByRole('toolbar', { name: 'Viewer bar' })
      .getByRole('button', { name: 'Measure', exact: true })
      .click();
    await expect(page.getByRole('contentinfo')).toContainText(
      SAVE_PREVIEW_MEASURE_REASON
    );
    await expect(page.getByLabel('Measurement workbench')).toHaveCount(0);
    await expect(notice).toContainText('Previewing “Manual save”');
    await expect(saved).toHaveClass(/is-previewing/);
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');

    // Closed, the project exports and measures again.
    await notice.getByRole('button', { name: 'Close preview' }).click();
    await expect(notice).toHaveCount(0);
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2');
    await fileMenu.locator('summary').click();
    await expect(exportStep).toBeEnabled();
    await fileMenu.locator('summary').click();
    await page
      .getByRole('toolbar', { name: 'Viewer bar' })
      .getByRole('button', { name: 'Measure', exact: true })
      .click();
    await expect(page.getByLabel('Measurement workbench')).toBeVisible();
  }
);

test(
  'compares a save point with the project now',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Compare Part');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    await page.keyboard.press('ControlOrMeta+s');
    const saved = revisionRow(page, 'Manual save');
    await expect(saved).toBeVisible();
    await expectSaveSettled(page);
    await createPrimitiveInPlace(page, 'cylinder');
    await expectBodyCount(page, 2);

    await saved.locator('.revision-reason').click();
    await saved.getByRole('button', { name: 'Compare Manual save' }).click();
    const dialog = page.getByRole('dialog', { name: 'Compare “Manual save”' });
    await expect(dialog).toBeVisible();
    // From the save to now: the cylinder and its body were added.
    await expect(
      dialog.getByRole('region', { name: 'Features' })
    ).toContainText('Added');
    await expect(dialog.getByRole('region', { name: 'Bodies' })).toContainText(
      'Added'
    );
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    // Comparing changed nothing.
    await expectBodyCount(page, 2);
  }
);
