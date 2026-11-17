import type { Locator, Page } from '@playwright/test';
import {
  clickWorldPoint,
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  finishInPlaceCommand,
  pressTool,
  setSelectionFilter,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * R01 reference constructors (schema v108), made in place on a 20 mm block:
 * a Plane square to an edge, picked along the edge and its position
 * dragged; a Plane through a top edge, tilted from the top face by its
 * ring; and an Axis square to the top face at a picked corner. Each is drawn
 * where the exact build resolved it.
 */

type Vec = { x: number; y: number; z: number };

async function drawn<T>(canvas: Locator, attribute: string): Promise<T[]> {
  const raw = await canvas.getAttribute(attribute);
  return raw ? (JSON.parse(raw) as T[]) : [];
}

async function handles(
  canvas: Locator
): Promise<Record<string, { x: number; y: number; value: number }>> {
  return canvas.evaluate((element) =>
    element.dataset.e2eCommandHandles
      ? (JSON.parse(element.dataset.e2eCommandHandles) as Record<
          string,
          { x: number; y: number; value: number }
        >)
      : {}
  );
}

async function projected(
  canvas: Locator,
  points: [number, number, number][]
): Promise<{ x: number; y: number }[]> {
  return canvas.evaluate(
    (element, list) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: list,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    points
  );
}

/** Drags handle `valueId` by the screen offset between two world points. */
async function dragHandle(
  page: Page,
  canvas: Locator,
  valueId: string,
  from: [number, number, number],
  to: [number, number, number]
): Promise<number> {
  await expect
    .poll(async () => (await handles(canvas))[valueId] !== undefined)
    .toBe(true);
  const grip = (await handles(canvas))[valueId]!;
  const [a, b] = await projected(canvas, [from, to]);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + b!.x - a!.x, grip.y + b!.y - a!.y, {
    steps: 12
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await handles(canvas))[valueId]?.value ?? 0)
    .not.toBeCloseTo(grip.value, 3);
  return (await handles(canvas))[valueId]!.value;
}

type Frame = { featureId: string; origin: Vec; normal: Vec };
type Line = { featureId: string; origin: Vec; direction: Vec };

test('planes square to an edge or at an angle, and an axis square to a face, in place', async ({
  page
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Reference datums');
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas');

  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '20', depth: '20', height: '20' }
  });
  await expectBodyCount(page, 1);

  // Plane 1: square to the upright edge at x 20, y 0, picked along it, its
  // position dragged up the edge.
  await pressTool(page, /^Plane — /);
  const planeBar = page.getByRole('group', { name: 'Plane command' });
  await setSelectionFilter(page, 'Edge');
  await clickWorldPoint(page, [20, 0, 10]);
  await expect(planeBar).toContainText('Square to the edge');
  const position = await dragHandle(
    page,
    canvas,
    'position',
    [20, 0, 10],
    [20, 0, 16]
  );
  expect(position).toBeGreaterThanOrEqual(0);
  expect(position).toBeLessThanOrEqual(1);
  await finishInPlaceCommand(page, 'Plane');
  await setSelectionFilter(page, 'Any');
  await expect(
    page.locator('.feature-row', { hasText: 'Plane 1' })
  ).toContainText('square to edge', { timeout: 20_000 });
  await expect
    .poll(
      async () => (await drawn<Frame>(canvas, 'data-e2e-datum-planes')).length
    )
    .toBe(1);
  const [square] = await drawn<Frame>(canvas, 'data-e2e-datum-planes');
  expect(square!.origin.x).toBeCloseTo(20, 6);
  expect(square!.origin.y).toBeCloseTo(0, 6);
  expect(Math.abs(square!.normal.z)).toBeCloseTo(1, 9);
  // The fraction runs from the edge's end 0, whichever end that is.
  expect(
    Math.min(
      Math.abs(square!.origin.z - 20 * position),
      Math.abs(square!.origin.z - 20 * (1 - position))
    )
  ).toBeLessThan(1e-6);

  // Plane 2: through the top front edge, turned from the top face.
  await pressTool(page, /^Plane — /);
  await setSelectionFilter(page, 'Edge');
  await clickWorldPoint(page, [10, 0, 20]);
  await expect(planeBar).toContainText('Square to the edge');
  await setSelectionFilter(page, 'Face');
  await clickWorldPoint(page, [10, 10, 20]);
  await expect(planeBar).toContainText('Through the edge');
  const angle = await dragHandle(
    page,
    canvas,
    'angle',
    [10, 4, 20],
    [10, 4, 24]
  );
  await finishInPlaceCommand(page, 'Plane');
  await setSelectionFilter(page, 'Any');
  await expect(
    page.locator('.feature-row', { hasText: 'Plane 2' })
  ).toContainText('to edge', { timeout: 20_000 });
  await expect
    .poll(
      async () => (await drawn<Frame>(canvas, 'data-e2e-datum-planes')).length
    )
    .toBe(2);
  const tilted = (await drawn<Frame>(canvas, 'data-e2e-datum-planes')).find(
    (frame) => frame.featureId !== square!.featureId
  )!;
  expect(tilted.normal.x).toBeCloseTo(0, 9);
  expect(tilted.normal.z).toBeCloseTo(Math.cos((angle * Math.PI) / 180), 6);
  expect(tilted.origin.y).toBeCloseTo(0, 6);
  expect(tilted.origin.z).toBeCloseTo(20, 6);

  // Axis 1: square to the top face at its back right corner.
  await pressTool(page, /^Axis — /);
  const axisBar = page.getByRole('group', { name: 'Axis command' });
  await setSelectionFilter(page, 'Face');
  await clickWorldPoint(page, [6, 8, 20]);
  await expect(axisBar).toContainText(
    'an edge end for the axis square to the face'
  );
  await setSelectionFilter(page, 'Edge');
  await clickWorldPoint(page, [19, 20, 20]);
  await expect(axisBar).toContainText('Square to the face');
  await finishInPlaceCommand(page, 'Axis');
  await setSelectionFilter(page, 'Any');
  await expect(
    page.locator('.feature-row', { hasText: 'Axis 1' })
  ).toContainText('square to face', { timeout: 20_000 });
  await expect
    .poll(async () => (await drawn<Line>(canvas, 'data-e2e-datum-axes')).length)
    .toBe(1);
  const [axis] = await drawn<Line>(canvas, 'data-e2e-datum-axes');
  expect(axis!.direction.z).toBeCloseTo(1, 9);
  expect(axis!.origin.x).toBeCloseTo(20, 6);
  expect(axis!.origin.y).toBeCloseTo(20, 6);
  expect(axis!.origin.z).toBeCloseTo(20, 6);
  expect(errors).toEqual([]);
});
