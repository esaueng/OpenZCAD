import { withoutDerivedProjection } from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { filletedUnion, longFilletedUnion } from '../support/filleted-union';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

for (const longHistory of [false, true])
  test(
    `resizes a filleted union end${longHistory ? ' after a long history' : ''} with Total entry, undo, redo and reload`,
    { tag: '@ci-smoke' },
    async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const adapter = await createExactKernelAdapter();
      let backup: Buffer;
      try {
        const { document } = await (longHistory
          ? longFilletedUnion(adapter)
          : filletedUnion(adapter));
        backup = Buffer.from(
          JSON.stringify({
            format: 'openzcad-project',
            version: 1,
            document: withoutDerivedProjection(document),
            files: []
          })
        );
      } finally {
        adapter.dispose();
      }
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await stubApi(page);
      await page.addInitScript(() => {
        const scope = window as typeof window & {
          offsetPreviewRequests: number;
        };
        scope.offsetPreviewRequests = 0;
        const send = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, transfer) {
          if (
            (message as { type?: string } | null)?.type === 'preview-geometry'
          )
            scope.offsetPreviewRequests += 1;
          return send.call(
            this,
            message,
            transfer as StructuredSerializeOptions
          );
        };
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto('/');
      await expect(page).toHaveTitle('OpenZCAD');
      await page.getByLabel('Project name').fill('Face resize browser test');
      await page.getByRole('button', { name: 'New project' }).click();
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'filleted-union.openzcad',
        mimeType: 'application/json',
        buffer: backup
      });
      const canvas = page.locator('.viewer-host canvas');
      const endX = () =>
        canvas.evaluate((element) => {
          let x: number | null = null;
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-render-policy', {
              detail: {
                resolve: (state: {
                  bodyFaces: {
                    visible: boolean;
                    worldBounds?: { max: number[] };
                  }[];
                }) => {
                  const bounds = state.bodyFaces.filter(
                    (f) => f.visible && f.worldBounds
                  );
                  if (bounds.length)
                    x = Math.max(...bounds.map((f) => f.worldBounds!.max[0]!));
                }
              }
            })
          );
          return x;
        });
      await expect.poll(endX, { timeout: 30_000 }).toBeCloseTo(30, 4);
      await expectBodyCount(page, 1);
      await expect
        .poll(() =>
          canvas.evaluate((element) => {
            let name: string | null = null;
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: {
                  normal: { x: 1, y: 0, z: 0 },
                  resolve: (pick: { lineageName?: string } | null) => {
                    name = pick?.lineageName ?? null;
                  }
                }
              })
            );
            return name;
          })
        )
        .toBe('boolean.face.operand.1.primitive.box.face.x-max');
      await expect(
        page.getByRole('region', { name: 'Resize Body operation' })
      ).toBeVisible();
      await expect(page.getByTestId('direct-manipulation-value')).toContainText(
        '30'
      );
      const featuresBeforeDrag = await page.locator('.feature-row').count();
      const handle = await canvas.evaluate((element) => ({
        x: Number(element.dataset.e2eHandleX),
        y: Number(element.dataset.e2eHandleY),
        dx: Number(element.dataset.e2eHandleDx),
        dy: Number(element.dataset.e2eHandleDy),
        scale: Number(element.dataset.e2eHandlePixelsPerUnit)
      }));
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + handle.x, box.y + handle.y);
      await page.mouse.down();
      await page.keyboard.down('Shift');
      for (const delta of [2, 5, -2, 3]) {
        await page.mouse.move(
          box.x + handle.x + handle.dx * handle.scale * delta,
          box.y + handle.y + handle.dy * handle.scale * delta
        );
        await expect.poll(() => endX()).toBeCloseTo(30 + delta, 2);
        await expect(canvas).toHaveAttribute(
          'data-e2e-height-proxy-offset',
          /.+/
        );
      }
      // Motion changes the whole displayed part without replaying history or
      // posting a kernel request. Escape restores the original geometry/history.
      expect(
        await page.evaluate(
          () =>
            (window as typeof window & { offsetPreviewRequests: number })
              .offsetPreviewRequests
        )
      ).toBe(0);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await expect.poll(endX).toBeCloseTo(30, 4);
      await expect(page.locator('.feature-row')).toHaveCount(
        featuresBeforeDrag
      );
      await page.getByTestId('direct-manipulation-value').click();
      const keypad = page.getByRole('dialog', { name: 'Total value' });
      await keypad.getByRole('textbox').fill('35.59');
      await expect.poll(endX, { timeout: 30_000 }).toBeCloseTo(35.59, 4);
      await keypad.getByRole('button', { name: 'Apply total' }).click();
      await expect(page.getByRole('contentinfo')).toContainText(
        'width set to 35.59 mm'
      );
      await expect(page.getByRole('contentinfo')).toContainText('warnings0');
      await expect.poll(endX).toBeCloseTo(35.59, 4);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(endX, { timeout: 30_000 }).toBeCloseTo(30, 4);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect.poll(endX, { timeout: 30_000 }).toBeCloseTo(35.59, 4);
      // Wait for the committed source dimension in device storage before reload.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              new Promise<number | null>((resolve, reject) => {
                const request = indexedDB.open('openzcad-v2');
                request.onerror = () =>
                  reject(new Error('Could not read saved projects.'));
                request.onsuccess = () => {
                  const db = request.result;
                  const read = db
                    .transaction('projects', 'readonly')
                    .objectStore('projects')
                    .getAll();
                  read.onerror = () => {
                    db.close();
                    reject(new Error('Could not read saved projects.'));
                  };
                  read.onsuccess = () => {
                    db.close();
                    const project = (read.result as ProjectDocument[]).find(
                      (p) => p.name === 'Filleted union'
                    );
                    const box = Object.values(project?.nodes ?? {}).find(
                      (n: unknown) =>
                        (n as { data?: { primitiveKind?: string } }).data
                          ?.primitiveKind === 'box'
                    ) as
                      { data: { dimensions: { width: number } } } | undefined;
                    resolve(box?.data.dimensions.width ?? null);
                  };
                };
              })
          )
        )
        .toBeCloseTo(35.59, 7);
      await page.reload();
      await expect.poll(endX, { timeout: 30_000 }).toBeCloseTo(35.59, 4);
      await expectBodyCount(page, 1);
      await expect(page.getByRole('contentinfo')).toContainText('warnings0');
      await expect(
        page.locator('.feature-row-main', { hasText: 'Junction fillet' })
      ).toHaveCount(1);
      await page.screenshot({
        path: testInfo.outputPath('filleted-union-resized.png')
      });
      expect(errors).toEqual([]);
    }
  );
