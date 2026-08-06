import { test, expect, type Page } from '@playwright/test';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

async function stubApi(page: Page) {
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: { status: 'ok', environment: 'beta', time: new Date().toISOString() }
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

async function createBoxProject(page: Page, name: string) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
}

async function findFacePoint(page: Page) {
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
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
        return candidate;
      }
    }
  }
  throw new Error('no selectable face found');
}

test('lists bodies in the model browser and selects them from the tree', async ({
  page
}) => {
  await createBoxProject(page, 'Bodies Tree Part');

  const bodies = page.getByRole('list', { name: 'Bodies' });
  await expect(bodies.getByRole('button', { name: /^Box/ })).toBeVisible();

  await bodies.getByRole('button', { name: /^Box/ }).click();
  const chip = page.locator('.selection-chip');
  await expect(chip).toContainText('Box');
  await expect(
    bodies.getByRole('button', { name: /^Box/ })
  ).toHaveAttribute('aria-pressed', 'true');

  // The visibility eye hides the body and the history eye restores it.
  await bodies.getByRole('button', { name: 'Hide body Box' }).click();
  await expect(page.locator('.body-row.hidden-body')).toHaveCount(1);
  await bodies.getByRole('button', { name: 'Show body Box' }).click();
  await expect(page.locator('.body-row.hidden-body')).toHaveCount(0);
});

test('names picked faces and edges without raw fingerprints', async ({
  page
}) => {
  await createBoxProject(page, 'Friendly Labels Part');

  const facePoint = await findFacePoint(page);
  await page.mouse.click(facePoint.x, facePoint.y);
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toBeVisible();

  const chip = page.locator('.selection-chip');
  await expect(chip).toContainText('Box');
  await expect(chip).not.toContainText('face:');
  await expect(chip).toContainText(/face/i);

  // The operation card announces its lifecycle state explicitly.
  const card = page.getByRole('region', { name: 'Offset Face operation' });
  await expect(card.locator('.tool-card-phase')).toHaveText('Ready');

  // Dragging switches the phase pill.
  await page.mouse.down();
  await page.mouse.move(facePoint.x + 30, facePoint.y - 20, { steps: 3 });
  await expect(card.locator('.tool-card-phase')).toHaveText('Dragging');
  await page.mouse.up();
  await page.waitForTimeout(1200);
});

test('keeps a chained line anchored across committed sketch entities', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Continuous Line Chain');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('region', { name: 'Editing Sketch: New Sketch operation' })
  ).toBeVisible();
  // Screen-space clicks must wait until the head-on entry tween settles.
  await page.waitForTimeout(800);

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const center = {
    x: bounds!.x + bounds!.width / 2,
    y: bounds!.y + bounds!.height / 2
  };
  const corners = [
    { x: center.x - 80, y: center.y - 60 },
    { x: center.x + 80, y: center.y - 60 },
    { x: center.x + 80, y: center.y + 60 },
    { x: center.x - 80, y: center.y + 60 },
    { x: center.x - 80, y: center.y - 60 }
  ];
  for (const corner of corners) {
    await page.mouse.click(corner.x, corner.y);
  }

  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await expect(
    page.getByRole('form', { name: 'Extrude controls' })
  ).toContainText('1 bounded cell', { timeout: 20_000 });
});

test('clears every transient sketch HUD overlay when finishing a sketch', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Sketch HUD Cleanup');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('region', { name: 'Editing Sketch: New Sketch operation' })
  ).toBeVisible();
  await page.waitForTimeout(800);

  const gridSnap = page.getByRole('checkbox', { name: 'Snap to grid' });
  if (await gridSnap.isChecked()) {
    await gridSnap.uncheck();
  }
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const start = {
    x: bounds!.x + bounds!.width / 2 + 100,
    y: bounds!.y + bounds!.height / 2 + 100
  };

  await page.mouse.click(start.x, start.y);
  await page.mouse.move(start.x + 2, start.y - 200);
  const marker = page.locator('.sketch-snap-marker');
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAttribute('data-kind', 'vertical');
  await expect(marker).toHaveAttribute('data-label', 'Vertical');

  await page.getByRole('button', { name: 'Finish Sketch' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toHaveCount(0);
  await expect(marker).toBeHidden();
  await expect(page.locator('.sketch-dim-label')).toBeHidden();
  await expect(page.locator('.sketch-center-target')).toBeHidden();
});

test('snaps sketch drawing to existing endpoints', async ({ page }) => {
  await createBoxProject(page, 'Snap Sketch Part');

  const facePoint = await findFacePoint(page);
  await page.mouse.click(facePoint.x, facePoint.y);
  const card = page.getByRole('region', { name: 'Offset Face operation' });
  await card.getByRole('tab', { name: 'Sketch' }).click();
  await expect(
    page.getByRole('region', { name: 'Sketch operation' })
  ).toBeVisible();

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const center = {
    x: bounds!.x + bounds!.width / 2,
    y: bounds!.y + bounds!.height / 2
  };

  // Draw the first line.
  await page.mouse.click(center.x - 60, center.y - 40);
  await page.mouse.click(center.x + 60, center.y - 40);
  await page.keyboard.press('Escape');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Sketch' })
  ).toBeVisible();

  // Hovering near the first endpoint arms the endpoint snap marker.
  const marker = page.locator('.sketch-snap-marker');
  await expect(marker).toBeHidden();
  await page.mouse.move(center.x - 62, center.y - 42);
  await page.mouse.move(center.x - 59, center.y - 39, { steps: 3 });
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAttribute('data-kind', 'endpoint');

  // Clicking there chains exactly onto the endpoint; moving away hides it.
  await page.mouse.click(center.x - 60, center.y - 40);
  await page.mouse.move(center.x + 150, center.y + 120, { steps: 4 });
  await expect(marker).toBeHidden();
});
