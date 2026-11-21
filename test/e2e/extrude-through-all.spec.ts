import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  barChoice,
  chooseBarOption,
  expectBarChoice,
  editExtrudeFromHistory,
  chooseInPlaceOption,
  extrudeBar,
  expectFeatureMeasurement
} from './openzcad-fixtures';

/**
 * F01 through-all, first slice: an existing blind cut is switched to Through
 * all in its editor, the committed body is the full-depth cut, the card
 * reopens showing what was stored, and one undo restores the blind pocket.
 */
test('switches a blind cut to through all and back through undo', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  let document = createProjectDocument(
    'Through-all pocket',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 40, depth: 10 }
  });
  const plateId = document.bodyOrder[0]!;
  const sketched = addSketchFeature(document, {
    name: 'Pocket sketch',
    plane: 'XY',
    offset: 10,
    objects: [
      {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 20,
        centerY: 20
      }
    ]
  });
  document = extrudeSketch(sketched.document, {
    name: 'Pocket',
    sketchId: sketched.sketchId,
    distance: -3,
    operation: 'cut',
    targetBodyId: plateId
  }).document;
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
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await expectBodyCount(page, 1);

  const pocket = page
    .locator('.feature-row-main', { hasText: 'Pocket' })
    .last();
  const pocketRow = page.locator('.feature-row:not(.is-sketch)', {
    has: pocket
  });
  await expectFeatureMeasurement(page, pocketRow, '15700');
  let edit = await editExtrudeFromHistory(page, pocket);

  await chooseBarOption(edit, 'Extent', 'Through all');
  // Through all takes no distance.
  await expect(
    edit.getByRole('button', {
      name: 'Distance',
      exact: true,
      includeHidden: true
    })
  ).toHaveCount(0);
  await chooseBarOption(edit, 'Direction', 'Reverse');
  await edit.getByRole('button', { name: 'Done' }).click();
  // A successful edit closes; reopen it to read what was committed.
  await expect(edit).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  // 40 × 40 × 10 less a 10 × 10 hole through all 10, and the edit reopens
  // on what was stored rather than the dormant distance.
  await expectFeatureMeasurement(page, pocketRow, '15000');
  edit = await editExtrudeFromHistory(page, pocket);
  await expectBarChoice(edit, 'Extent', 'Through all');
  await expect(barChoice(edit, 'Direction', 'Reverse')).toHaveAttribute(
    'aria-checked',
    'true'
  );

  await edit.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  edit = await editExtrudeFromHistory(page, pocket);
  await expectBarChoice(edit, 'Extent', 'Distance');
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expectFeatureMeasurement(page, pocketRow, '15700');
});

test(
  'creates a cut through all straight from a sketch',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    let document = createProjectDocument(
      'Through-all create',
      toUserId('user_e2e')
    );
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 40, depth: 10 }
    });
    document = addSketchFeature(document, {
      name: 'Slot sketch',
      plane: 'XY',
      offset: 10,
      objects: [
        {
          objectKind: 'rectangle',
          width: 10,
          height: 10,
          centerX: 20,
          centerY: 20
        }
      ]
    }).document;
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
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
      'data-e2e-rendered-bodies',
      '1',
      { timeout: 30_000 }
    );

    await page.locator('.feature-row-main', { hasText: 'Slot sketch' }).click();
    await page.keyboard.press('e');
    const bar = extrudeBar(page);
    await chooseInPlaceOption(page, 'Extrude', 'Operation', 'Cut');
    await chooseInPlaceOption(page, 'Extrude', 'Extent', 'Through all');
    await chooseInPlaceOption(page, 'Extrude', 'Direction', 'Reverse');
    // No distance was typed: through all needs none.
    await bar.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Cut the region through all of the target.',
      { timeout: 30_000 }
    );
    await expectBodyCount(page, 1);
    const cut = page.locator('.feature-row-main', { hasText: 'Extrude' });
    // The row re-arms the edit, whose bar is the whole edit; the readout is
    // the row menu's Measurements.
    await expectFeatureMeasurement(
      page,
      page.locator('.feature-row', { has: cut }),
      '15000'
    );
    const edit = await editExtrudeFromHistory(page, cut);
    await expectBarChoice(edit, 'Extent', 'Through all');
  }
);

/**
 * F01: an add runs through all too. A tab sketched half off the plate's
 * edge, at its mid-plane, grows through the plate's whole thickness on both
 * sides and joins it; undo restores the 2 mm tab.
 */
test(
  'switches a blind add to through all on both sides and back through undo',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    let document = createProjectDocument(
      'Through-all add',
      toUserId('user_e2e')
    );
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 40, depth: 10 }
    });
    const plateId = document.bodyOrder[0]!;
    const sketched = addSketchFeature(document, {
      name: 'Tab sketch',
      plane: 'XY',
      offset: 5,
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 40,
          centerY: 20
        }
      ]
    });
    document = extrudeSketch(sketched.document, {
      name: 'Tab',
      sketchId: sketched.sketchId,
      distance: 2,
      operation: 'add',
      targetBodyId: plateId
    }).document;
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
    await page.getByRole('button', { name: 'New project' }).click();
    await expectBodyCount(page, 1);
    const tab = page.locator('.feature-row-main', { hasText: 'Tab' }).last();
    const tabRow = page.locator('.feature-row:not(.is-sketch)', { has: tab });
    // 40 × 40 × 10 and the 2 × 4 × 2 of the tab beside the plate.
    await expectFeatureMeasurement(page, tabRow, '16016');
    let edit = await editExtrudeFromHistory(page, tab);
    await chooseBarOption(edit, 'Extent', 'Through all');
    await chooseBarOption(edit, 'Direction', 'Both');
    await edit.getByRole('button', { name: 'Done' }).click();
    await expect(edit).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expect(tabRow).toContainText('Through all, both sides');
    // The tab now spans the plate's whole 10 mm: 2 × 4 × 10 beside it.
    await expectFeatureMeasurement(page, tabRow, '16080');
    edit = await editExtrudeFromHistory(page, tab);
    await expectBarChoice(edit, 'Extent', 'Through all');
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectFeatureMeasurement(page, tabRow, '16016');
  }
);

/**
 * F01: one through-all cut through two plates. Each body becomes its own
 * through-all cut, created as one step from the bar and undone as one.
 */
test(
  'cuts through all of two picked bodies in one step, and undoes both',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    let document = createProjectDocument('Through two', toUserId('user_e2e'));
    const ids: string[] = [];
    for (const [name, z] of [
      ['Lower', 0],
      ['Upper', 20]
    ] as const) {
      document = addPrimitiveFeature(document, {
        name,
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      });
      const bodyId = document.bodyOrder.at(-1)!;
      ids.push(bodyId);
      document = transformBody(document, {
        name: `Lift ${name}`,
        targetBodyId: bodyId,
        translation: { x: 0, y: 0, z }
      }).document;
    }
    const bodyName = (bodyId: string) =>
      Object.values(document.nodes).find(
        (node) => node.kind === 'body' && node.bodyId === bodyId
      )!.name;
    document = addSketchFeature(document, {
      name: 'Slot sketch',
      plane: 'XY',
      offset: 40,
      objects: [
        {
          objectKind: 'rectangle',
          width: 10,
          height: 10,
          centerX: 20,
          centerY: 20
        }
      ]
    }).document;
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
    await page.getByRole('button', { name: 'New project' }).click();
    await expectBodyCount(page, 2);

    await page.locator('.feature-row-main', { hasText: 'Slot sketch' }).click();
    await page.keyboard.press('e');
    const bar = extrudeBar(page);
    await chooseInPlaceOption(page, 'Extrude', 'Operation', 'Cut');
    await chooseInPlaceOption(
      page,
      'Extrude',
      'Target body',
      bodyName(ids[0]!)
    );
    await chooseInPlaceOption(page, 'Extrude', 'Extent', 'Through all');
    await chooseInPlaceOption(page, 'Extrude', 'Direction', 'Reverse');
    await chooseInPlaceOption(page, 'Extrude', 'Also cut', bodyName(ids[1]!));
    await bar.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Cut the region through all of 2 bodies.',
      { timeout: 30_000 }
    );
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expectBodyCount(page, 2);
    const cuts = page.locator('.feature-row:not(.is-sketch)', {
      has: page.locator('.feature-row-main', { hasText: 'Extrude' })
    });
    await expect(cuts).toHaveCount(2);
    // 40 × 40 × 10 less the 10 × 10 hole through each plate.
    for (const index of [0, 1]) {
      await expectFeatureMeasurement(page, cuts.nth(index), '15000');
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(cuts).toHaveCount(0);
  }
);
