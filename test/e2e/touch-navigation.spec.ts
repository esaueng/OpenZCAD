import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { CDPSession, Locator, Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * L02 slice 3 (docs/plans/ipad-touch-plan-2026-11-05.md): fingers on the 3D
 * viewport, driven as real multi-touch through Chromium's input domain. This
 * is gesture-routing evidence; iPadOS Safari's own event timing needs a
 * device.
 */

async function openBlock(page: Page) {
  await stubApi(page, { commandFoldClosed: true });
  const sketch = addSketchFeature(
    createProjectDocument('Touch fixture', toUserId('user_e2e')),
    {
      name: 'Sketch 01',
      plane: 'XY',
      offset: 0,
      objects: [
        {
          objectKind: 'rectangle',
          width: 40,
          height: 30,
          centerX: 0,
          centerY: 0
        }
      ]
    }
  );
  const document = extrudeSketch(sketch.document, {
    name: 'Extrude',
    sketchId: sketch.sketchId,
    distance: '20'
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
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas').first();
  await expect(canvas).toHaveAttribute('data-e2e-camera-distance', /.+/, {
    timeout: 30_000
  });
  // Let the opening fit settle so every reading below starts still.
  await page.waitForTimeout(800);
  return canvas;
}

type Point = [number, number];

/** Real touch points, one id per finger, through the input domain. */
type TouchEventType = 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel';

async function touch(cdp: CDPSession, type: TouchEventType, points: Point[]) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], id) => ({ x, y, id }))
  });
}

/** Fingers from `from` to `to` in even steps, then lifted. */
async function swipe(cdp: CDPSession, from: Point[], to: Point[], steps = 8) {
  await touch(cdp, 'touchStart', from);
  for (let step = 1; step <= steps; step += 1) {
    await touch(
      cdp,
      'touchMove',
      from.map(([x, y], index) => [
        x + ((to[index]![0] - x) * step) / steps,
        y + ((to[index]![1] - y) * step) / steps
      ])
    );
  }
  await touch(cdp, 'touchEnd', []);
}

async function cameraState(canvas: Locator) {
  return canvas.evaluate((element) => {
    const camera = element as HTMLCanvasElement & {
      __orientations?: number[][];
    };
    return {
      distance: Number(element.dataset.e2eCameraDistance),
      orientations: camera.__orientations ?? []
    };
  });
}

/** Keeps every frame's camera orientation from here on. */
async function recordOrientation(canvas: Locator) {
  await canvas.evaluate((element) => {
    const camera = element as HTMLCanvasElement & {
      __orientations?: number[][];
    };
    camera.__orientations = [];
    element.addEventListener('openzcad:e2e-camera-frame', (event) => {
      camera.__orientations!.push(
        (event as CustomEvent<{ orientation: number[] }>).detail.orientation
      );
    });
  });
}

async function points(canvas: Locator) {
  const box = (await canvas.boundingBox())!;
  return {
    /** The block, framed at the centre of the stage. */
    body: [box.x + box.width / 2, box.y + box.height / 2] as Point,
    /** Grid only: the open stage up and left of the block, clear of the
     * tool rail and of the docked panels on the right. */
    empty: [box.x + box.width * 0.3, box.y + box.height * 0.25] as Point
  };
}

const angleBetween = (a: number[], b: number[]) =>
  2 *
  Math.acos(
    Math.min(
      1,
      Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!)
    )
  );

test.describe('touch on the 3D viewport', () => {
  test.use({ hasTouch: true, isMobile: true });

  test(
    'one finger on empty space orbits instead of drawing a selection band',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      await page.setViewportSize({ width: 1180, height: 820 });
      const canvas = await openBlock(page);
      await recordOrientation(canvas);
      const cdp = await page.context().newCDPSession(page);
      const { empty } = await points(canvas);
      const before = await cameraState(canvas);
      await swipe(cdp, [empty], [[empty[0] + 160, empty[1] + 40]]);
      await page.waitForTimeout(400);
      const after = await cameraState(canvas);
      const frames = after.orientations;
      expect(frames.length).toBeGreaterThan(2);
      expect(angleBetween(frames[0]!, frames.at(-1)!)).toBeGreaterThan(0.2);
      // An orbit keeps the viewing distance.
      expect(after.distance).toBeCloseTo(before.distance, 3);
      await expect(page.locator('.selection-callout')).toHaveCount(0);
    }
  );

  test(
    'two fingers spread apart zoom in and keep the view direction',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      await page.setViewportSize({ width: 1180, height: 820 });
      const canvas = await openBlock(page);
      await recordOrientation(canvas);
      const cdp = await page.context().newCDPSession(page);
      const { body } = await points(canvas);
      const before = await cameraState(canvas);
      await swipe(
        cdp,
        [
          [body[0] - 40, body[1]],
          [body[0] + 40, body[1]]
        ],
        [
          [body[0] - 120, body[1]],
          [body[0] + 120, body[1]]
        ]
      );
      await page.waitForTimeout(400);
      const after = await cameraState(canvas);
      // Spread 80 → 240 px: a third of the distance, within damping.
      expect(after.distance).toBeLessThan(before.distance * 0.5);
      expect(after.distance).toBeGreaterThan(before.distance * 0.2);
      const frames = after.orientations;
      expect(frames.length).toBeGreaterThan(0);
      expect(angleBetween(frames[0]!, frames.at(-1)!)).toBeLessThan(1e-3);
      await expect(page.locator('.selection-callout')).toHaveCount(0);
    }
  );

  test('a tap on the block selects it', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    const canvas = await openBlock(page);
    const { body } = await points(canvas);
    await page.touchscreen.tap(body[0], body[1]);
    await expect(
      page.locator('.selection-readout .selection-callout-name')
    ).toBeVisible();
  });

  test('a held finger opens the context menu, not a selection', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    const canvas = await openBlock(page);
    const cdp = await page.context().newCDPSession(page);
    const { body } = await points(canvas);
    await touch(cdp, 'touchStart', [body]);
    await page.waitForTimeout(700);
    await expect(page.getByRole('menu')).toBeVisible();
    await touch(cdp, 'touchEnd', []);
    await expect(page.getByRole('menu')).toBeVisible();
  });
});
