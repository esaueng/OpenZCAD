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
 * R01 (schema v99): datum points and coordinate systems, made in place. A
 * Point is dragged out along X from the world origin by its arrow, another
 * is picked at an edge's midpoint; a coordinate system is dragged to its
 * origin and turned by its ring. Each is drawn where the exact build
 * resolved it and reopens from History to be dragged again.
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

test('points and coordinate systems in place: dragged, picked, reopened', async ({
  page
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Datum points');
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas');

  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '20', depth: '20', height: '20' }
  });
  await expectBodyCount(page, 1);

  // A point dragged out along X from the world origin.
  await pressTool(page, /^Point — /);
  const pointBar = page.getByRole('group', { name: 'Point command' });
  await expect(pointBar).toContainText('Drag X, Y, Z');
  const x = await dragHandle(page, canvas, 'x', [0, 0, 0], [30, 0, 0]);
  expect(x).toBeGreaterThan(10);
  await finishInPlaceCommand(page, 'Point');
  await expect(
    page.locator('.feature-row', { hasText: 'Point 1' })
  ).toContainText('at point', { timeout: 20_000 });
  await expect
    .poll(async () => (await drawn<Vec>(canvas, 'data-e2e-datum-points')).length)
    .toBe(1);
  const [first] = await drawn<Vec & { featureId: string }>(
    canvas,
    'data-e2e-datum-points'
  );
  expect(first!.x).toBeCloseTo(x, 3);
  expect(first!.y).toBeCloseTo(0, 6);
  expect(first!.z).toBeCloseTo(0, 6);

  // A point at the middle of the block's top front edge, (0..20, 0, 20).
  await pressTool(page, /^Point — /);
  await expect(pointBar).toContainText('Drag X, Y, Z');
  await setSelectionFilter(page, 'Edge');
  await clickWorldPoint(page, [10, 0, 20]);
  await expect(pointBar).toContainText('At the middle of the edge');
  await finishInPlaceCommand(page, 'Point');
  await setSelectionFilter(page, 'Any');
  await expect(
    page.locator('.feature-row', { hasText: 'Point 2' })
  ).toContainText('edge midpoint', { timeout: 20_000 });
  await expect
    .poll(async () => (await drawn<Vec>(canvas, 'data-e2e-datum-points')).length)
    .toBe(2);
  const mid = (
    await drawn<Vec & { featureId: string }>(canvas, 'data-e2e-datum-points')
  ).find((entry) => entry.featureId !== first!.featureId)!;
  expect(mid.x).toBeCloseTo(10, 6);
  expect(mid.y).toBeCloseTo(0, 6);
  expect(mid.z).toBeCloseTo(20, 6);

  // A coordinate system dragged to its origin and turned about Z.
  await pressTool(page, /^Coordinate system — /);
  const systemBar = page.getByRole('group', {
    name: 'Coordinate system command'
  });
  await expect(systemBar).toContainText('Drag the origin');
  const ox = await dragHandle(page, canvas, 'ox', [0, 0, 0], [-25, 0, 0]);
  expect(ox).toBeLessThan(-10);
  await finishInPlaceCommand(page, 'Coordinate system');
  await expect(
    page.locator('.feature-row', { hasText: 'System 1' })
  ).toContainText('placed', { timeout: 20_000 });
  await expect
    .poll(
      async () =>
        (await drawn<{ origin: Vec; x: Vec }>(canvas, 'data-e2e-datum-csys'))[0]
          ?.origin.x
    )
    .toBeCloseTo(ox, 3);
  const [system] = await drawn<{ origin: Vec; x: Vec }>(
    canvas,
    'data-e2e-datum-csys'
  );
  expect(system!.x).toEqual({ x: 1, y: 0, z: 0 });

  // Reopened from History, the first point drags again along Y.
  await page.locator('.feature-row-main', { hasText: 'Point 1' }).click();
  const editBar = page.getByRole('group', { name: 'Edit Point 1 command' });
  await expect(editBar).toBeVisible();
  const y = await dragHandle(page, canvas, 'y', [x, 0, 0], [x, 25, 0]);
  expect(y).toBeGreaterThan(10);
  await finishInPlaceCommand(page, 'Edit Point 1');
  await expect
    .poll(
      async () =>
        (
          await drawn<Vec & { featureId: string }>(
            canvas,
            'data-e2e-datum-points'
          )
        ).find((entry) => entry.featureId === first!.featureId)?.y
    )
    .toBeCloseTo(y, 3);

  expect(errors).toEqual([]);
});
