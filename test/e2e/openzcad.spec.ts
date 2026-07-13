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
      json: {
        status: 'ok',
        environment: 'beta',
        time: new Date().toISOString()
      }
    })
  );
  await page.route('**/api/projects', (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as {
        name: string;
        units?: string;
      };
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
  await page.route('**/api/exports', (route) =>
    route.fulfill({ status: 404, json: { error: 'stub' } })
  );
  await page.route('**/api/uploads', (route) =>
    route.fulfill({ status: 404, json: { error: 'stub' } })
  );
}

test('loads the OpenZCAD shell', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.getByText('OpenZCAD')).toBeVisible();
  await expect(page.getByText('parametric cad in the browser')).toBeVisible();
});

test('resizes a literal box by dragging an exact face', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Direct Edit Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  let facePoint: { x: number; y: number } | null = null;
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: bounds!.x + bounds!.width * xRatio,
        y: bounds!.y + bounds!.height * yRatio
      };
      await page.mouse.move(candidate.x, candidate.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) === 'grab'
      ) {
        facePoint = candidate;
        break;
      }
    }
    if (facePoint) {
      break;
    }
  }
  expect(facePoint).not.toBeNull();
  await page.mouse.down();
  await page.mouse.move(facePoint!.x + 72, facePoint!.y - 54, { steps: 6 });
  await page.mouse.up();

  await expect(page.getByRole('contentinfo')).toContainText('Resize Box');
  const dimensions = await Promise.all([
    page.getByLabel('Width (X)').inputValue(),
    page.getByLabel('Height (Y)').inputValue(),
    page.getByLabel('Depth (Z)').inputValue()
  ]);
  expect(dimensions).not.toEqual(['40', '18', '24']);
});

test('fillets all twelve edges of a box in one exact feature', async ({
  page
}) => {
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('All-edge Fillet');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  await page.getByRole('button', { name: /^Fillet/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByRole('button', { name: 'Select all 12 edges' }).click();
  await expect(inspector.locator('.selection-summary')).toContainText(
    '12 exact edges selected'
  );
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const fillet = page.locator('.feature-row', { hasText: 'Fillet' });
  await expect(fillet).toBeVisible();
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await fillet.locator('.feature-row-main').click();
  await expect(page.locator('.panel-body')).toContainText('volume', {
    ignoreCase: true
  });
  await expect(page.locator('.panel-body')).toContainText('faces');
  expect(consoleErrors).toEqual([]);
});

test('models a parametric part and exports a true STEP file', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');

  // Create a project.
  await page.getByLabel('Project name').fill('E2E Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();

  // Define a parameter the box will use.
  await page.getByLabel('New parameter name').fill('w');
  await page.getByLabel('New parameter expression').fill('30');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.locator('.param-row')).toContainText('w');

  // Box driven by the parameter: 60 x 18 x 24 = 25920.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page.getByLabel('Width (X)').fill('w * 2');
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  // The kernel worker rebuilds and reports real measurements.
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await expect(page.locator('.panel-body')).toContainText('volume', {
    ignoreCase: true
  });
  await expect(page.locator('.panel-body')).toContainText('25920');

  // Tool-first finishing stays active while the user chooses an exact edge.
  const filletTool = page.getByRole('button', { name: /^Fillet/ });
  await expect(filletTool).toBeEnabled();
  await filletTool.click();
  await expect(page.locator('.selection-summary')).toContainText(
    'Select edges in the viewport or select every edge below.'
  );
  await page.keyboard.press('Escape'); // back to the tool launcher

  // Second body and a subtract that consumes both inputs.
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Cylinder' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Subtract \(X\)/ }).click();
  await page.locator('.pick-row', { hasText: 'Box Body' }).click();
  await page.locator('.pick-row', { hasText: 'Cylinder Body' }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row', { hasText: 'Subtract' })
  ).toBeVisible();
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
