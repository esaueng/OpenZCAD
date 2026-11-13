import type { Locator, Page } from '@playwright/test';
import {
  expect,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * Orbiting has no polar limit, so a drag can leave the view upside down. The
 * camera's up is part of the remembered view, so a reload reopens it upside
 * down rather than turning it back over.
 */

interface CameraState {
  position: number[];
  target: number[];
  up?: number[];
}

function cameraState(canvas: Locator): Promise<CameraState> {
  return canvas.evaluate(
    (element) =>
      new Promise<CameraState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-input-state', {
            detail: {
              resolve: (state: { camera: CameraState }) => resolve(state.camera)
            }
          })
        );
      })
  );
}

function viewDirection(camera: CameraState): number[] {
  const offset = camera.position.map(
    (coordinate, axis) => coordinate - camera.target[axis]!
  );
  const length = Math.hypot(...offset);
  return offset.map((coordinate) => coordinate / length);
}

async function openViewer(page: Page) {
  await expect(page.getByRole('toolbar', { name: 'Viewer bar' })).toBeVisible({
    timeout: 30_000
  });
  return page.locator('.viewer-host canvas');
}

test(
  'an upside-down view reopens upside down after a reload',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Upside down');
    await page.getByRole('button', { name: 'New project' }).click();
    const canvas = await openViewer(page);
    const box = (await canvas.boundingBox())!;

    // Shift+drag orbits from anywhere. Down by 40% of the canvas height turns
    // the camera 144° about its right axis: from the home iso view, over the
    // top and down the far side.
    const startX = box.x + box.width * 0.3;
    const startY = box.y + box.height * 0.2;
    await page.mouse.move(startX, startY);
    await page.keyboard.down('Shift');
    await page.mouse.down();
    const steps = 40;
    for (let step = 1; step <= steps; step += 1) {
      await page.mouse.move(startX, startY + (box.height * 0.4 * step) / steps);
    }
    await page.mouse.up();
    await page.keyboard.up('Shift');

    await expect
      .poll(async () => (await cameraState(canvas)).up)
      .toEqual([0, 0, -1]);
    // Compare against the pose the release glide comes to rest on, and let it
    // reach storage: the view is written once the camera has settled.
    await waitForStillViewport(page);
    const before = await cameraState(canvas);
    await page.waitForTimeout(500);

    await page.reload();
    const reopened = await openViewer(page);
    await expect
      .poll(async () => (await cameraState(reopened)).up)
      .toEqual([0, 0, -1]);
    const after = await cameraState(reopened);
    const direction = viewDirection(after);
    viewDirection(before).forEach((component, axis) => {
      expect(direction[axis]).toBeCloseTo(component, 4);
    });
  }
);
