import {
  createPrimitiveInPlace,
  test,
  expect,
  expectBodyCount,
  stubApi
} from './openzcad-fixtures';
import type { Locator, Page } from '@playwright/test';

interface CameraPose {
  position: number[];
  target: number[];
}

async function readLiveCamera(canvas: Locator): Promise<CameraPose> {
  return canvas.evaluate(
    (element) =>
      new Promise<CameraPose>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-input-state', {
            detail: {
              resolve: (state: { camera: CameraPose }) => resolve(state.camera)
            }
          })
        );
      })
  );
}

function directionOf(pose: CameraPose): number[] {
  const offset = [0, 1, 2].map(
    (axis) => pose.position[axis]! - pose.target[axis]!
  );
  const length = Math.hypot(...offset);
  return offset.map((value) => value / length);
}

/** Polls until the camera stops moving between two reads. */
async function settledCamera(canvas: Locator): Promise<CameraPose> {
  let previous = await readLiveCamera(canvas);
  await expect
    .poll(
      async () => {
        await canvas.page().waitForTimeout(150);
        const next = await readLiveCamera(canvas);
        const moved = Math.hypot(
          ...[0, 1, 2].map(
            (axis) =>
              next.position[axis]! -
              previous.position[axis]! +
              (next.target[axis]! - previous.target[axis]!)
          )
        );
        previous = next;
        return moved;
      },
      { timeout: 10_000 }
    )
    .toBeLessThan(1e-6);
  return previous;
}

async function createBox(page: Page, name: string) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
}

test('Fit keeps the view direction and frames clear of the docked panels', async ({
  page
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await createBox(page, 'Fit Direction Part');
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-camera-distance', /.+/);
  const dock = page.locator('.panel-column');
  await expect(dock).toBeVisible();

  await page.getByRole('button', { name: 'Standard views' }).click();
  await page.getByRole('button', { name: 'Front view (1)' }).click();
  await settledCamera(canvas);

  // F used to glide back to the iso home and frame against the full canvas.
  await page.keyboard.press('f');
  const withDock = await settledCamera(canvas);
  const front = directionOf(withDock);
  expect(front[0]!).toBeCloseTo(0, 3);
  expect(front[1]!).toBeCloseTo(-1, 3);
  expect(front[2]!).toBeCloseTo(0, 3);

  // Close every docked panel and fit again: the same direction, and the
  // camera sits further left in world X, because the part no longer has to
  // clear the dock on the right of the screen (+X from the front).
  const pressed = page
    .getByRole('toolbar', { name: 'Model panels' })
    .locator('button[aria-pressed="true"]');
  while ((await pressed.count()) > 0) {
    await pressed.first().click();
  }
  await expect(dock).toHaveCount(0);
  await page.keyboard.press('f');
  const withoutDock = await settledCamera(canvas);
  expect(directionOf(withoutDock)[1]!).toBeCloseTo(-1, 3);
  expect(withDock.target[0]! - withoutDock.target[0]!).toBeGreaterThan(1);
});

test('picking a face leaves the scale bar alone', async ({ page }) => {
  await createBox(page, 'Scale Pick Part');
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-camera-distance', /.+/);
  // Upright beside the rail: the rule's length is its height.
  const rule = page.getByTestId('viewport-scale-rule');
  await expect(rule).toBeVisible({ timeout: 15_000 });
  const box = await canvas.boundingBox();
  const before = await settledCamera(canvas);
  const widthBefore = await rule.evaluate(
    (element) => element.getBoundingClientRect().height
  );

  // Click the solid off-centre: the orbit pivot moves to the picked depth.
  await page.mouse.click(
    box!.x + box!.width * 0.42,
    box!.y + box!.height * 0.58
  );
  await expect(page.locator('.selection-callout-chip')).toBeVisible();
  const after = await readLiveCamera(canvas);
  const pivotTravel = Math.hypot(
    ...[0, 1, 2].map((axis) => after.target[axis]! - before.target[axis]!)
  );
  expect(pivotTravel).toBeGreaterThan(0.1);
  // A frame later the bar would have redrawn at the new pivot depth.
  await page.waitForTimeout(200);
  const widthAfter = await rule.evaluate(
    (element) => element.getBoundingClientRect().height
  );
  expect(Math.abs(widthAfter - widthBefore)).toBeLessThan(0.5);
});

// F009: a standard view was replayed by the next project's viewer, which
// also skipped that project's first fit, so a part opened off-screen.
test('a standard view stays in the project it was chosen in', async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await createBox(page, 'View Request Part');
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-camera-distance', /.+/);
  const opening = directionOf(await settledCamera(canvas));
  // Top looks straight down the Z axis.
  await page.keyboard.press('2');
  await expect
    .poll(async () => directionOf(await readLiveCamera(canvas))[2]!, {
      timeout: 10_000
    })
    .toBeCloseTo(1, 3);
  await settledCamera(canvas);

  await page.getByTitle('Back to projects').click();
  await page.getByLabel('Project name').fill('Next View Part');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  const next = directionOf(await settledCamera(canvas));
  // The new project opens on the same default view the first one did, and
  // its first part is framed rather than left wherever Top put the camera.
  for (const axis of [0, 1, 2]) {
    expect(next[axis]!).toBeCloseTo(opening[axis]!, 3);
  }
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          new Promise<boolean>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-bodies-in-view', {
                detail: {
                  resolve: (state: { inView: boolean }) => resolve(state.inView)
                }
              })
            );
          })
      )
    )
    .toBe(true);
});
