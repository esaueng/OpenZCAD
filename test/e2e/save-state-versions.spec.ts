import { expect, test, type Page } from '@playwright/test';
import {
  SAVE_PREVIEW_EXPORT_REASON,
  SAVE_PREVIEW_MEASURE_REASON,
  SAVE_PREVIEW_VIEW_REASON
} from '../../apps/web/src/lib/saveStatePreview';
import {
  createPrimitiveInPlace,
  expectBodyCount,
  finishExtrude,
  modelPanel,
  revealModelPanel,
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
    // #2422: every File menu export that reads the project goes through
    // the one preview gate, so none is left on.
    for (const name of ['Export IGES', 'Export CNC cut layout (DXF)']) {
      await expect(fileMenu.getByRole('button', { name })).toBeDisabled();
    }
    await fileMenu.locator('summary').click();

    // #2422: the saved views are the project's. The view on screen frames
    // the version, so none is saved from it.
    const views = page.getByRole('button', {
      name: 'Standard views',
      exact: true
    });
    await views.click();
    const savedViews = page.getByRole('group', { name: 'Saved views' });
    await savedViews.getByRole('button', { name: /Save view/ }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      SAVE_PREVIEW_VIEW_REASON
    );
    await expect(
      savedViews.getByRole('button', { name: /^Go to / })
    ).toHaveCount(0);
    await views.click();
    await expect(notice).toContainText('Previewing “Manual save”');

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
  'a preview still building does not open over the workspace switched to',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    // #2422: Draw is opened while the version builds. The preview it would
    // have been is over, so it never installs: Draw stays on the project,
    // which it edits and exports.
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Preview Race');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    await page.keyboard.press('ControlOrMeta+s');
    const saved = revisionRow(page, 'Manual save');
    await expect(saved).toBeVisible();
    await expectSaveSettled(page);
    await createPrimitiveInPlace(page, 'cylinder');
    await expectBodyCount(page, 2);

    await saved.hover();
    const preview = saved.getByRole('button', { name: 'Preview Manual save' });
    const modes = page.getByRole('group', { name: 'Workspace mode' });
    const draw = modes.getByRole('button', { name: 'Draw' });
    await expect(preview).toBeVisible();
    // One task: the preview is asked for, then Draw is opened before the
    // version can have built.
    await page.evaluate(
      ([previewButton, drawButton]) => {
        (previewButton as HTMLElement).click();
        (drawButton as HTMLElement).click();
      },
      [await preview.elementHandle(), await draw.elementHandle()]
    );
    await expect(draw).toHaveAttribute('aria-pressed', 'true');
    const newSheet = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('button', { name: 'New drawing sheet' });
    await expect(newSheet).toBeEnabled();
    // Long enough for a two-body version to build and install, were it
    // still wanted.
    await page.waitForTimeout(2_500);
    await expect(
      page.getByRole('region', { name: 'Save preview' })
    ).toHaveCount(0);
    await expect(newSheet).toBeEnabled();

    await modes.getByRole('button', { name: 'View' }).click();
    await expect(
      page.locator('canvas[data-e2e-rendered-bodies]')
    ).toHaveAttribute('data-e2e-rendered-bodies', '2');
    await expect(
      page.getByRole('region', { name: 'Save preview' })
    ).toHaveCount(0);
  }
);

test(
  'a preview still building does not open once the Revisions panel is closed',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    // #2422: closing the panel a preview was asked from ends the request.
    // The version does not take over the viewport, and lock editing, after
    // the place to close it from has gone.
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Preview Closed');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    await page.keyboard.press('ControlOrMeta+s');
    const saved = revisionRow(page, 'Manual save');
    await expect(saved).toBeVisible();
    await expectSaveSettled(page);
    await createPrimitiveInPlace(page, 'cylinder');
    await expectBodyCount(page, 2);

    await revealModelPanel(page, 'Revisions');
    await saved.hover();
    const preview = saved.getByRole('button', { name: 'Preview Manual save' });
    const close = modelPanel(page, 'Revisions').getByRole('button', {
      name: 'Close Revisions'
    });
    await expect(preview).toBeVisible();
    await expect(close).toBeVisible();
    // One task: the preview is asked for, then its panel is closed before
    // the version can have built.
    await page.evaluate(
      ([previewButton, closeButton]) => {
        (previewButton as HTMLElement).click();
        (closeButton as HTMLElement).click();
      },
      [await preview.elementHandle(), await close.elementHandle()]
    );
    await expect(modelPanel(page, 'Revisions')).toHaveCount(0);
    // Long enough for a two-body version to build and install, were it
    // still wanted.
    await page.waitForTimeout(2_500);
    await expect(
      page.getByRole('region', { name: 'Save preview' })
    ).toHaveCount(0);
    await expect(
      page.locator('canvas[data-e2e-rendered-bodies]')
    ).toHaveAttribute('data-e2e-rendered-bodies', '2');
    // Editing was never locked: the project still takes a new body.
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 3);
  }
);

test(
  'a previewed version shows a sketch the project has since consumed',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    // #2422: the save holds an open sketch; the project then extrudes it,
    // which hides it. Whether a sketch is drawn over the version is the
    // version's own features' say, on screen and in a PNG of the view.
    test.setTimeout(120_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Preview Consumed');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
    await page.getByRole('button', { name: 'Top (XY)' }).click();
    await expect(
      page.getByRole('toolbar', { name: 'Sketch tools' })
    ).toBeVisible();
    await page.waitForTimeout(800);
    const canvas = page.locator('.viewer-host canvas');
    const bounds = (await canvas.boundingBox())!;
    await page.keyboard.press('r');
    await page.mouse.click(
      bounds.x + bounds.width * 0.55,
      bounds.y + bounds.height * 0.4
    );
    await page.mouse.click(
      bounds.x + bounds.width * 0.68,
      bounds.y + bounds.height * 0.55
    );
    await expect(page.getByRole('contentinfo')).toContainText(/Sketch 01/);
    await page.getByRole('button', { name: /^Finish sketch/i }).click();
    const outlined = () =>
      page.evaluate(
        () =>
          JSON.parse(
            document.documentElement.dataset.e2eOutlinedSketches ?? '[]'
          ) as string[]
      );
    await expect.poll(outlined).not.toEqual([]);
    const sketches = await outlined();

    await page.keyboard.press('ControlOrMeta+s');
    const saved = revisionRow(page, 'Manual save');
    await expect(saved).toBeVisible();
    await expectSaveSettled(page);

    // Extruded, the sketch is consumed: the project no longer outlines it.
    await revealModelPanel(page, 'History');
    await page.locator('.feature-row-main', { hasText: 'Sketch 01' }).click();
    await page.keyboard.press('e');
    await finishExtrude(page, '5');
    await expectBodyCount(page, 1);
    await page.keyboard.press('Escape');
    await expect.poll(outlined).toEqual([]);

    await revealModelPanel(page, 'Revisions');
    await saved.hover();
    await saved.getByRole('button', { name: 'Preview Manual save' }).click();
    const notice = page.getByRole('region', { name: 'Save preview' });
    await expect(notice).toContainText('Previewing “Manual save”');
    await expect.poll(outlined).toEqual(sketches);

    await notice.getByRole('button', { name: 'Close preview' }).click();
    await expect(notice).toHaveCount(0);
    await expect.poll(outlined).toEqual([]);
  }
);

test(
  'a previewed version is outlined with its own sketches',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    // #2422: a sketch drawn after the save is the project's. Over the
    // version it is not outlined, so neither the viewport nor a PNG of it
    // shows a sketch the version does not have.
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Preview Sketches');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
    await page.getByRole('button', { name: 'Top (XY)' }).click();
    await expect(
      page.getByRole('toolbar', { name: 'Sketch tools' })
    ).toBeVisible();
    await page.waitForTimeout(800);
    const canvas = page.locator('.viewer-host canvas');
    const bounds = (await canvas.boundingBox())!;
    await page.keyboard.press('r');
    await page.mouse.click(
      bounds.x + bounds.width * 0.55,
      bounds.y + bounds.height * 0.4
    );
    await page.mouse.click(
      bounds.x + bounds.width * 0.68,
      bounds.y + bounds.height * 0.55
    );
    await expect(page.getByRole('contentinfo')).toContainText(/Sketch 01/);
    await page.getByRole('button', { name: /^Finish sketch/i }).click();
    const outlined = () =>
      page.evaluate(
        () =>
          JSON.parse(
            document.documentElement.dataset.e2eOutlinedSketches ?? '[]'
          ) as string[]
      );
    await expect.poll(outlined).not.toEqual([]);

    const initial = revisionRow(page, 'Initial document');
    await initial.hover();
    await initial
      .getByRole('button', { name: 'Preview Initial document' })
      .click();
    const notice = page.getByRole('region', { name: 'Save preview' });
    await expect(notice).toContainText('Previewing “Initial document”');
    await expect.poll(outlined).toEqual([]);

    await notice.getByRole('button', { name: 'Close preview' }).click();
    await expect(notice).toHaveCount(0);
    await expect.poll(outlined).not.toEqual([]);
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
