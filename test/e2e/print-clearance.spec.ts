import { createProjectDocument, gearBody } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createProject,
  enableFullRender,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';

test(
  'sets the document print clearance from Parameters, undoes it and keeps it through reload',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const { document } = gearBody(
      createProjectDocument('Printed gear', toUserId('user_e2e')),
      {
        name: 'Gear',
        gearType: 'external',
        sizing: 'module',
        pitch: 2,
        teeth: 20,
        faceWidth: 5,
        origin: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 0, z: 1 }
      }
    );
    await enableFullRender(page);
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
    await expect(
      page.getByRole('region', { name: '3D viewport' })
    ).toBeVisible();

    const input = page.getByLabel('Print clearance', { exact: true });
    await expect(input).toHaveValue('');
    await expect(page.getByText(/Radial gap for printed fits/)).toBeVisible();

    // An angle is refused, and what was typed stays to be corrected.
    await input.fill('5 deg');
    await input.press('Enter');
    await expect(page.locator('.parameter-feedback.error')).toContainText(
      'Not changed.'
    );
    await expect(input).toHaveValue('5 deg');

    await input.fill('0.15 mm');
    await input.press('Enter');
    await expect(
      page.getByText('0.15 mm radial gap for threads and gears', {
        exact: false
      })
    ).toBeVisible();
    await expect(page.locator('.parameter-feedback.error')).toHaveCount(0);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(input).toHaveValue('');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(input).toHaveValue('0.15 mm');

    await page.reload();
    await expect(
      page.getByLabel('Print clearance', { exact: true })
    ).toHaveValue('0.15 mm');

    await page.getByRole('button', { name: 'Clear print clearance' }).click();
    await expect(
      page.getByLabel('Print clearance', { exact: true })
    ).toHaveValue('');
    expect(errors).toEqual([]);
  }
);
