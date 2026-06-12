import { test, expect, type Page } from '@playwright/test';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

/**
 * The preview server hosts the static SPA without the Worker API, so the
 * handful of API routes the app touches are stubbed here. Everything else —
 * commands, the geometry worker, the viewport, STEP writing — is the real
 * production bundle.
 */
async function stubApi(page: Page) {
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: { status: 'ok', environment: 'beta', time: new Date().toISOString() }
    })
  );
  await page.route('**/api/projects', (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { name: string; units?: string };
      const document = createProjectDocument(
        payload.name,
        toUserId('user_e2e'),
        (payload.units as 'mm' | undefined) ?? 'mm'
      );
      return route.fulfill({
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
      });
    }
    return route.fulfill({ json: { projects: [] } });
  });
  await page.route('**/api/projects/*/revisions', (route) => {
    const payload = route.request().postDataJSON() as { document: unknown };
    return route.fulfill({ json: payload.document });
  });
  await page.route('**/api/exports', (route) => route.fulfill({ status: 404, json: { error: 'stub' } }));
  await page.route('**/api/uploads', (route) => route.fulfill({ status: 404, json: { error: 'stub' } }));
}

test('loads the OpenZCAD shell', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.getByText('OpenZCAD')).toBeVisible();
  await expect(page.getByText('parametric cad in the browser')).toBeVisible();
});

test('models a parametric part and exports a true STEP file', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');

  // Create a project.
  await page.getByLabel('Project name').fill('E2E Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.inspector')).toContainText('Tools');

  // Define a parameter the box will use.
  await page.getByLabel('New parameter name').fill('w');
  await page.getByLabel('New parameter expression').fill('30');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.locator('.param-row')).toContainText('w');

  // Box driven by the parameter: 60 x 18 x 24 = 25920.
  await page.locator('.tool-button', { hasText: 'Box' }).click();
  await page.getByLabel('Width (X)').fill('w * 2');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.feature-row-main', { hasText: 'Box' })).toBeVisible();

  // The kernel worker rebuilds and reports real measurements.
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await expect(page.locator('.panel-body')).toContainText('volume', { ignoreCase: true });
  await expect(page.locator('.panel-body')).toContainText('25920');
  await page.keyboard.press('Escape'); // back to the tool launcher

  // Second body and a subtract that consumes both inputs.
  await page.locator('.tool-button', { hasText: 'Cylinder' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.feature-row-main', { hasText: 'Cylinder' })).toBeVisible();

  await page.locator('.tool-button', { hasText: 'Subtract' }).click();
  await page.locator('.pick-row', { hasText: 'Box Body' }).click();
  await page.locator('.pick-row', { hasText: 'Cylinder Body' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.feature-row', { hasText: 'Subtract' })).toBeVisible();
  await expect(page.locator('.feature-row.consumed')).toHaveCount(2);

  // Export STEP and verify the download is a real ISO 10303-21 file.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'STEP' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('E2E-Part.step');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text.startsWith('ISO-10303-21;')).toBe(true);
  expect(text).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN");
  expect(text).toContain('MANIFOLD_SOLID_BREP');
  expect(text).toContain('CLOSED_SHELL');
  expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);

  // Parametric regen: change w and confirm the box volume follows (60->80 => 80*18*24).
  const paramInput = page.getByLabel('Expression for w');
  await paramInput.fill('40');
  await paramInput.press('Enter');
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await expect(page.locator('.panel-body')).toContainText('34560');
});
