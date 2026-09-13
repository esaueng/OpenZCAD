import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

test('creates a body switch, toggles it in Tweak, and preserves it through undo and reopen', async ({
  page
}) => {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let document = createProjectDocument('Body toggle', toUserId('local'));
  document = addPrimitiveFeature(document, {
    name: 'Holder',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 30 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Text',
    primitiveKind: 'box',
    dimensions: { width: 0.4, height: 4, depth: 12 }
  });
  document = transformBody(document, {
    name: 'Text placement',
    targetBodyId: document.bodyOrder[1]!,
    translation: { x: 20, y: 3, z: 9 }
  }).document;
  await page.goto('/');
  await page.getByLabel('Project name').fill('Switch test');
  await page.getByRole('button', { name: 'Create project' }).click();
  // Wait for creation to finish before importing a different project. The
  // import guard intentionally preserves edits made during an in-flight load.
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Switch test');
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'toggle.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: []
      })
    )
  });
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Body toggle');
  await expect(page.locator('.body-row')).toHaveCount(2);
  await page.getByLabel('New parameter type').selectOption('toggle');
  await page.getByLabel('New parameter name').fill('show_text');
  await page.getByRole('checkbox', { name: 'Text Body', exact: true }).check();
  await page
    .getByRole('button', { name: 'Add parameter', exact: true })
    .click();
  const control = page.getByRole('switch', { name: 'Toggle show_text' });
  await expect(control).toBeChecked();
  await control.click();
  await expect(control).not.toBeChecked();
  await expect(page.locator('.body-row.hidden-body')).toHaveCount(1);
  await expect(page.locator('.body-row.hidden-body')).toContainText(
    'Text Body'
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(control).toBeChecked();
  await expect(page.locator('.body-row.hidden-body')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(control).not.toBeChecked();
  await page.getByRole('button', { name: 'Tweak', exact: true }).click();
  await expect(control).not.toBeChecked();
  await control.click();
  await expect(control).toBeChecked();
  await control.click();
  await expect(control).not.toBeChecked();
  await expect(page.locator('.save-state')).toHaveClass(/is-local/);
  await page.reload();
  await expect(
    page.getByRole('switch', { name: 'Toggle show_text' })
  ).not.toBeChecked();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
  expect(errors).toEqual([]);
});
