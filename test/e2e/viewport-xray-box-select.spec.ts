import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  expect,
  expectBodyCount,
  locateEdge,
  setSelectionFilter,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * Stage 5 viewport conventions (U07): X-ray with select-through, the
 * field-of-view setting, box selection of faces and edges under the
 * selection filter, and sketch visibility that survives a reload.
 */

async function createBox(page: Page, name: string) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  // Topology picks only mean something once the exact projection lands.
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled({
    timeout: 30_000
  });
}

async function topView(page: Page) {
  // The open tool fold floats over the canvas's left edge, where the sweeps
  // start; folded, only the rail is there.
  const fold = page.getByRole('button', { name: /^More tools/ });
  if ((await fold.getAttribute('aria-expanded')) === 'true') {
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
  }
  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Standard views' }).click();
  await page.getByRole('button', { name: 'Top view (2)' }).click();
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
}

const canvas = (page: Page) => page.locator('.viewer-host canvas');

/** The box's world extent and the client pixels of the given world points. */
function project(page: Page, points: [number, number, number][] = []) {
  return canvas(page).evaluate(
    (element, worldPoints) =>
      new Promise<{
        box: { min: number[]; max: number[] } | null;
        points: { x: number; y: number }[];
      }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: { resolve, points: worldPoints }
          })
        );
      }),
    points
  );
}

/**
 * Drags a rectangle between two world points on the box's top plane. The
 * press must land on bare canvas — a press on the box itself starts a face
 * drag — so it is checked rather than assumed.
 */
async function sweep(
  page: Page,
  from: [number, number, number],
  to: [number, number, number]
) {
  const { points } = await project(page, [from, to]);
  const [start, end] = points as [
    { x: number; y: number },
    { x: number; y: number }
  ];
  expect(
    await page.evaluate(
      (point) => document.elementFromPoint(point.x, point.y)?.tagName,
      start
    ),
    'the sweep should start on bare canvas'
  ).toBe('CANVAS');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2);
  await expect(page.locator('.selection-band')).toBeVisible();
  await page.mouse.move(end.x, end.y);
  await page.mouse.up();
}

async function boxExtent(page: Page) {
  const { box } = await project(page);
  if (!box) throw new Error('the box should be drawn');
  const [minX, minY, , maxX, maxY, maxZ] = [...box.min, ...box.max] as [
    number,
    number,
    number,
    number,
    number,
    number
  ];
  const pad = Math.max(maxX - minX, maxY - minY) * 0.2;
  return { minX, minY, maxX, maxY, maxZ, pad, midX: (minX + maxX) / 2 };
}

const xrayButton = (page: Page) =>
  page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: /^X-ray/ });

test('a box takes edges by its direction, and through faces in X-ray', async ({
  page
}) => {
  await createBox(page, 'Edge Sweep Part');
  await topView(page);
  await setSelectionFilter(page, 'Edge');
  const status = page.getByRole('contentinfo');
  const { minX, minY, maxY, maxZ, pad, midX } = await boxExtent(page);
  // The left half of the box, past its front and back: the left edge and the
  // two vertical corner edges lie wholly inside, and the front and back edges
  // only partly.
  const outerLeft: [number, number, number] = [minX - pad, maxY + pad, maxZ];
  const middleBelow: [number, number, number] = [midX, minY - pad, maxZ];
  const middleAbove: [number, number, number] = [midX, maxY + pad, maxZ];
  const outerLeftBelow: [number, number, number] = [
    minX - pad,
    minY - pad,
    maxZ
  ];

  // Left to right is a window: only what it fully encloses.
  await sweep(page, outerLeft, middleBelow);
  await expect(status).toContainText('3 edges selected.');
  await page.keyboard.press('Escape');

  // Right to left is a crossing: the partly covered edges come too. The
  // bottom face's edges are hidden behind the top face and are not taken.
  await sweep(page, middleAbove, outerLeftBelow);
  await expect(status).toContainText('5 edges selected.');
  await expect(canvas(page)).toHaveAttribute(
    'data-e2e-selected-edges',
    /^[^,]+(,[^,]+){4}$/
  );
  await page.keyboard.press('Escape');

  // X-ray: the hidden edges are taken as well.
  await xrayButton(page).click();
  await expect(xrayButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas(page)).toHaveAttribute('data-e2e-xray', '0.35');
  await sweep(page, middleAbove, outerLeftBelow);
  await expect(status).toContainText('8 edges selected.');
  await page.keyboard.press('Escape');
  await sweep(page, outerLeft, middleBelow);
  await expect(status).toContainText('4 edges selected.');
});

test('a box takes the faces in view, and every face in X-ray', async ({
  page
}) => {
  await createBox(page, 'Face Sweep Part');
  await topView(page);
  // Straight down in orthographic, the sides are edge-on: the top is the one
  // face in view. (In perspective a framing offset can show a side sliver.)
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: /^Orthographic projection/ })
    .click();
  await page.waitForTimeout(300);
  await setSelectionFilter(page, 'Face');
  const status = page.getByRole('contentinfo');
  const { minX, minY, maxX, maxY, maxZ, pad } = await boxExtent(page);
  const around: [[number, number, number], [number, number, number]] = [
    [minX - pad, maxY + pad, maxZ],
    [maxX + pad, minY - pad, maxZ]
  ];

  await sweep(page, ...around);
  await expect(status).toContainText('1 face selected.');
  await expect(canvas(page)).toHaveAttribute('data-e2e-focus-faces', '1');
  await page.keyboard.press('Escape');
  await expect(canvas(page)).not.toHaveAttribute('data-e2e-focus-faces', /.*/);

  await page.keyboard.press('Shift+X');
  await expect(canvas(page)).toHaveAttribute('data-e2e-xray', /^0\./);
  await sweep(page, ...around);
  await expect(status).toContainText('6 faces selected.');
  await expect(canvas(page)).toHaveAttribute('data-e2e-focus-faces', '6');
});

test('X-ray picks a rear edge and hands back the view it was over', async ({
  page
}) => {
  await createBox(page, 'X-ray Part');
  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(700);
  const display = page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: /^Display mode/ });
  const displayBefore = await display.getAttribute('aria-label');
  await setSelectionFilter(page, 'Edge');

  await xrayButton(page).click();
  await expect(canvas(page)).toHaveAttribute('data-e2e-xray', '0.35');
  // An edge with the box's own faces standing in front of it.
  const rear = await locateEdge(page, { occluded: true });
  await page.mouse.click(rear.x, rear.y);
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('1 edge selected');
  await expect(canvas(page)).toHaveAttribute(
    'data-e2e-selected-edges',
    rear.topologyId
  );

  // Back to shaded: the mode, the body and the pick are as they were.
  await xrayButton(page).click();
  await expect(xrayButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(canvas(page)).not.toHaveAttribute('data-e2e-xray', /.*/);
  await expect(display).toHaveAttribute('aria-label', displayBefore!);
  await expectBodyCount(page, 1);
  await expect(canvas(page)).toHaveAttribute(
    'data-e2e-selected-edges',
    rear.topologyId
  );
});

test('the field of view setting widens the camera without moving the part', async ({
  page
}) => {
  await createBox(page, 'Field of View Part');
  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(700);
  await expect(canvas(page)).toHaveAttribute('data-e2e-field-of-view', '45');
  const { box } = await project(page);
  const centre = box!.min.map(
    (value, axis) => (value + box!.max[axis]!) / 2
  ) as [number, number, number];
  const [was] = (await project(page, [centre])).points;

  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Viewport', exact: true }).click();
  const field = page.getByLabel('Perspective field of view');
  await field.fill('70');
  await field.blur();
  await page.getByRole('button', { name: 'Back to workspace' }).click();

  await expect(canvas(page)).toHaveAttribute('data-e2e-field-of-view', '70');
  // The framing is kept: the box's centre is where it was on screen.
  const [now] = (await project(page, [centre])).points;
  expect(Math.abs(now!.x - was!.x)).toBeLessThan(2);
  expect(Math.abs(now!.y - was!.y)).toBeLessThan(2);
  // Orthographic is still its own projection, one key away.
  await page.keyboard.press('p');
  await expect(
    page
      .getByRole('toolbar', { name: 'Viewer bar' })
      .getByRole('button', { name: /^Orthographic projection/ })
  ).toHaveAttribute('aria-pressed', 'true');
});

test('a sketch shown by hand stays shown after a reload', async ({ page }) => {
  const sketch = addSketchFeature(
    createProjectDocument('Sketch Visibility Part', toUserId('user_e2e')),
    {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      objects: [
        {
          objectKind: 'rectangle',
          width: 80,
          height: 40,
          centerX: 0,
          centerY: 0
        }
      ]
    }
  );
  const document = extrudeSketch(sketch.document, {
    name: 'Plate',
    sketchId: sketch.sketchId,
    distance: 20
  }).document;
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

  // The extrude consumed the sketch, so it starts hidden; show it by hand.
  await page.getByRole('button', { name: 'Show Profile' }).click();
  await expect(
    page.getByRole('button', { name: 'Hide sketch Profile' })
  ).toBeVisible();
  // The choice lands with the view once the camera has reported a pose.
  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(700);

  await page.reload();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible({
    timeout: 30_000
  });
  await expect(
    page.getByRole('button', { name: 'Hide sketch Profile' })
  ).toBeVisible({ timeout: 30_000 });
});
