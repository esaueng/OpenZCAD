import type { Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  finishInPlaceCommand,
  pickObjectsBody,
  barChoice,
  chooseBarOption,
  editExtrudeFromHistory,
  expectFeatureMeasurement,
  pressTool
} from './openzcad-fixtures';

/**
 * Research-audit Stage 4 (schema v24) through the real workspace: a Boolean
 * that keeps its base body (M11) and an extrude switched to Intersect
 * (ZC-060). Volumes are the closed forms the kernel suite also asserts.
 */
async function openSeeded(page: Page, document: ProjectDocument) {
  await stubApi(page);
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
}

test('subtracts while keeping the base body, then reopens the choice', async ({
  page
}) => {
  test.setTimeout(120_000);
  let document = createProjectDocument('Kept base', toUserId('user_e2e'));
  for (const name of ['Left', 'Right']) {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
  }
  document = transformBody(document, {
    name: 'Offset Right',
    targetBodyId: document.bodyOrder[1]!,
    translation: { x: 5, y: 5, z: 0 }
  }).document;
  await openSeeded(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });

  // U09: Subtract runs in place; keeping the base is a rare choice behind
  // the bar's Options menu.
  await pressTool(page, /^Subtract \(X\)/);
  await pickObjectsBody(page, 'Left');
  await pickObjectsBody(page, 'Right');
  const subtractBar = page.getByRole('group', { name: 'Subtract command' });
  await subtractBar.locator('summary').click();
  await subtractBar.getByRole('radio', { name: 'First' }).click();
  await finishInPlaceCommand(page, 'Subtract');

  // Left stays beside the 1000 − 250 result; Right is consumed.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  const subtract = page
    .locator('.feature-row-main', { hasText: 'Subtract' })
    .last();
  // U09 phase 7: the row re-arms the Subtract in place, its choice in
  // Options; the row's Measurements read out the result.
  await expectFeatureMeasurement(
    page,
    page.locator('.feature-row', { has: subtract }),
    '750'
  );
  await subtract.click();
  const editBar = page.getByRole('group', { name: 'Edit Subtract command' });
  await editBar.locator('summary').click();
  await expect(editBar.getByRole('radio', { name: 'First' })).toHaveAttribute(
    'aria-checked',
    'true'
  );

  // Back to consuming both: only the result is left on screen.
  await editBar.getByRole('radio', { name: 'None' }).click();
  await editBar.locator('summary').click();
  await finishInPlaceCommand(page, 'Edit Subtract');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
});

test('switches an extrude to Intersect with the block it crosses', async ({
  page
}) => {
  test.setTimeout(120_000);
  let document = createProjectDocument(
    'Column intersect',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 10 }
  });
  const sketched = addSketchFeature(document, {
    name: 'Column sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset: -5 },
    objects: [
      {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 10,
        centerY: 10
      }
    ]
  });
  document = extrudeSketch(sketched.document, {
    name: 'Column',
    sketchId: sketched.sketchId,
    distance: 20
  }).document;
  await openSeeded(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });

  const column = page
    .locator('.feature-row-main', { hasText: 'Column' })
    .last();
  const columnRow = page.locator('.feature-row:not(.is-sketch)', {
    has: column
  });
  // 10 × 10 × 20 as a new body.
  await expectFeatureMeasurement(page, columnRow, '2000');
  let edit = await editExtrudeFromHistory(page, column);
  await chooseBarOption(edit, 'Operation', 'Intersect');
  await chooseBarOption(edit, 'Target body', 'Block Body');
  await edit.getByRole('button', { name: 'Done' }).click();
  await expect(edit).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  // Only the shared 10 × 10 × 10 column is left, and the block is consumed.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await expectFeatureMeasurement(page, columnRow, '1000');
  edit = await editExtrudeFromHistory(page, column);
  await expect(barChoice(edit, 'Operation', 'Intersect')).toHaveAttribute(
    'aria-checked',
    'true'
  );
});

test('U and X switch an edited boolean whose sources it consumed', async ({
  page
}) => {
  test.setTimeout(120_000);
  let document = createProjectDocument(
    'Switched boolean',
    toUserId('user_e2e')
  );
  for (const name of ['Left', 'Right']) {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
  }
  document = transformBody(document, {
    name: 'Offset Right',
    targetBodyId: document.bodyOrder[1]!,
    translation: { x: 5, y: 5, z: 0 }
  }).document;
  await openSeeded(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  await pressTool(page, /^Subtract \(X\)/);
  await pickObjectsBody(page, 'Left');
  await pickObjectsBody(page, 'Right');
  await finishInPlaceCommand(page, 'Subtract');
  // Keep None: one result body is left, so the rail counts one body.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  const row = page.locator('.feature-row-main', { hasText: 'Subtract' }).last();
  const featureRow = page.locator('.feature-row', { has: row });
  await expectFeatureMeasurement(page, featureRow, '750');

  // U over the edit switches its operation, as Options → Union does
  // (#1654). The bar keeps the feature's own name.
  const editBar = page.getByRole('group', { name: 'Edit Subtract command' });
  await row.click();
  await expect(editBar).toBeVisible();
  await page.keyboard.press('u');
  await expect(barChoice(editBar, 'Operation', 'Union')).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(page.getByRole('contentinfo')).not.toContainText(
    'Needs at least two bodies'
  );
  await finishInPlaceCommand(page, 'Edit Subtract');
  await expectFeatureMeasurement(page, featureRow, '1750');

  // And X switches it back.
  await row.click();
  await expect(editBar).toBeVisible();
  await page.keyboard.press('x');
  await expect(barChoice(editBar, 'Operation', 'Subtract')).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await finishInPlaceCommand(page, 'Edit Subtract');
  await expectFeatureMeasurement(page, featureRow, '750');

  // The command palette offers the same switch rather than refusing it
  // for the one result body on screen.
  await row.click();
  await expect(editBar).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page
    .getByRole('combobox', { name: 'Search commands', exact: true })
    .fill('intersect');
  const option = page.getByRole('option', { name: /^Intersect/ }).first();
  await expect(option).not.toContainText('Needs at least two bodies');
  await page.keyboard.press('Enter');
  await expect(barChoice(editBar, 'Operation', 'Intersect')).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await finishInPlaceCommand(page, 'Edit Subtract');
  await expectFeatureMeasurement(page, featureRow, '250');
});
