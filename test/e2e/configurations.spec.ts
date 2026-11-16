import {
  addPrimitiveFeature,
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createProject,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * F06: a variant table under Parameters. Two rows over a parameter, a
 * feature's suppression and a body's visibility; switching rows rebuilds the
 * model in one undoable step that survives a reload.
 */
test(
  'builds a variant table, switches rows, undoes the switch and keeps it through reload',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    let document = createProjectDocument('Bracket', toUserId('user_e2e'));
    document = setParameter(document, { name: 'width', expression: '20' });
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 'width', height: 10, depth: 4 }
    });
    document = addPrimitiveFeature(document, {
      name: 'Lug',
      primitiveKind: 'box',
      dimensions: { width: 4, height: 4, depth: 4 }
    });
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
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await createProject(page, document.name);
    await expectBodyCount(page, 2, 30_000);

    await page.getByRole('button', { name: /Add configurations/ }).click();
    await expect(
      page.getByRole('radio', { name: 'Use Default' })
    ).toBeChecked();
    const addColumn = page.getByRole('combobox', { name: 'Add column' });
    await addColumn.selectOption({ label: 'Parameter: width' });
    await addColumn.selectOption({ label: 'Suppress: Lug' });
    await page
      .getByRole('button', { name: 'Add configuration', exact: true })
      .click();
    await expect(
      page.getByRole('radio', { name: 'Use Configuration 2' })
    ).not.toBeChecked();

    // Configuration 2: wider, without the lug.
    const widthCell = page.getByLabel('width, Configuration 2');
    await widthCell.fill('45');
    await widthCell.press('Enter');
    await page.getByLabel('Lug built, Configuration 2').uncheck();
    // Editing a row that is not active leaves the model alone.
    await expect(page.getByLabel('Expression for width')).toHaveValue('20');
    await expectBodyCount(page, 2);

    await page.getByRole('radio', { name: 'Use Configuration 2' }).check();
    await expect(page.getByLabel('Expression for width')).toHaveValue('45');
    await expectBodyCount(page, 1, 30_000);
    await expect(
      page.getByRole('radio', { name: 'Use Configuration 2' })
    ).toBeChecked();

    // The switch is one step.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByLabel('Expression for width')).toHaveValue('20');
    await expect(
      page.getByRole('radio', { name: 'Use Default' })
    ).toBeChecked();
    await expectBodyCount(page, 2, 30_000);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.getByLabel('Expression for width')).toHaveValue('45');
    await expectBodyCount(page, 1, 30_000);

    await page.reload();
    await expect(
      page.getByRole('radio', { name: 'Use Configuration 2' })
    ).toBeChecked();
    await expect(page.getByLabel('Expression for width')).toHaveValue('45');
    await expect(page.getByLabel('width, Default')).toHaveValue('20');
    await expectBodyCount(page, 1, 30_000);
    expect(errors).toEqual([]);
  }
);
