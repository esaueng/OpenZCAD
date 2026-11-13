import type { Locator, Page } from '@playwright/test';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

/**
 * Orbit mode in Settings reaches the live viewer: with Turntable chosen, the
 * same drag that tumbles a free orbit over the top stops at the top view and
 * leaves the camera right way up. Shift+O and the viewer bar's orbit
 * button flip the same preference.
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

function elevation(camera: CameraState): number {
  const offset = camera.position.map(
    (coordinate, axis) => coordinate - camera.target[axis]!
  );
  return offset[2]! / Math.hypot(...offset);
}

async function chooseOrbit(page: Page, mode: 'Free' | 'Turntable') {
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Controls', exact: true }).click();
  const orbit = settings.getByRole('radiogroup', { name: 'Orbit' });
  await orbit.getByRole('radio', { name: mode }).check();
  await page
    .getByRole('button', { name: /Back to workspace|Close settings/ })
    .first()
    .click();
  await expect(settings).toHaveCount(0);
}

/** Shift+drag down by 40% of the canvas: 144° about the camera's right. */
async function dragOverTheTop(page: Page, canvas: Locator) {
  const box = (await canvas.boundingBox())!;
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
}

test(
  'a turntable orbit stops at the top view, right way up',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await createProject(page, 'Turntable');
    await chooseOrbit(page, 'Turntable');
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toBeVisible();

    await dragOverTheTop(page, canvas);
    // Parked on the top view rather than carried past it, and never
    // turned upside down.
    await expect
      .poll(async () => elevation(await cameraState(canvas)))
      .toBeGreaterThan(0.999_999);
    expect((await cameraState(canvas)).up).toBeUndefined();
  }
);

test(
  'Shift+O and the viewer bar button toggle the orbit mode Settings shows',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await createProject(page, 'Orbit key');
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toBeVisible();

    await page.keyboard.press('Shift+O');
    await expect(page.getByText(/^Turntable orbit/)).toBeVisible();
    await dragOverTheTop(page, canvas);
    await expect
      .poll(async () => elevation(await cameraState(canvas)))
      .toBeGreaterThan(0.999_999);

    // The key and Settings change one preference, not two.
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings
      .getByRole('button', { name: 'Controls', exact: true })
      .click();
    const orbit = settings.getByRole('radiogroup', { name: 'Orbit' });
    await expect(orbit.getByRole('radio', { name: 'Turntable' })).toBeChecked();
    await page
      .getByRole('button', { name: /Back to workspace|Close settings/ })
      .first()
      .click();
    await expect(settings).toHaveCount(0);

    await page.keyboard.press('Shift+O');
    await expect(page.getByText(/^Free orbit/)).toBeVisible();
    await page.getByRole('button', { name: 'Open settings' }).click();
    await settings
      .getByRole('button', { name: 'Controls', exact: true })
      .click();
    await expect(orbit.getByRole('radio', { name: 'Free' })).toBeChecked();
    await page
      .getByRole('button', { name: /Back to workspace|Close settings/ })
      .first()
      .click();
    await expect(settings).toHaveCount(0);

    // The viewer bar's orbit button flips the same preference and shows it.
    const button = page.getByRole('button', { name: /^Turntable orbit/ });
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/^Turntable orbit ·/)).toBeVisible();
    await page.keyboard.press('Shift+O');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
);
