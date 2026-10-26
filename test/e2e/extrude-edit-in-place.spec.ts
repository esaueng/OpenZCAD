import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  barChoice,
  chooseBarOption,
  chooseInPlaceOption,
  editExtrudeFromHistory,
  enterCommandValue,
  setBarValues,
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U09: History edits of an extrude run in place. Its row re-arms the
 * in-place Extrude seeded from the stored feature, with handles on the model
 * (its own distance arrow, the back arrow, the draft rig), everything else
 * under the bar's Options, and Done writes the same update the card's Apply
 * did. No form opens.
 */

type Handles = Record<string, { x: number; y: number; value: number }>;

async function openDocument(page: Page, document: ProjectDocument) {
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            project: {
              projectId: document.projectId,
              name: document.name,
              revisionCount: 1,
              updatedAt: new Date().toISOString()
            },
            document
          }
        })
      : route.fulfill({ json: { projects: [] } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
}

async function exportedDocument(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download', { timeout: 15_000 });
  await menu.getByRole('button', { name: /Export project/ }).click();
  const download = await pending;
  if ((await menu.getAttribute('open')) !== null) {
    await menu.locator('summary').click();
  }
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

function storedPost(document: ProjectDocument): FeatureNode {
  return listFeaturesInOrder(document).find(
    (feature) => feature.name === 'Post'
  )!;
}

async function handles(canvas: Locator): Promise<Handles> {
  return canvas.evaluate((element) =>
    element.dataset.e2eCommandHandles
      ? (JSON.parse(element.dataset.e2eCommandHandles) as Handles)
      : {}
  );
}

/** A base plate and a post extruded 10 by an expression, beside it. */
function postDocument(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 4 }
  });
  const sketched = addSketchFeature(document, {
    name: 'Post sketch',
    plane: 'XY',
    offset: 0,
    objects: [
      {
        objectKind: 'rectangle',
        width: 10,
        height: 6,
        centerX: 40,
        centerY: 0
      }
    ]
  });
  return extrudeSketch(sketched.document, {
    name: 'Post',
    sketchId: sketched.sketchId,
    distance: '5 * 2'
  }).document;
}

test('an untouched Done writes the extrude back exactly as stored', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openDocument(page, postDocument('Extrude edit round trip'));
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  const before = storedPost(await exportedDocument(page));

  await revealModelPanel(page, 'History');
  const row = page.locator('.feature-row-main[title^="Post — "]');
  const bar = await editExtrudeFromHistory(page, row, 'Post');
  await expect(page.locator('form.feature-form')).toHaveCount(0);
  // Seeded from the stored feature, the expression as written.
  await bar.locator('details.in-place-command-options summary').click();
  await expect(
    bar.getByRole('button', { name: 'Distance', exact: true })
  ).toHaveText('5 * 2');
  await expect(
    bar
      .getByRole('radiogroup', { name: 'Operation', exact: true })
      .getByRole('radio', { name: 'New body', exact: true })
  ).toHaveAttribute('aria-checked', 'true');
  // An edit keeps its operation: nothing to infer.
  await expect(
    bar.getByRole('radio', { name: 'Automatic', exact: true })
  ).toHaveCount(0);
  await bar.locator('details.in-place-command-options summary').click();
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toHaveCount(0, { timeout: 30_000 });

  const after = storedPost(await exportedDocument(page));
  expect(after.data).toEqual(before.data);
  expect(after.name).toBe(before.name);
  expect(errors).toEqual([]);
});

test('a History row re-arms the extrude: a drag, the keypad and an Option, then Done', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubApi(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openDocument(page, postDocument('Extrude edit in place'));
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }

  await revealModelPanel(page, 'History');
  const row = page.locator('.feature-row-main[title^="Post — "]');
  const bar = await editExtrudeFromHistory(page, row, 'Post');

  // Its own distance arrow stands on the post's top: drag it up a little.
  await expect
    .poll(async () => (await handles(canvas)).distance?.value)
    .toBe(10);
  const grip = (await handles(canvas)).distance!;
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x, grip.y - 40, { steps: 10 });
  await page.mouse.up();
  const chip = page.getByTestId('command-handle-distance');
  await expect
    .poll(async () => Number((await chip.textContent())?.match(/[\d.]+/)?.[0]))
    .toBeGreaterThan(10);

  // The chip's keypad sets it exactly, and Symmetric comes from Options.
  await enterCommandValue(page, 'distance', '14');
  await expect(chip).toHaveText('14 mm');
  await chooseInPlaceOption(page, 'Edit Post', 'Sides', 'Symmetric');
  await expect(bar.getByRole('button', { name: 'Done' })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toHaveCount(0, { timeout: 30_000 });

  const post = storedPost(await exportedDocument(page));
  expect(post.data).toMatchObject({ distance: 14, symmetric: true });
  // Undo puts the stored feature back.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => storedPost(await exportedDocument(page)).data)
    .toMatchObject({ distance: '5 * 2' });
  expect(errors).toEqual([]);
});

test('Esc leaves an extrude edit with the feature as it was', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await openDocument(page, postDocument('Extrude edit cancel'));
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  const before = storedPost(await exportedDocument(page));
  await revealModelPanel(page, 'History');
  const row = page.locator('.feature-row-main[title^="Post — "]');
  const bar = await editExtrudeFromHistory(page, row, 'Post');
  await chooseInPlaceOption(page, 'Edit Post', 'Operation', 'Add');
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  expect(storedPost(await exportedDocument(page)).data).toEqual(before.data);
});

for (const command of ['an edit', 'a new extrude'] as const) {
  test(`Esc disarms ${command}'s face pick first, and only then leaves it`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await openDocument(page, postDocument(`Extrude face pick Esc ${command}`));
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
      timeout: 30_000
    });
    let bar: Locator;
    if (command === 'an edit') {
      await revealModelPanel(page, 'History');
      bar = await editExtrudeFromHistory(
        page,
        page.locator('.feature-row-main[title^="Post — "]'),
        'Post'
      );
    } else {
      // The post's sketch is consumed; a second sketch gives a region.
      await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
      await page.getByRole('button', { name: 'Top (XY)' }).click();
      const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
      const bounds = (await canvas.boundingBox())!;
      const centre = {
        x: bounds.x + bounds.width * 0.3,
        y: bounds.y + bounds.height * 0.7
      };
      await sketchTools.getByRole('button', { name: /^Circle/ }).click();
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down();
      await page.mouse.move(centre.x + 30, centre.y, { steps: 6 });
      await page.mouse.up();
      await sketchTools.getByRole('button', { name: 'Extrude' }).click();
      bar = page.getByRole('group', { name: 'Extrude command' });
      await expect(bar).toBeVisible();
    }
    await chooseBarOption(bar, 'Extent', 'To face');
    await expect(bar).toContainText(
      'Click a planar face parallel to the sketch'
    );
    // One press disarms the pick; the command and its extent stay.
    await page.keyboard.press('Escape');
    await expect(bar).toBeVisible();
    await expect(bar).not.toContainText(
      'Click a planar face parallel to the sketch'
    );
    await expect(barChoice(bar, 'Extent', 'To face')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    // The next leaves the command.
    await page.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
  });
}

test('an edit armed over a new extrude stands its handles at once', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  // A spare sketch beside the post, for a new extrude to start on.
  const document = addSketchFeature(postDocument('Extrude edit over create'), {
    name: 'Spare sketch',
    plane: 'XY',
    offset: 0,
    objects: [{ objectKind: 'circle', radius: 3, centerX: -30, centerY: 0 }]
  }).document;
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  const create = page.getByRole('group', { name: 'Extrude command' });
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-profile', {
            detail: { index: 0, additive: false }
          })
        )
      );
      return create.count();
    })
    .toBe(1);
  await setBarValues(page, create, { Distance: '6' });

  // Straight from the new extrude to the post's History row.
  await revealModelPanel(page, 'History');
  const edit = await editExtrudeFromHistory(
    page,
    page.locator('.feature-row-main[title^="Post — "]'),
    'Post'
  );
  await expect(create).toHaveCount(0);
  await expect
    .poll(async () => (await handles(canvas)).distance?.value, {
      timeout: 30_000
    })
    .toBe(10);
  await expect(page.getByTestId('command-handle-distance')).toHaveText('10 mm');
  await edit.getByRole('button', { name: 'Cancel' }).click();
});

test('an extrude edit ends cleanly: Cancel leaves no profile picked, and a rename is never written back', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await openDocument(page, postDocument('Extrude edit cancel and rename'));
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  await revealModelPanel(page, 'History');
  const row = page.locator('.feature-row-main[title^="Post — "]');

  // Cancel: nothing selected, the post's profile included (no Extrude
  // quick action offered on it).
  let edit = await editExtrudeFromHistory(page, row, 'Post');
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(edit).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Selected closed profile' })
  ).toHaveCount(0);
  await expect(
    page.locator('button.body-row-main[title^="Post sketch"]')
  ).toHaveAttribute('aria-pressed', 'false');

  // A rename from History while the edit is open closes it, as it closed
  // the card: nothing can write the old name back.
  edit = await editExtrudeFromHistory(page, row, 'Post');
  await setBarValues(page, edit, { Distance: '12' });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = page.getByRole('textbox', { name: 'Rename Post' });
  await field.fill('Tall post');
  await field.press('Enter');
  await expect(edit).toHaveCount(0);
  const renamed = listFeaturesInOrder(await exportedDocument(page)).find(
    (feature) => feature.featureKind === 'extrude'
  )!;
  expect(renamed.name).toBe('Tall post');
  expect(renamed.data).toMatchObject({ distance: '5 * 2' });
  // Re-armed, the edit is titled for the new name and Done keeps it.
  const tall = await editExtrudeFromHistory(
    page,
    page.locator('.feature-row-main[title^="Tall post — "]'),
    'Tall post'
  );
  await tall.getByRole('button', { name: 'Done' }).click();
  await expect(tall).toHaveCount(0, { timeout: 30_000 });
  expect(
    listFeaturesInOrder(await exportedDocument(page)).find(
      (feature) => feature.featureKind === 'extrude'
    )!.name
  ).toBe('Tall post');
});
