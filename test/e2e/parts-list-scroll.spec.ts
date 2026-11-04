import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Locator } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

interface CameraPose {
  position: number[];
  target: number[];
  orthographicZoom: number;
}

async function cameraPose(canvas: Locator): Promise<CameraPose> {
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

async function expectCameraUnchanged(canvas: Locator, before: CameraPose) {
  const after = await cameraPose(canvas);
  // Idle OrbitControls updates can round the pose by a few ULPs.
  for (const key of ['position', 'target'] as const) {
    for (let axis = 0; axis < 3; axis += 1) {
      expect(after[key][axis]).toBeCloseTo(before[key][axis]!, 9);
    }
  }
  expect(after.orthographicZoom).toBe(before.orthographicZoom);
}

function orbitDistance(camera: CameraPose): number {
  return Math.hypot(
    ...camera.position.map((value, axis) => value - camera.target[axis]!)
  );
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 }
]) {
  test(
    `Parts list scrolls without moving the camera at ${viewport.width}px`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      await stubApi(page);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));

      let document = createProjectDocument(
        'Scrollable parts',
        toUserId('user_e2e')
      );
      for (let i = 0; i < 36; i += 1) {
        document = addPrimitiveFeature(document, {
          name: `Box ${i + 1}`,
          bodyName: `Part ${i + 1}`,
          primitiveKind: 'box',
          dimensions: { width: 20 + i, height: 20, depth: 10 }
        });
      }
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
      await page.getByRole('button', { name: 'New project' }).click();
      const canvas = page.locator('.viewer-host canvas');
      await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '36');
      // Reduced motion makes framing immediate; subsequent assertions can
      // distinguish panel wheel input from a still-landing initial camera.
      await page.getByRole('button', { name: 'View', exact: true }).click();
      const parts = page.getByRole('complementary', { name: 'Parts' });
      if (!(await parts.isVisible())) {
        await page.getByRole('button', { name: 'Show the parts list' }).click();
      }
      const list = parts.getByRole('list');
      await expect(list.getByRole('listitem')).toHaveCount(36);
      const maxScroll = await list.evaluate(
        (element) => element.scrollHeight - element.clientHeight
      );
      expect(maxScroll).toBeGreaterThan(240);
      await page.getByRole('button', { name: 'Fit view (F)' }).click();
      await expect(canvas).toHaveAttribute('data-e2e-zoom-active', 'false');
      const before = await cameraPose(canvas);

      // Real wheel input is essential: dispatchEvent cannot exercise the
      // browser's native scrolling, which the camera used to cancel.
      await list.hover({ position: { x: 100, y: 60 } });
      for (const [deltaY, expected] of [
        [-120, 0], // Outward at the top must not zoom the model.
        [120, 120],
        [120, 240],
        [-120, 120]
      ] as const) {
        await page.mouse.wheel(0, deltaY);
        await expect
          .poll(() => list.evaluate((element) => element.scrollTop))
          .toBe(expected);
        await page.waitForTimeout(200);
        await expectCameraUnchanged(canvas, before);
      }

      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(200);
      expect(await list.evaluate((element) => element.scrollTop)).toBe(
        maxScroll
      );
      await expectCameraUnchanged(canvas, before);

      // A diagonal trackpad packet must neither pan nor train the viewport's
      // device classifier while the pointer is over the list.
      await list.getByRole('listitem').last().dispatchEvent('wheel', {
        deltaX: 5,
        deltaY: 10,
        bubbles: true,
        cancelable: true
      });
      await expectCameraUnchanged(canvas, before);
      expect(
        await page.evaluate(() =>
          localStorage.getItem('openzcad-wheel-device:v1')
        )
      ).toBeNull();

      await test.info().attach('parts-list-scrolled', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });
      // The panel opt-out must leave canvas wheel zoom working.
      const bounds = await canvas.boundingBox();
      expect(bounds).not.toBeNull();
      await page.mouse.move(
        bounds!.x + bounds!.width * 0.7,
        bounds!.y + bounds!.height * 0.6
      );
      await page.mouse.wheel(0, -120);
      await expect
        .poll(async () => orbitDistance(await cameraPose(canvas)))
        .toBeLessThan(orbitDistance(before) * 0.999);
      expect(errors).toEqual([]);
    }
  );
}
