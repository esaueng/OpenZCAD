import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 }
]) {
  test(`Objects lists and filters bodies and sketches at ${viewport.width}px`, async ({
    page
  }, testInfo) => {
    const profile = addSketchFeature(
      createProjectDocument('Objects browser', toUserId('user_e2e')),
      {
        name: 'Plate outline',
        plane: 'XY',
        object: {
          objectKind: 'rectangle',
          width: 60,
          height: 40,
          centerX: 0,
          centerY: 0
        }
      }
    );
    const plate = extrudeSketch(profile.document, {
      name: 'Plate',
      sketchId: profile.sketchId,
      distance: 8
    });
    const { document } = addSketchFeature(plate.document, {
      name: 'Hole layout',
      plane: 'XY',
      offset: 8,
      object: { objectKind: 'circle', radius: 5, centerX: 15, centerY: 0 }
    });
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
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
    await page.setViewportSize({ width: 1440, height: 1000 });
    await createProject(page, document.name);
    await expect(page).toHaveTitle(/OpenZCAD/);
    await expect(
      page.getByRole('button', { name: 'Objects 3', exact: true })
    ).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    const objects = page.getByRole('list', { name: 'Objects' });
    await expect(objects.getByRole('listitem')).toHaveCount(3);
    const filter = page.getByRole('combobox', {
      name: 'Filter objects by type'
    });
    await filter.selectOption('sketches');
    await expect(objects.getByRole('listitem')).toHaveCount(2);
    await expect(
      objects.getByRole('button', { name: 'Plate outline', exact: true })
    ).toBeVisible();
    await expect(
      objects.getByRole('button', { name: 'Hole layout', exact: true })
    ).toBeVisible();
    // Extruding consumes the profile's default visibility, not its browser row.
    await objects
      .getByRole('button', { name: 'Show sketch Plate outline' })
      .click();
    await expect(
      objects.getByRole('button', { name: 'Hide sketch Plate outline' })
    ).toBeAttached();
    await objects
      .getByRole('button', { name: 'Plate outline', exact: true })
      .click();
    await expect(
      objects.getByRole('button', { name: 'Plate outline', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await objects
      .getByRole('button', { name: 'Hide sketch Plate outline' })
      .click();
    await expect(
      objects.getByRole('button', { name: 'Show sketch Plate outline' })
    ).toBeVisible();
    await filter.selectOption('bodies');
    await expect(objects.getByRole('listitem')).toHaveCount(1);
    await objects.getByRole('button', { name: /^Plate/, exact: true }).click();
    await expect(
      objects.getByRole('button', { name: /^Plate/, exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await filter.selectOption('all');
    await expect(
      objects.getByRole('button', { name: 'Plate outline', exact: true })
    ).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');
    await page.setViewportSize(viewport);
    await expect(objects.getByRole('listitem')).toHaveCount(3);
    const box = await filter.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: testInfo.outputPath('objects.png') });
    await filter.selectOption('sketches');
    await expect(objects.getByRole('listitem')).toHaveCount(2);
    await filter.selectOption('all');
    // The stored section key still opens the renamed section after reload.
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Objects 3', exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Filter objects by type' })
    ).toHaveValue('all');
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}
