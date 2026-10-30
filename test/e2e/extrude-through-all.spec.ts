import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  barChoice,
  chooseBarOption,
  editExtrudeFromHistory,
  chooseInPlaceOption,
  extrudeBar
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
  const panel = page.locator('.panel-body');
  let edit = await editExtrudeFromHistory(page, pocket);
  await expect(panel).toContainText('15700');

  await chooseBarOption(edit, 'Extent', 'Through all');
  // Through all takes no distance.
  await expect(
    edit.getByRole('button', {
      name: 'Distance',
      exact: true,
      includeHidden: true
    })
  ).toHaveCount(0);
  await chooseBarOption(edit, 'Direction', 'Against the sketch normal');
  await edit.getByRole('button', { name: 'Done' }).click();
  // A successful edit closes; reopen it to read what was committed.
  await expect(edit).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  edit = await editExtrudeFromHistory(page, pocket);
  // 40 × 40 × 10 less a 10 × 10 hole through all 10, and the edit reopens
  // on what was stored rather than the dormant distance.
  await expect(panel).toContainText('15000', { timeout: 30_000 });
  await expect(barChoice(edit, 'Extent', 'Through all')).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(
    barChoice(edit, 'Direction', 'Against the sketch normal')
  ).toHaveAttribute('aria-checked', 'true');

  await edit.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  edit = await editExtrudeFromHistory(page, pocket);
  await expect(barChoice(edit, 'Extent', 'Distance')).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(panel).toContainText('15700', { timeout: 30_000 });
});

test('creates a cut through all straight from a sketch', { tag: '@ci-smoke' }, async ({ page }) => {
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
  await chooseInPlaceOption(
    page,
    'Extrude',
    'Direction',
    'Against the sketch normal'
  );
  // No distance was typed: through all needs none.
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cut the region through all of the target.',
    { timeout: 30_000 }
  );
  await expectBodyCount(page, 1);
  const cut = page.locator('.feature-row-main', { hasText: 'Extrude' });
  const edit = await editExtrudeFromHistory(page, cut);
  await expect(page.locator('.panel-body')).toContainText('15000', {
    timeout: 30_000
  });
  await expect(barChoice(edit, 'Extent', 'Through all')).toHaveAttribute(
    'aria-checked',
    'true'
  );
});
