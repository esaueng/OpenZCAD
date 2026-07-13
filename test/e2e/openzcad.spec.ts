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

async function createProject(page: Page, name: string) {
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.tool-palette')).toBeVisible();
}

test('loads the OpenZCAD shell', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.getByText('OpenZCAD')).toBeVisible();
  await expect(page.getByText('parametric cad in the browser')).toBeVisible();
});

test('empty project offers primary actions and the palette groups every tool', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await createProject(page, 'Empty State');

  // A new user can identify how to start a sketch from an empty project.
  const emptyState = page.locator('.viewer-empty-state');
  await expect(emptyState.getByRole('button', { name: /Create Sketch/ })).toBeVisible();
  await expect(emptyState.getByRole('button', { name: /Add Box/ })).toBeVisible();

  // The palette exposes grouped tools with shortcuts; on an empty project the
  // contextual group also surfaces Create Sketch, so two entries are expected.
  const palette = page.locator('.tool-palette');
  await expect(palette.getByRole('button', { name: /Create Sketch/ }).first()).toBeVisible();
  await expect(palette.getByRole('button', { name: /Extrude/ })).toBeDisabled();
  await expect(palette.getByRole('button', { name: /Union/ })).toBeDisabled();
});

test('sketch-to-extrude flows through the on-canvas HUD without any modal', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await createProject(page, 'HUD Part');

  // Start a sketch from the empty-state action; the HUD appears in-viewport.
  await page.locator('.viewer-empty-state').getByRole('button', { name: /Create Sketch/ }).click();
  const hud = page.locator('.command-hud');
  await expect(hud).toBeVisible();
  await expect(hud).toContainText('Sketch');

  // Size the rectangle and confirm with Enter (numeric input behavior).
  await hud.getByLabel('Width').fill('20');
  await hud.getByLabel('Height').fill('10');
  await hud.getByLabel('Width').press('Enter');
  await expect(hud).toBeHidden();
  await expect(page.locator('.feature-row-main', { hasText: 'Sketch' })).toBeVisible();

  // Extrude via keyboard shortcut; the last sketch is picked up automatically.
  await page.keyboard.press('e');
  await expect(hud).toBeVisible();
  await expect(hud).toContainText('Extrude');
  await hud.getByLabel('Distance').fill('12');
  await hud.getByRole('button', { name: /Confirm/ }).click();
  await expect(page.locator('.feature-row-main', { hasText: 'Extrude' })).toBeVisible();

  // The extrude produced real geometry: select it and read measurements.
  await page.locator('.feature-row-main', { hasText: 'Extrude' }).click();
  await expect(page.locator('.inspector .panel-body')).toContainText('2400'); // 20×10×12
});

test('escape cancels a session without touching the model', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await createProject(page, 'Cancel Part');

  await page.keyboard.press('b'); // arm Box
  await expect(page.locator('.command-hud')).toContainText('Box');
  await page.keyboard.press('Escape');
  await expect(page.locator('.command-hud')).toBeHidden();
  await expect(page.locator('.feature-row')).toHaveCount(0);
});

test('command search finds and runs commands and explains unavailable ones', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await createProject(page, 'Search Part');

  await page.keyboard.press('s');
  const search = page.locator('.command-search');
  await expect(search).toBeVisible();
  await search.getByLabel('Search commands').fill('extrude');
  // Extrude is listed but disabled with its reason (no sketch yet).
  await expect(search.locator('.search-result.disabled', { hasText: 'Extrude' })).toContainText(
    /sketch/i
  );
  await search.getByLabel('Search commands').fill('box');
  await page.keyboard.press('Enter');
  await expect(page.locator('.command-hud')).toContainText('Box');
  await page.keyboard.press('Escape');
});

test('models a parametric part and exports a true STEP file', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await createProject(page, 'E2E Part');

  // Define a parameter the box will use.
  await page.getByLabel('New parameter name').fill('w');
  await page.getByLabel('New parameter expression').fill('30');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.locator('.param-row')).toContainText('w');

  // Box driven by the parameter: 60 x 18 x 24 = 25920.
  await page.locator('.tool-palette').getByRole('button', { name: /^Box/ }).click();
  const hud = page.locator('.command-hud');
  await hud.getByLabel('Width').fill('w * 2');
  await hud.getByRole('button', { name: /Confirm/ }).click();
  await expect(page.locator('.feature-row-main', { hasText: 'Box' })).toBeVisible();

  // The kernel worker rebuilds and reports real measurements.
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await expect(page.locator('.inspector .panel-body')).toContainText('volume', {
    ignoreCase: true
  });
  await expect(page.locator('.inspector .panel-body')).toContainText('25920');
  await page.keyboard.press('Escape'); // clear the selection

  // Second body and a subtract that consumes both inputs.
  await page.locator('.tool-palette').getByRole('button', { name: /Cylinder/ }).click();
  await hud.getByRole('button', { name: /Confirm/ }).click();
  await expect(page.locator('.feature-row-main', { hasText: 'Cylinder' })).toBeVisible();

  // Boolean via multi-select in the tree, then the contextual palette group.
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await page
    .locator('.feature-row-main', { hasText: 'Cylinder' })
    .click({ modifiers: ['Shift'] });
  await page
    .locator('.palette-group.contextual')
    .getByRole('button', { name: /Subtract/ })
    .click();
  await expect(hud).toContainText('Subtract');
  await expect(hud.locator('.hud-pick')).toHaveCount(2);
  await hud.getByRole('button', { name: /Confirm/ }).click();
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
  await expect(page.locator('.inspector .panel-body')).toContainText('34560');
});

test('undo and redo restore the model around a HUD commit', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await createProject(page, 'Undo Part');

  await page.keyboard.press('b');
  await page.locator('.command-hud').getByRole('button', { name: /Confirm/ }).click();
  await expect(page.locator('.feature-row')).toHaveCount(1);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.feature-row')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('.feature-row')).toHaveCount(1);
});
