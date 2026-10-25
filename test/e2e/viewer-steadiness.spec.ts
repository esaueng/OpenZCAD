import type { Locator, Page } from '@playwright/test';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

/**
 * Viewer state must not replay or blink when something unrelated changes:
 * a normal-to-face glide is one camera move, not one per later update, and
 * an armed handle is not rebuilt (faded out and back in) because its card,
 * keypad or a preview re-derived the same target.
 */

declare global {
  interface Window {
    __handleLog?: { t: number; value: string | null }[];
    __holdFinal?: { hold: boolean; held: number; release(): void };
  }
}

interface CameraState {
  position: number[];
  target: number[];
}

function camera(canvas: Locator): Promise<CameraState> {
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

async function newProject(page: Page, name: string) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
}

async function addBox(page: Page) {
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expectBodyCount(page, 1);
}

/** Holds the worker's complete-rebuild replies, so a release stays validating. */
async function holdValidation(page: Page) {
  await page.addInitScript(() => {
    const finals: (() => void)[] = [];
    window.__holdFinal = {
      hold: false,
      held: 0,
      release() {
        this.hold = false;
        for (const deliver of finals.splice(0)) deliver();
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(
      Worker.prototype,
      'onmessage'
    )!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      ...descriptor,
      set(listener: (event: MessageEvent) => void) {
        descriptor.set!.call(this, (event: MessageEvent) => {
          const result = event.data as { type?: string; requestId?: string };
          const gate = window.__holdFinal!;
          if (
            gate.hold &&
            result.type === 'sync' &&
            typeof result.requestId === 'string'
          ) {
            gate.held += 1;
            finals.push(() => listener.call(this, event));
          } else listener.call(this, event);
        });
      }
    });
  });
}

test('a normal-to-face glide does not replay when the bodies change later', async ({
  page
}) => {
  await newProject(page, 'Normal to face once');
  await addBox(page);
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          new Promise((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: { normal: { x: 0, y: 0, z: 1 }, resolve }
              })
            );
          })
      )
    )
    .not.toBeNull();
  const viewDirection = (pose: CameraState) => {
    const direction = pose.position.map(
      (value, axis) => value - pose.target[axis]!
    );
    const length = Math.hypot(...direction);
    return direction.map((value) => value / length);
  };
  const faceOn = (pose: CameraState) => Math.abs(viewDirection(pose)[2]!);
  await page.keyboard.press('Space');
  // The glide ends looking straight down the face normal.
  await expect
    .poll(async () => faceOn(await camera(canvas)), { timeout: 15_000 })
    .toBeGreaterThan(0.999);
  await page.waitForTimeout(300);

  // Turn away from the face, pressing on empty canvas (the armed face would
  // take the press as a push/pull).
  const box = (await canvas.boundingBox())!;
  const fromX = box.x + 120;
  const fromY = box.y + box.height - 140;
  await page.keyboard.down('Shift');
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + 30, fromY - 180, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  // Let the orbit's damping settle before taking the reference pose.
  let turned = await camera(canvas);
  await expect
    .poll(async () => {
      const next = await camera(canvas);
      const moved = Math.hypot(
        ...next.position.map((value, axis) => value - turned.position[axis]!)
      );
      turned = next;
      return moved;
    })
    .toBeLessThan(1e-6);
  // Turned well away from looking straight down the face normal.
  expect(faceOn(turned)).toBeLessThan(0.99);

  // Hiding and showing the body hands the viewer new bodies, with the face
  // still in them: the camera must stay where the user turned it.
  await page.getByRole('button', { name: 'Hide body Box 1' }).click();
  await page.getByRole('button', { name: 'Show body Box 1' }).click();
  await expectBodyCount(page, 1);
  await page.waitForTimeout(1000);
  const after = await camera(canvas);
  // Not glided back to the face: still looking the way it was turned (a
  // re-frame may nudge the distance, not the direction).
  expect(faceOn(after)).toBeLessThan(0.99);
  const before = viewDirection(turned);
  const alignment = viewDirection(after).reduce(
    (sum, value, axis) => sum + value * before[axis]!,
    0
  );
  expect(alignment).toBeGreaterThan(0.9999);
});

test('the edge radius handle is not rebuilt when its keypad opens or a preview lands', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await newProject(page, 'Edge handle steady');
  await addBox(page);
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              setTimeout(() => resolve(false), 1500);
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-edge', {
                  detail: {
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        ),
      { timeout: 30_000 }
    )
    .toBe(true);
  await expect(canvas).toHaveAttribute('data-e2e-edge-rig-builds', /\d+/);
  const builds = () =>
    canvas.evaluate((element) => Number(element.dataset.e2eEdgeRigBuilds));
  const armed = await builds();

  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Radius value' });
  await expect(keypad).toBeVisible();
  await page.waitForTimeout(300);
  expect(await builds()).toBe(armed);

  await keypad.getByRole('textbox').fill('2');
  await expect
    .poll(() =>
      canvas.evaluate((element) =>
        Number(element.dataset.e2ePreviewBlendCount ?? 0)
      )
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(await builds()).toBe(armed);
});

test('hiding a body takes its armed edge handle with it', async ({ page }) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await newProject(page, 'Edge handle hidden body');
  await addBox(page);
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              setTimeout(() => resolve(false), 1500);
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-edge', {
                  detail: {
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        ),
      { timeout: 30_000 }
    )
    .toBe(true);
  await expect(canvas).toHaveAttribute(
    'data-e2e-chip-anchor-rig',
    'edge-radius'
  );
  await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();

  await page.getByRole('button', { name: 'Hide body Box 1' }).click();
  await expectBodyCount(page, 0);
  // No handle left floating where the hidden body was, to edit it unseen.
  await expect(page.getByTestId('direct-manipulation-value')).toBeHidden();
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /.+/);
});

test('the cylinder radius handle stays on screen while its release validates', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await holdValidation(page);
  await newProject(page, 'Cylinder handle steady');
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expectBodyCount(page, 1);
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: { surface: 'wall' }
          })
        )
      );
      return canvas.getAttribute('data-e2e-chip-anchor-rig');
    })
    .toBe('cylinder-radius');
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixels: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  const x = bounds.x + handle.x;
  const y = bounds.y + handle.y;

  await canvas.evaluate((element) => {
    const log: { t: number; value: string | null }[] = [];
    window.__handleLog = log;
    new MutationObserver(() =>
      log.push({
        t: performance.now(),
        value: element.getAttribute('data-e2e-handle-x')
      })
    ).observe(element, {
      attributes: true,
      attributeFilter: ['data-e2e-handle-x']
    });
  });
  await page.evaluate(() => {
    window.__holdFinal!.hold = true;
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    x + handle.dx * handle.pixels * 2,
    y + handle.dy * handle.pixels * 2,
    { steps: 12 }
  );
  const released = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.__holdFinal!.held))
    .toBeGreaterThan(0);
  await page.waitForTimeout(500);
  // Held where it was let go for the whole validation.
  expect(
    await page.evaluate(
      (from) =>
        (window.__handleLog ?? []).filter(
          (entry) => entry.t >= from && !entry.value
        ).length,
      released
    )
  ).toBe(0);
  await page.evaluate(() => window.__holdFinal!.release());
});
