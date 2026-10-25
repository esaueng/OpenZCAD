import type { Locator } from '@playwright/test';
import type { ViewportCameraState } from '@openzcad/viewport';
import { steppedCylinderDocument } from '../support/stepped-cylinder';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY,
  modelPanel,
  railPanelButton,
  revealModelPanel
} from './openzcad-fixtures';

/**
 * The history's length, read from History opened for the purpose and closed
 * again. Nothing is docked in these tests: the selection's inspector stands
 * inside a docked column's lane, over the rod's arrow.
 */
async function expectHistoryLength(page: Page, count: number) {
  await revealModelPanel(page, 'History');
  await expect(page.locator('.feature-row')).toHaveCount(count);
  await railPanelButton(page, 'History').click();
  await expect(modelPanel(page, 'History')).toHaveCount(0);
}

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

async function settledCamera(canvas: Locator) {
  let previous = await camera(canvas);
  await expect
    .poll(
      async () => {
        await canvas.page().waitForTimeout(150);
        const next = await camera(canvas);
        const settled = JSON.stringify(next) === JSON.stringify(previous);
        previous = next;
        return settled;
      },
      { intervals: [200], timeout: 10_000 }
    )
    .toBe(true);
  return previous;
}

function expectSameCamera(
  actual: ViewportCameraState,
  expected: ViewportCameraState
) {
  // OrbitControls reprojects its spherical pose on geometry frames. Ignore
  // round-off below 1e-8 world units while catching any visible camera motion.
  for (const field of ['position', 'target'] as const) {
    actual[field].forEach((value, axis) =>
      expect(value).toBeCloseTo(expected[field][axis]!, 8)
    );
  }
  expect(actual.orthographicZoom).toBeCloseTo(expected.orthographicZoom, 10);
  expect(actual.orthographicHalfHeight).toBeCloseTo(
    expected.orthographicHalfHeight!,
    8
  );
}

for (const projection of ['perspective', 'orthographic'] as const) {
  test(`extending an imported rod preserves its ${projection} view on drag and numeric commit`, async ({
    page
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { document } = await steppedCylinderDocument();
    await page.goto('/');
    await expect(page).toHaveTitle(/OpenZCAD/);
    await page.getByRole('button', { name: 'Import project…' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'rod.openzcad',
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
    await settledCamera(canvas);
    if (projection === 'orthographic') await page.keyboard.press('p');

    // Choose a view, pan, and zoom before editing. The enlarged result will
    // leave the canvas, which used to trigger an automatic fit on commit.
    await page.getByRole('button', { name: 'Standard views' }).click();
    await page.getByRole('button', { name: 'Front view (1)' }).click();
    await settledCamera(canvas);
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width * 0.5,
      bounds.y + bounds.height * 0.5
    );
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(
      bounds.x + bounds.width * 0.5 + 45,
      bounds.y + bounds.height * 0.5 + 30,
      { steps: 5 }
    );
    await page.mouse.up({ button: 'middle' });
    await page.mouse.wheel(0, -150);
    await expect(canvas).toHaveAttribute('data-e2e-zoom-active', 'true');
    await expect(canvas).toHaveAttribute('data-e2e-zoom-active', 'false');
    await settledCamera(canvas);

    const selectCap = async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: { normal: { x: 0, y: 0, z: 1 } }
          })
        )
      );
      await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
    };
    const extent = () =>
      canvas.evaluate(
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
                        ...state.bodyFaces.map(
                          (face) => face.worldBounds.max[2]!
                        )
                      )
                    )
                }
              })
            );
          })
      );
    const inView = () =>
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
      );

    await selectCap();
    const before = await settledCamera(canvas);
    const originalExtent = await extent();
    await testInfo.attach('before-extension', {
      body: await page.screenshot({
        path: testInfo.outputPath('before-extension.png')
      }),
      contentType: 'image/png'
    });
    // The chip reads the whole span by default; this types the change.
    await page.getByTestId('direct-manipulation-mode').click();
    await expect(page.getByTestId('direct-manipulation-mode')).toHaveText(
      /^Offset/
    );
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Offset value' });
    // Extend far beyond the current framing using the actual numeric editor.
    await keypad.getByRole('textbox').fill('250');
    await keypad.getByRole('button', { name: 'Apply offset' }).click();
    await expectHistoryLength(page, 2);
    await expect
      .poll(extent, { timeout: 30_000 })
      .toBeGreaterThan(originalExtent + 100);
    // Allow the commit's former automatic camera tween to finish before
    // comparing all pose fields, including both orthographic zoom fields.
    await page.waitForTimeout(900);
    expectSameCamera(await camera(canvas), before);
    expect(await inView()).toBe(false);
    await testInfo.attach('extended-rod-view', {
      body: await page.screenshot({
        path: testInfo.outputPath('extended-rod-view.png')
      }),
      contentType: 'image/png'
    });

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(extent).toBeCloseTo(originalExtent, 3);
    await selectCap();
    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy)
    }));
    await page.mouse.move(bounds.x + handle.x, bounds.y + handle.y);
    await page.mouse.down();
    const beforeDrag = await camera(canvas);
    await page.mouse.move(
      bounds.x + handle.x + handle.dx * 220,
      bounds.y + handle.y + handle.dy * 220,
      { steps: 8 }
    );
    await page.mouse.up();
    await expectHistoryLength(page, 2);
    await expect
      .poll(extent, { timeout: 30_000 })
      .toBeGreaterThan(originalExtent + 1);
    await page.waitForTimeout(900);
    expectSameCamera(await camera(canvas), beforeDrag);

    // Explicit Fit still works and retains the selected viewing direction.
    await page.keyboard.press('Escape');
    await page.keyboard.press('f');
    await expect.poll(inView).toBe(true);
    expect(await settledCamera(canvas)).not.toEqual(beforeDrag);
    expect(errors).toEqual([]);
  });
}
