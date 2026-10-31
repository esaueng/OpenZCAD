import type { Locator } from '@playwright/test';
import { spurGearDocument } from '../support/spur-gear';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY,
  waitForStillViewport
} from './openzcad-fixtures';

interface PreviewWindow extends Window {
  editSyncs: number;
  holdEdit: boolean;
  releaseEdit(): void;
}

const rendered = (canvas: Locator) =>
  canvas.evaluate(
    (element) =>
      new Promise<{ min: number[]; max: number[] }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                bodyFaces: { worldBounds: { min: number[]; max: number[] } }[];
              }) => resolve(state.bodyFaces[0]!.worldBounds)
            }
          })
        );
      })
  );

test(
  'gear height follows repeated drag reversals without exact worker previews',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.route('**/api/session', (route) =>
      route.fulfill({
        status: 401,
        json: { error: 'Authentication required.', code: 'AUTH_REQUIRED' }
      })
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => {
      const scope = window as unknown as PreviewWindow;
      scope.editSyncs = 0;
      const pending: (() => void)[] = [];
      scope.releaseEdit = () => {
        scope.holdEdit = false;
        pending.splice(0).forEach((send) => send());
      };
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, transfer) {
        if ((message as { type?: string })?.type === 'sync') {
          scope.editSyncs++;
          if (scope.holdEdit) {
            pending.push(() =>
              send.call(this, message, transfer as StructuredSerializeOptions)
            );
            return;
          }
        }
        return send.call(this, message, transfer as StructuredSerializeOptions);
      };
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const document = await spurGearDocument();
    await page.goto('/');
    await page.getByRole('button', { name: 'Import project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'gear.openzcad',
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
    await page.keyboard.press('f');
    await waitForStillViewport(page);
    await expect
      .poll(async () => {
        await canvas.evaluate((element) =>
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-planar-face', {
              detail: { normal: { x: 0, y: 0, z: 1 } }
            })
          )
        );
        return canvas.getAttribute('data-e2e-handle-x');
      })
      .not.toBeNull();
    const chip = page.getByTestId('direct-manipulation-value');
    await expect(chip).toContainText('26');
    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      scale: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    const rect = (await canvas.boundingBox())!;
    const syncs = () =>
      page.evaluate(() => (window as unknown as PreviewWindow).editSyncs);
    const before = await syncs();
    await page.mouse.move(rect.x + handle.x, rect.y + handle.y);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    for (const height of [36, 76, 31, 56, 16, 26]) {
      await page.mouse.move(
        rect.x + handle.x + handle.dx * handle.scale * (height - 26),
        rect.y + handle.y + handle.dy * handle.scale * (height - 26),
        { steps: 4 }
      );
      await expect(canvas).toHaveAttribute(
        'data-e2e-height-proxy-offset',
        String(height - 26)
      );
      const offset = Number(
        await canvas.getAttribute('data-e2e-height-proxy-offset')
      );
      await expect
        .poll(async () => (await rendered(canvas)).max[2]!)
        .toBeCloseTo(26 + offset, 2);
      await expect(chip).toContainText(String(26 + offset));
      await expect(chip).toHaveAttribute('data-variant', 'pin');
      expect((await rendered(canvas)).min[2]).toBeCloseTo(0, 2);
      if (height === 76)
        await page.screenshot({
          path: test.info().outputPath('gear-76mm-preview.png')
        });
    }
    expect(await syncs()).toBe(before);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');
    await expect
      .poll(async () => (await rendered(canvas)).max[2]!)
      .toBeCloseTo(26, 2);

    let currentHeight = 26;
    for (const height of [56, 26]) {
      await expect
        .poll(async () => {
          await canvas.evaluate((element) =>
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: { normal: { x: 0, y: 0, z: 1 } }
              })
            )
          );
          return canvas.getAttribute('data-e2e-handle-x');
        })
        .not.toBeNull();
      const h = await canvas.evaluate((element) => ({
        x: Number(element.dataset.e2eHandleX),
        y: Number(element.dataset.e2eHandleY),
        dx: Number(element.dataset.e2eHandleDx),
        dy: Number(element.dataset.e2eHandleDy),
        scale: Number(element.dataset.e2eHandlePixelsPerUnit)
      }));
      await page.mouse.move(rect.x + h.x, rect.y + h.y);
      await page.mouse.down();
      await page.keyboard.down('Shift');
      await page.mouse.move(
        rect.x + h.x + h.dx * h.scale * (height - currentHeight),
        rect.y + h.y + h.dy * h.scale * (height - currentHeight),
        { steps: 4 }
      );
      await expect(canvas).toHaveAttribute(
        'data-e2e-height-proxy-offset',
        String(height - currentHeight)
      );
      const count = await syncs();
      await page.evaluate(() => {
        (window as unknown as PreviewWindow).holdEdit = true;
      });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await expect.poll(syncs).toBe(count + 1);
      await expect(
        page.getByRole('status', { name: 'Checking', exact: true })
      ).toBeVisible();
      if (height === 26)
        await page.screenshot({
          path: test.info().outputPath('gear-26mm-validating.png')
        });
      expect((await rendered(canvas)).max[2]).toBeCloseTo(height, 2);
      const releasedAt = Date.now();
      await page.evaluate(() =>
        (window as unknown as PreviewWindow).releaseEdit()
      );
      await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');
      await expect
        .poll(async () => (await rendered(canvas)).max[2]!)
        .toBeCloseTo(height, 2);
      await expect(chip).toContainText(String(height));
      await expect(canvas).not.toHaveAttribute('data-e2e-offset-ghost');
      await expect(
        page.getByRole('status', { name: 'Local only', exact: true })
      ).toBeVisible();
      await test.info().attach(`gear-${height}mm-validation-ms`, {
        body: String(Date.now() - releasedAt),
        contentType: 'text/plain'
      });
      currentHeight = height;
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(async () => (await rendered(canvas)).max[2]!)
      .toBeCloseTo(56, 2);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect
      .poll(async () => (await rendered(canvas)).max[2]!)
      .toBeCloseTo(26, 2);
    await page.reload();
    await expectBodyCount(page, 1);
    await expect
      .poll(async () => (await rendered(canvas)).max[2]!)
      .toBeCloseTo(26, 2);
    await page.screenshot({
      path: test.info().outputPath('gear-26mm-after-reload.png')
    });
    expect(errors).toEqual([]);
  }
);
