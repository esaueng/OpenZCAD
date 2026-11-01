import { addDatumPlane, listFeaturesInOrder } from '@openzcad/document-core';
import { FEATURE_SUPPRESSED_METADATA_KEY } from '@openzcad/shared';
import { roundedPlateDocument } from '../support/rounded-plate';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  modelPanel
} from './openzcad-fixtures';

test(
  'local face edits follow history while older reading keeps its place',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    let { document } = await roundedPlateDocument();
    // Suppressed reference steps create a long history without altering the solid.
    for (let index = 1; index <= 40; index++) {
      document = addDatumPlane(document, {
        name: `Reference ${index}`,
        definition: {
          kind: 'offset',
          source: { type: 'canonical', plane: 'XY', offset: 0 },
          offset: index
        }
      }).document;
      listFeaturesInOrder(document).at(-1)!.metadata = {
        [FEATURE_SUPPRESSED_METADATA_KEY]: true
      };
    }
    await page.goto('/');
    await page.getByRole('button', { name: 'Import project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'history-follow.openzcad',
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
    const panel = modelPanel(page, 'History');
    const host = panel.locator('.model-panel-body');
    const rows = panel.locator('.feature-row');
    await expect(rows).toHaveCount(41);
    await expect
      .poll(() => host.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    const canvas = page.locator('.viewer-host canvas');
    const arm = async () => {
      await expect
        .poll(async () => {
          await canvas.evaluate((el) =>
            el.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: { normal: { x: 1, y: 0, z: 0 } }
              })
            )
          );
          return canvas.getAttribute('data-e2e-handle-x');
        })
        .not.toBeNull();
    };
    const span = () =>
      canvas.evaluate(
        (el) =>
          new Promise<number>((resolve) =>
            el.dispatchEvent(
              new CustomEvent('openzcad:e2e-render-policy', {
                detail: {
                  resolve: (state: {
                    bodyFaces: {
                      worldBounds: { min: number[]; max: number[] };
                    }[];
                  }) => {
                    const box = state.bodyFaces[0]!.worldBounds;
                    resolve(box.max[0]! - box.min[0]!);
                  }
                }
              })
            )
          )
      );
    const drag = async () => {
      const handle = await canvas.evaluate((el) => ({
        x: Number(el.dataset.e2eHandleX),
        y: Number(el.dataset.e2eHandleY),
        dx: Number(el.dataset.e2eHandleDx),
        dy: Number(el.dataset.e2eHandleDy),
        scale: Number(el.dataset.e2eHandlePixelsPerUnit)
      }));
      const bounds = (await canvas.boundingBox())!;
      await page.mouse.move(bounds.x + handle.x, bounds.y + handle.y);
      await page.mouse.down();
      await page.mouse.move(
        bounds.x + handle.x + handle.dx * handle.scale * 4,
        bounds.y + handle.y + handle.dy * handle.scale * 4,
        { steps: 8 }
      );
      await page.mouse.up();
    };
    const inside = async () => {
      const a = (await rows.last().boundingBox())!;
      const b = (await host.boundingBox())!;
      return a.y >= b.y && a.y + a.height <= b.y + b.height;
    };
    await arm();
    await drag();
    await expect(rows).toHaveCount(42);
    await expect.poll(span).toBeCloseTo(84, 1);
    await expect.poll(inside).toBe(true);
    await page.screenshot({
      path: test.info().outputPath('history-following.png')
    });
    await arm();
    const bounds = (await host.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    );
    await page.mouse.wheel(0, -300);
    await expect.poll(inside).toBe(false);
    const before = await host.evaluate((el) => el.scrollTop);
    await drag();
    await expect(rows).toHaveCount(43);
    await expect.poll(span).toBeCloseTo(88, 1);
    await expect
      .poll(() => host.evaluate((el) => el.scrollTop))
      .toBeCloseTo(before, 0);
    const notice = panel.getByRole('button', { name: /Show new operation:/ });
    await expect(notice).toBeVisible();
    const noticeBox = (await notice.boundingBox())!;
    const hostBox = (await host.boundingBox())!;
    expect(noticeBox.y).toBeGreaterThanOrEqual(hostBox.y);
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(
      hostBox.y + hostBox.height
    );
    await page.screenshot({
      path: test.info().outputPath('history-reading-older.png')
    });
    const selection = () =>
      panel
        .locator('.feature-row.selected')
        .evaluateAll((elements) =>
          elements.map((el) => el.getAttribute('data-node-id'))
        );
    const selected = await selection();
    await notice.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Total value' })).toHaveCount(
      0
    );
    await expect.poll(inside).toBe(true);
    expect(await selection()).toEqual(selected);
    await expect(
      panel.getByRole('button', { name: /Show new operation:/ })
    ).toHaveCount(0);
    // The untouched Total prefill is a cancel/no-op, not another history arrival.
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Total value' });
    await keypad.getByRole('button', { name: 'Apply total' }).click();
    await expect(keypad).toBeHidden();
    await expect(rows).toHaveCount(43);
    await expect(
      panel.getByRole('button', { name: /Show new operation:/ })
    ).toHaveCount(0);
    // Explicit reveal resumes following subsequent local operations.
    await arm();
    await drag();
    await expect(rows).toHaveCount(44);
    await expect.poll(span).toBeCloseTo(92, 1);
    await expect.poll(inside).toBe(true);
    await expect(
      panel.getByRole('button', { name: /Show new operation:/ })
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  }
);
