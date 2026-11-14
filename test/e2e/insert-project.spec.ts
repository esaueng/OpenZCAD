import {
  addPrimitiveFeature,
  createProjectDocument,
  listNodesByKind,
  setNodeMetadata
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

// Insert project…: another project's bodies come into the open one — names,
// chosen colours and a folder named after it — as one undoable step, and the
// open project stays open. Import project… still opens a separate copy.
test(
  "inserts another project's bodies into the open project as one undo step",
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    let source = createProjectDocument('Gearbox', toUserId('local'));
    source = addPrimitiveFeature(source, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 4, depth: 30 }
    });
    source = addPrimitiveFeature(source, {
      name: 'Shaft',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 25 }
    });
    const plate = listNodesByKind(source, 'body')[0]!;
    source = setNodeMetadata(source, {
      nodeId: plate.id,
      metadata: { color: '#e5534b', colorChosen: true }
    });

    await page.goto('/');
    await page.getByLabel('Project name').fill('Target');
    await page.getByRole('button', { name: 'New project' }).click();
    const projectName = page.getByRole('button', { name: 'Rename project' });
    await expect(projectName).toContainText('Target');
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);

    await page
      .getByLabel('Insert a project backup into this project')
      .setInputFiles({
        name: 'gearbox.openzcad',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            format: 'openzcad-project',
            version: 1,
            document: source,
            files: []
          })
        )
      });

    const rows = page.locator('.body-row');
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await expect(rows.nth(0)).toContainText('Plate Body');
    await expect(rows.nth(1)).toContainText('Shaft Body');
    await expect(
      page.getByText('Gearbox', { exact: true }).first()
    ).toBeVisible();
    // Still the project that was open, not a copy of the other one.
    await expect(projectName).toContainText('Target');

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(rows).toHaveCount(0);
    expect(errors).toEqual([]);
  }
);
