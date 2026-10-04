import type { Locator, Page } from '@playwright/test';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

/**
 * A sketch on a face arrives rolled so the plane's +u reads rightward and +v
 * upward, as a canonical plane does. A box's top face stores a frame whose u
 * runs along world -Y; under world-up roll a +u step went down the screen and
 * text placed at rotation 0 read sideways.
 */

interface ProjectedSketch {
  screen: { x: number; y: number }[];
}

/** Plane points of the live sketch, in client pixels. */
async function projectPlanePoints(
  canvas: Locator,
  project: { x: number; y: number }[]
): Promise<ProjectedSketch | null> {
  return canvas.evaluate(
    (element, points) =>
      new Promise<ProjectedSketch | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: { project: points, resolve }
          })
        );
      }),
    project
  );
}

/**
 * Waits for the sketch entry glide to land: the render loop draws on demand,
 * so a frame counter that holds still across a window proves the camera is
 * at rest.
 */
async function waitForStillViewport(page: Page) {
  const canvas = page.locator('.viewer-host canvas');
  const frames = async () =>
    Number(
      (await canvas.evaluate(
        (element) => (element as HTMLElement).dataset.e2eFrames
      )) ?? '0'
    );
  await expect
    .poll(
      async () => {
        const before = await frames();
        await page.waitForTimeout(400);
        return (await frames()) - before;
      },
      { timeout: 20_000 }
    )
    .toBe(0);
}

/** Where +u and +v steps from the plane origin land on screen. */
async function screenSteps(canvas: Locator) {
  const projected = await projectPlanePoints(canvas, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 10 }
  ]);
  expect(projected).not.toBeNull();
  const [origin, stepU, stepV] = projected!.screen;
  return {
    origin: origin!,
    u: { x: stepU!.x - origin!.x, y: stepU!.y - origin!.y },
    v: { x: stepV!.x - origin!.x, y: stepV!.y - origin!.y }
  };
}

function expectRightAndUp(steps: Awaited<ReturnType<typeof screenSteps>>) {
  // +u runs right with no vertical drift; +v runs up (client y shrinks).
  expect(steps.u.x).toBeGreaterThan(5);
  expect(Math.abs(steps.u.y)).toBeLessThan(0.5);
  expect(steps.v.y).toBeLessThan(-5);
  expect(Math.abs(steps.v.x)).toBeLessThan(0.5);
}

test('a top-face sketch reads +u rightward and +v upward', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await createProject(page, 'Face Sketch Axes');
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          new Promise<boolean>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: {
                  normal: { x: 0, y: 0, z: 1 },
                  resolve: (face: { hasReference: boolean } | null) =>
                    resolve(face?.hasReference === true)
                }
              })
            );
          })
      )
    )
    .toBe(true);
  await page
    .getByRole('region', { name: 'Resize Body operation' })
    .getByRole('button', { name: 'Selection: Sketch' })
    .click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await expect(page.locator('.viewport-dock-grid')).toBeVisible();
  await waitForStillViewport(page);

  const entered = await screenSteps(canvas);
  expectRightAndUp(entered);

  // Panning (OrbitControls' own middle-drag pan) keeps the axes. Which
  // gestures release a held roll is pinned in CameraController.test.ts: on
  // a horizontal face the pole nudge already makes world up agree with v.
  const bounds = (await canvas.boundingBox())!;
  const grab = {
    x: bounds.x + bounds.width * 0.3,
    y: bounds.y + bounds.height * 0.3
  };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(grab.x + 90, grab.y + 60, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await waitForStillViewport(page);
  const panned = await screenSteps(canvas);
  // Premise: the drag panned the view.
  expect(
    Math.hypot(
      panned.origin.x - entered.origin.x,
      panned.origin.y - entered.origin.y
    )
  ).toBeGreaterThan(20);
  expectRightAndUp(panned);

  // Leaving the sketch glides back cleanly.
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toHaveCount(
    0
  );
  expect(errors).toEqual([]);
});

test('a Top (XY) sketch keeps +u rightward and +v upward', async ({ page }) => {
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await createProject(page, 'Plane Sketch Axes');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await expect(page.locator('.viewport-dock-grid')).toBeVisible();
  await waitForStillViewport(page);

  expectRightAndUp(await screenSteps(page.locator('.viewer-host canvas')));
});
