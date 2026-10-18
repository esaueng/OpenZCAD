import {
  addDatumPlane,
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Locator } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * R01: a datum plane is a viewport object. Selecting it arms the same pin a
 * face offset uses; dragging that pin moves the plane by one validated edit,
 * and clicking the plane where nothing in the model is under the pointer
 * selects it again.
 */

interface DrawnDatum {
  featureId: string;
  origin: { x: number; y: number; z: number };
}

async function drawnDatums(canvas: Locator): Promise<DrawnDatum[]> {
  const raw = await canvas.getAttribute('data-e2e-datum-planes');
  return raw ? (JSON.parse(raw) as DrawnDatum[]) : [];
}

test('drags a selected datum plane along its normal and picks it in the viewport', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  let document = createProjectDocument('Datum handle', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 10 }
  });
  document = addDatumPlane(document, {
    name: 'Lid plane',
    definition: {
      kind: 'offset',
      source: { type: 'canonical', plane: 'XY', offset: 0 },
      offset: 15
    }
  }).document;
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
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(async () => (await drawnDatums(canvas))[0]?.origin.z, {
      timeout: 30_000
    })
    .toBeCloseTo(15, 6);

  // Selecting the plane arms its pin.
  await page.locator('.feature-row-main', { hasText: 'Lid plane' }).click();
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /\d/, {
    timeout: 30_000
  });
  // The pin's value chip opens exact entry: the card's Offset field.
  await page.getByTestId('direct-manipulation-value').click();
  await expect(page.getByLabel('Offset', { exact: true })).toBeFocused();
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /\d/);
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + handle.x, bounds.y + handle.y);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + handle.x + handle.dx * handle.pixelsPerUnit * 5,
    bounds.y + handle.y + handle.dy * handle.pixelsPerUnit * 5,
    { steps: 6 }
  );
  // The plane follows the pin while the drag is still under way.
  await expect
    .poll(async () => (await drawnDatums(canvas))[0]?.origin.z)
    .toBeGreaterThan(17);
  await page.mouse.up();
  // The drag fills the open Plane card's Offset; Apply commits it.
  const offset = page.getByLabel('Offset', { exact: true });
  await expect
    .poll(async () => Number(await offset.inputValue()))
    .toBeGreaterThan(18);
  const first = Number(await offset.inputValue());
  // A second gesture adds only its own distance, not the pin's running
  // total: dragging back 2 lands near first − 2.
  // Each release rebuilds the pin at zero; read it once it has settled.
  const pinAt = () =>
    canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY)
    }));
  let again = await pinAt();
  await expect
    .poll(async () => {
      await page.waitForTimeout(150);
      const next = await pinAt();
      const settled = next.x === again.x && next.y === again.y;
      again = next;
      return settled && Number.isFinite(next.x);
    })
    .toBe(true);
  await page.mouse.move(bounds.x + again.x, bounds.y + again.y);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + again.x - handle.dx * handle.pixelsPerUnit * 2,
    bounds.y + again.y - handle.dy * handle.pixelsPerUnit * 2,
    { steps: 4 }
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await offset.inputValue()))
    .toBeLessThan(first - 1);
  const dragged = Number(await offset.inputValue());
  // Back about 2 from the first drag, not first + (first − 15) − 2.
  expect(dragged).toBeGreaterThan(first - 3);
  // Released, the plane stays where the card's Offset says, ahead of Apply,
  // and a typed Offset moves it too.
  await expect
    .poll(async () => (await drawnDatums(canvas))[0]?.origin.z)
    .toBeCloseTo(dragged, 6);
  await offset.fill('25');
  await expect
    .poll(async () => (await drawnDatums(canvas))[0]?.origin.z)
    .toBeCloseTo(25, 6);
  // A draft that changes more than the distance disarms the pin and shows
  // the built plane: a Midplane, or an Offset that is an expression.
  await page.getByRole('button', { name: 'Midplane', exact: true }).click();
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /\d/);
  await expect
    .poll(async () => (await drawnDatums(canvas))[0]?.origin.z)
    .toBeCloseTo(15, 6);
  await page.getByRole('button', { name: 'Offset plane', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /\d/);
  await offset.fill('lid + 1');
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /\d/);
  await offset.fill(String(dragged));
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /\d/);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect
    .poll(async () => (await drawnDatums(canvas))[0]?.origin.z, {
      timeout: 30_000
    })
    .toBeCloseTo(dragged, 6);
  const moved = dragged;

  // Reselect to learn where the moved plane's pin now stands, clear the
  // selection, then click there, clear of the block: the plane is selected
  // again and its pin re-arms.
  await page.locator('.feature-row-main', { hasText: 'Lid plane' }).click();
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /\d/, {
    timeout: 30_000
  });
  const pin = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY)
  }));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /\d/);
  await page.mouse.click(bounds.x + pin.x, bounds.y + pin.y);
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /\d/, {
    timeout: 30_000
  });
  await expect(
    page.locator('.feature-row', { hasText: 'Lid plane' })
  ).toHaveClass(/selected/);

  // While measuring owns viewport clicks, the plane under the pointer is
  // not selected.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /\d/);
  const measure = page
    .getByRole('button', { name: 'Measure', exact: true })
    .first();
  await measure.click();
  await page.mouse.click(bounds.x + pin.x, bounds.y + pin.y);
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /\d/);
  await expect(
    page.locator('.feature-row', { hasText: 'Lid plane' })
  ).not.toHaveClass(/selected/);
  await measure.click();
  await page.mouse.click(bounds.x + pin.x, bounds.y + pin.y);
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /\d/, {
    timeout: 30_000
  });

  // Starting a new plane from the Plane tool keeps the old selection but is
  // not editing it: its pin must not arm, or a drag would fill the new
  // plane's Offset.
  await page.getByRole('button', { name: /^Plane — / }).click();
  await expect(
    page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('heading', { name: 'Plane' })
  ).toBeVisible();
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /\d/);
  await page.keyboard.press('Escape');

  // One undo restores the plane's offset.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => (await drawnDatums(canvas))[0]?.origin.z, {
      timeout: 30_000
    })
    .toBeCloseTo(15, 6);
  expect(moved).toBeGreaterThan(15);
});
