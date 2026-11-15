import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createProject,
  enableFullRender,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';
import { reimportSolids } from '../support/exchange-harness';

test(
  'Open in slicer downloads the 3MF in the browser and uploads nothing',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const document = addPrimitiveFeature(
      createProjectDocument('Slicer hand-off', toUserId('user_e2e')),
      {
        name: 'Block',
        bodyName: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 5 }
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
    await expect(page.locator('.body-row', { hasText: 'Block' })).toBeVisible();

    const fileMenu = page.locator('details.file-menu');
    await fileMenu.locator('summary').click();
    await fileMenu.getByRole('button', { name: /Export mesh/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Export mesh' });
    const handOff = dialog.getByRole('region', { name: 'Open in slicer' });
    await expect(handOff).toContainText('Nothing is uploaded.');

    // A hand-off is local: count every upload from here on.
    const uploads: string[] = [];
    page.on('request', (request) => {
      if (/\/api\/(uploads|artifacts)/.test(request.url()))
        uploads.push(request.url());
    });
    const pending = page.waitForEvent('download');
    await handOff.getByRole('button', { name: 'Download for slicer' }).click();
    const file = await pending;
    expect(file.suggestedFilename()).toMatch(/\.3mf$/);
    const chunks: Buffer[] = [];
    for await (const chunk of await file.createReadStream()) {
      chunks.push(chunk as Buffer);
    }
    await expect(
      page.getByText(/Open it from your browser’s downloads/)
    ).toBeVisible();

    const measure = await reimportSolids(
      '3mf',
      Uint8Array.from(Buffer.concat(chunks))
    );
    expect(measure.fileObjects).toBe(1);
    expect(measure.volume).toBeCloseTo(500, 2);
    expect(uploads).toEqual([]);
    expect(errors).toEqual([]);
  }
);
