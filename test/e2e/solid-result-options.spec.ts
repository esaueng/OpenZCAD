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
  editExtrudeFromHistory
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
  await page.getByRole('button', { name: 'Create project' }).click();
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
  await page.getByRole('button', { name: /^Subtract \(X\)/ }).click();
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
  // Options; the pinned row still reads out the result.
  await subtract.click();
  await expect(page.locator('.panel-body')).toContainText('750', {
    timeout: 30_000
  });
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
  const panel = page.locator('.panel-body');
  let edit = await editExtrudeFromHistory(page, column);
  // 10 × 10 × 20 as a new body.
  await expect(panel).toContainText('2000', { timeout: 30_000 });
  await chooseBarOption(edit, 'Operation', 'Intersect');
  await chooseBarOption(edit, 'Target body', 'Block Body');
  await edit.getByRole('button', { name: 'Done' }).click();
  await expect(edit).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  // Only the shared 10 × 10 × 10 column is left, and the block is consumed.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  edit = await editExtrudeFromHistory(page, column);
  await expect(panel).toContainText('1000', { timeout: 30_000 });
  await expect(barChoice(edit, 'Operation', 'Intersect')).toHaveAttribute(
    'aria-checked',
    'true'
  );
});
