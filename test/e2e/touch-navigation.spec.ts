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

test.describe('touch stand-ins for keys and right-click', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('Multi-select makes a second tap on the block take it back out', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    const canvas = await openBlock(page);
    const { body } = await points(canvas);
    const picked = page.locator('.selection-readout .selection-callout-name');
    await page.touchscreen.tap(body[0], body[1]);
    await expect(picked).toBeVisible();
    // Without the toggle a second tap is a plain click: still selected.
    await page.waitForTimeout(400);
    await page.touchscreen.tap(body[0], body[1]);
    await expect(picked).toBeVisible();
    const multi = page.getByRole('button', { name: 'Multi-select' });
    await multi.tap();
    await expect(multi).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(400);
    await page.touchscreen.tap(body[0], body[1]);
    await expect(picked).toHaveCount(0);
  });

  test('a held finger on a History row opens its menu', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await openBlock(page);
    const row = page.locator('.feature-row').filter({ hasText: 'Extrude' });
    await expect(row).toBeVisible();
    const box = (await row.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const at: Point = [box.x + 40, box.y + box.height / 2];
    await touch(cdp, 'touchStart', [at]);
    await page.waitForTimeout(800);
    await touch(cdp, 'touchEnd', []);
    await expect(page.getByRole('menu')).toBeVisible();
    // The lift was the hold's, not a click on the row.
    await expect(page.getByRole('menu')).toBeVisible();
  });
});

test.describe('touch sketching', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('a finger draws a circle with a magnifier over the point it hides', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Touch sketch');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('button', { name: /^Sketch \(S\)/ }).tap();
    await page.getByRole('button', { name: 'Top (XY)' }).tap();
    const tools = page.getByRole('toolbar', { name: 'Sketch tools' });
    await expect(tools).toBeVisible();
    const circle = tools.getByRole('button', { name: /^Circle/ });
    await circle.tap();
    await expect(circle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.viewport-dock-grid')).not.toHaveText('');

    const box = (await page
      .locator('.viewer-host canvas')
      .first()
      .boundingBox())!;
    const center: Point = [box.x + box.width * 0.4, box.y + box.height * 0.5];
    const cdp = await page.context().newCDPSession(page);
    const loupe = page.locator('.touch-loupe');
    await touch(cdp, 'touchStart', [center]);
    for (let step = 1; step <= 6; step += 1) {
      await touch(cdp, 'touchMove', [[center[0] + step * 12, center[1]]]);
    }
    await expect(loupe).toBeVisible();
    // It sits clear of the finger, never under it.
    const shown = (await loupe.boundingBox())!;
    expect(shown.y + shown.height).toBeLessThan(center[1]);
    await touch(cdp, 'touchEnd', []);
    await expect(loupe).toBeHidden();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Sketch 01 started.'
    );
  });
});

/** A real pen stroke through the input domain (pointerType "pen"). */
async function penStroke(
  cdp: CDPSession,
  from: Point,
  to: Point,
  { release = true, steps = 6 } = {}
) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from[0],
    y: from[1],
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: 'pen'
  });
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from[0] + ((to[0] - from[0]) * step) / steps,
      y: from[1] + ((to[1] - from[1]) * step) / steps,
      button: 'left',
      buttons: 1,
      pointerType: 'pen'
    });
  }
  if (release) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to[0],
      y: to[1],
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'pen'
    });
  }
}

test.describe('Apple Pencil', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('once a Pencil draws, a finger in a drawing tool only moves the view', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Pencil sketch');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('button', { name: /^Sketch \(S\)/ }).tap();
    await page.getByRole('button', { name: 'Top (XY)' }).tap();
    const tools = page.getByRole('toolbar', { name: 'Sketch tools' });
    const circle = tools.getByRole('button', { name: /^Circle/ });
    await circle.tap();
    await expect(circle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.viewport-dock-grid')).not.toHaveText('');
    const canvas = page.locator('.viewer-host canvas').first();
    const box = (await canvas.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const status = page.getByRole('contentinfo');

    const penAt: Point = [box.x + box.width * 0.35, box.y + box.height * 0.5];
    await penStroke(cdp, penAt, [penAt[0] + 60, penAt[1]]);
    await expect(status).toContainText('Sketch 01 started.');

    await circle.tap();
    await expect(circle).toHaveAttribute('aria-pressed', 'true');
    // Long enough after the pen lifted that the finger is not a palm.
    await page.waitForTimeout(400);
    const finger: Point = [box.x + box.width * 0.55, box.y + box.height * 0.4];
    await swipe(cdp, [finger], [[finger[0] + 80, finger[1] + 30]]);
    await page.waitForTimeout(500);
    await expect(status).not.toContainText('Added circle.');
    await expect(circle).toHaveAttribute('aria-pressed', 'true');
  });

  test('a palm on the glass while the Pencil is down does nothing', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    const canvas = await openBlock(page);
    await recordOrientation(canvas);
    const cdp = await page.context().newCDPSession(page);
    const box = (await canvas.boundingBox())!;
    const pen: Point = [box.x + box.width * 0.3, box.y + box.height * 0.25];
    // The pen rests without moving: a press, not yet a band.
    await penStroke(cdp, pen, pen, { release: false, steps: 1 });
    const palm: Point = [box.x + box.width * 0.35, box.y + box.height * 0.7];
    await swipe(cdp, [palm], [[palm[0] + 150, palm[1] - 40]]);
    await page.waitForTimeout(400);
    const after = await cameraState(canvas);
    const frames = after.orientations;
    if (frames.length > 1) {
      expect(angleBetween(frames[0]!, frames.at(-1)!)).toBeLessThan(1e-3);
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pen[0],
      y: pen[1],
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'pen'
    });
  });
});
