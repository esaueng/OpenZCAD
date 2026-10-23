import type { Locator } from '@playwright/test';
import type { ViewportCameraState } from '@openzcad/viewport';
import { roundedPlateDocument } from '../support/rounded-plate';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY
} from './openzcad-fixtures';

function camera(canvas: Locator): Promise<ViewportCameraState> {
  return canvas.evaluate(
    (element) =>
      new Promise<ViewportCameraState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-input-state', {
            detail: {
              resolve: (state: { camera: ViewportCameraState }) =>
                resolve(state.camera)
            }
          })
        );
      })
  );
}

function maxX(canvas: Locator): Promise<number> {
  return canvas.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                bodyFaces: { worldBounds: { max: number[] } }[];
              }) =>
                resolve(
                  Math.max(
                    ...state.bodyFaces.map((face) => face.worldBounds.max[0]!)
                  )
                )
            }
          })
        );
      })
  );
}

test('a generic imported side drags the whole body and stays selected after the commit', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { document } = await roundedPlateDocument();
  await page.goto('/');
  await page.getByRole('button', { name: 'Import project…' }).click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'plate.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: []
      })
    )
  });
  await expectBodyCount(page, 1);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-camera-distance', /.+/);
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: { normal: { x: 1, y: 0, z: 0 } }
          })
        )
      );
      return canvas.getAttribute('data-e2e-handle-x');
    })
    .not.toBeNull();
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    perUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const before = await camera(canvas);
  expect(await maxX(canvas)).toBeCloseTo(80, 3);

  // The 80 mm side meets R5 corner rounds and a top with a hole in it: no
  // primitive or cap profile applies, and the whole body still follows.
  const box = (await canvas.boundingBox())!;
  const start = { x: box.x + handle.x, y: box.y + handle.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(
      start.x + handle.dx * handle.perUnit * step,
      start.y + handle.dy * handle.perUnit * step
    );
  }
  await expect
    .poll(async () =>
      Number(await canvas.getAttribute('data-e2e-height-proxy-offset'))
    )
    .toBeGreaterThan(10);
  // The body itself carries the extension, rounds and all, before release.
  await expect.poll(() => maxX(canvas)).toBeGreaterThan(90);
  const dragged = Number(
    await canvas.getAttribute('data-e2e-height-proxy-offset')
  );
  await page.mouse.up();

  await expect(page.getByText('Offset face by', { exact: false })).toBeVisible({
    timeout: 30_000
  });
  await expect.poll(() => maxX(canvas)).toBeCloseTo(80 + dragged, 3);
  // The moved face is still the selection, armed for another drag, rather
  // than a whole-body selection offering Move.
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  await expect(
    page.getByRole('button', { name: 'Move', exact: true })
  ).toHaveCount(0);
  const after = await camera(canvas);
  for (const field of ['position', 'target'] as const)
    after[field].forEach((value, axis) =>
      expect(value).toBeCloseTo(before[field][axis]!, 6)
    );
});
