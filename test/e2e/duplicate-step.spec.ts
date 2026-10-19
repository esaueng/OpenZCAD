import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * U06 (ZC-104): a history row's menu duplicates a Move, Mirror or Pattern
 * step right after itself, opens the copy for review, and one Undo removes
 * it. Other kinds show the item disabled with the reason.
 */
test('duplicates a Move step from its history menu', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApi(page);
  let document = createProjectDocument('Duplicate step', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  document = transformBody(document, {
    name: 'Move',
    targetBodyId: document.bodyOrder[0] as BodyId,
    translation: { x: 10, y: 0, z: 0 }
  }).document;
  document = addPrimitiveFeature(document, {
    name: 'Later',
    primitiveKind: 'box',
    dimensions: { width: 2, height: 2, depth: 2 }
  });
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
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
  const names = page.locator('.feature-row .feature-name');
  await expect(names).toHaveText(['Block', 'Move', 'Later'], {
    timeout: 30_000
  });
  const menu = page.getByRole('menu');

  // A primitive is not a repeatable step: the item says why.
  await page
    .locator('.feature-row', { hasText: 'Block' })
    .click({ button: 'right' });
  const refused = menu.getByRole('menuitem', { name: /^Duplicate/ });
  await expect(refused).toBeDisabled();
  await expect(refused).toContainText('Move, Mirror and Pattern steps only');
  await page.keyboard.press('Escape');

  await page
    .locator('.feature-row', { hasText: 'Move' })
    .click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(names).toHaveText(['Block', 'Move', 'Move 2', 'Later'], {
    timeout: 30_000
  });
  // The copy opens for review.
  await expect(page.locator('.feature-row', { hasText: 'Move 2' })).toHaveClass(
    /selected/
  );

  // One undo, from the toast that announced the copy, takes it away.
  await page.locator('.toast-action', { hasText: 'Undo' }).click();
  await expect(names).toHaveText(['Block', 'Move', 'Later']);
});
