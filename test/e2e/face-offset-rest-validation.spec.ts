import { roundedPlateDocument } from '../support/rounded-plate';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY
} from './openzcad-fixtures';

test('a resting generic face proxy reports an exact refusal before release', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    const scope = window as unknown as { previewChecks: number };
    scope.previewChecks = 0;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      const request = message as { type?: string; requestId?: string };
      if (request.type === 'preview-geometry') {
        scope.previewChecks++;
        window.setTimeout(
          () =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: {
                  type: 'preview-geometry',
                  ok: false,
                  requestId: request.requestId,
                  error: 'Resting preview test refusal'
                }
              })
            ),
          0
        );
        return;
      }
      return send.call(this, message, transfer as StructuredSerializeOptions);
    };
  });
  const { document } = await roundedPlateDocument();
  await page.goto('/');
  await page.getByRole('button', { name: 'Import project' }).click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'rest-validation.openzcad',
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
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: { normal: { x: 0, y: 0, z: -1 } }
          })
        )
      );
      return canvas.getAttribute('data-e2e-handle-x');
    })
    .not.toBeNull();
  const count = await page.locator('.feature-row').count();
  const h = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    scale: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const rect = (await canvas.boundingBox())!;
  await page.mouse.move(rect.x + h.x, rect.y + h.y);
  await page.mouse.down();
  try {
    await page.mouse.move(
      rect.x + h.x + h.dx * h.scale * 2,
      rect.y + h.y + h.dy * h.scale * 2,
      { steps: 4 }
    );
    await expect(canvas).toHaveAttribute('data-e2e-height-proxy-offset', /.+/);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { previewChecks: number }).previewChecks
        )
      )
      .toBeGreaterThan(0);
    await expect(page.getByTestId('direct-manipulation-value')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(await page.locator('.feature-row').count()).toBe(count);
  } finally {
    await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  await expect(page.locator('.feature-row')).toHaveCount(count);
});
