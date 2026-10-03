import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * A sketch an extrude consumed is hidden, and the Move of it used to look the
 * sketch up among the *visible* sketch views: the hidden one was not there,
 * so Apply dropped the Move without a word — no change, no history entry, the
 * extrude where it was, and a Move tool card left open with nothing in it.
 * Moving the sketch shows it for the length of the Move, and Apply moves it
 * and the extrude it drives.
 */

async function openPlate(page: Page, projectName: string) {
  const sketch = addSketchFeature(
    createProjectDocument(projectName, toUserId('user_e2e')),
    {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      objects: [
        {
          objectKind: 'rectangle',
          width: 180,
          height: 60,
          centerX: 0,
          centerY: 0
        }
      ]
    }
  );
  const plate = extrudeSketch(sketch.document, {
    name: 'Plate',
    sketchId: sketch.sketchId,
    distance: 60
  });
  const document = plate.document;
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled({
    timeout: 30_000
  });
  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(700);
  // The extrude consumed the sketch, so the sketch starts hidden.
  await expect(
    page.getByRole('button', { name: 'Show Profile' })
  ).toBeVisible();
  return document.projectId;
}

/** The saved rectangle's centre, read back from the stored document. */
function readProfileCenterX(page: Page, projectId: string) {
  return page.evaluate(
    (id) =>
      new Promise<number | null>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () => reject(new Error('Could not open IndexedDB.'));
        open.onsuccess = () => {
          const db = open.result;
          const read = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .get(id);
          read.onerror = () => {
            db.close();
            reject(new Error('Could not read the saved project.'));
          };
          read.onsuccess = () => {
            db.close();
            const nodes = (
              read.result as
                | { nodes?: Record<string, { kind: string; data: unknown }> }
                | undefined
            )?.nodes;
            const rectangle = Object.values(nodes ?? {}).find(
              (node) => node.kind === 'sketch-object'
            );
            const centerX = (rectangle?.data as { centerX?: unknown })?.centerX;
            resolve(typeof centerX === 'number' ? centerX : null);
          };
        };
      }),
    projectId
  );
}

/** Where the Move gizmo sits on screen once Move opens on the Plate body. */
async function plateGizmoX(page: Page): Promise<number> {
  const canvas = page.locator('.viewer-host canvas');
  const move = page.getByRole('form', { name: 'Move controls' });
  await page.locator('.feature-row-main', { hasText: /^Plate$/ }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await expect(move).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('Move/Rotate');
  await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /\d/);
  const x = Number(await canvas.getAttribute('data-e2e-move-gizmo-x'));
  await move.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(move).toHaveCount(0);
  return x;
}

test('Move applies to a sketch its extrude has hidden, from the card', async ({
  page
}) => {
  test.setTimeout(150_000);
  const projectId = await openPlate(page, 'Hidden Sketch Move');
  const canvas = page.locator('.viewer-host canvas');
  const move = page.getByRole('form', { name: 'Move controls' });
  const status = page.getByRole('contentinfo');
  const before = await plateGizmoX(page);
  expect(await readProfileCenterX(page, projectId)).toBe(0);

  await page.locator('.feature-row-main', { hasText: /^Profile$/ }).click();
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await expect(move).toBeVisible();
  await expect(status).toContainText('Move sketch');
  // The sketch being moved shows for the Move, so it takes the gizmo.
  await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /\d/);
  await move.getByLabel('Move X in mm').fill('20');
  await move.getByRole('button', { name: /Apply move/ }).click();

  await expect(move).toHaveCount(0);
  await expect(status).toContainText('Moved Profile');
  // No stray Move card: the command closed with the Apply.
  await expect(page.getByRole('form', { name: 'Move controls' })).toHaveCount(
    0
  );
  await expect
    .poll(() => readProfileCenterX(page, projectId), { timeout: 15_000 })
    .toBe(20);
  // The extrude rebuilt from the moved sketch, so the body moved with it.
  await expect
    .poll(async () => Math.abs((await plateGizmoX(page)) - before), {
      timeout: 15_000
    })
    .toBeGreaterThan(5);
  // And once the Move is over the consumed sketch is hidden again.
  await expect(
    page.getByRole('button', { name: 'Show Profile' })
  ).toBeVisible();
});

test('Move applies to a hidden sketch from the unapplied-Move dialog', async ({
  page
}) => {
  test.setTimeout(150_000);
  const projectId = await openPlate(page, 'Hidden Sketch Move Ask');
  const move = page.getByRole('form', { name: 'Move controls' });
  const ask = page.getByRole('alertdialog', { name: 'Apply the Move first?' });
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  const status = page.getByRole('contentinfo');

  await page.locator('.feature-row-main', { hasText: /^Profile$/ }).click();
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await expect(status).toContainText('Move sketch');
  await move.getByLabel('Move X in mm').fill('20');
  await page.locator('.feature-row-main', { hasText: /^Plate$/ }).click();
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('before Plate opens');
  await ask.getByRole('button', { name: 'Apply' }).click();

  await expect(ask).toHaveCount(0);
  await expect(move).toHaveCount(0);
  await expect(inspector.getByRole('heading', { name: 'Plate' })).toBeVisible();
  await expect
    .poll(() => readProfileCenterX(page, projectId), { timeout: 15_000 })
    .toBe(20);
});
