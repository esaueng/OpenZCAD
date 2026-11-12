import { withoutDerivedProjection } from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { filletedUnion, longFilletedUnion } from '../support/filleted-union';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  waitForStillViewport
} from './openzcad-fixtures';

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
      expect(featuresBeforeDrag).toBeGreaterThan(0);
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
        // A resting exact check may already have replaced the viewport proxy.
        // Geometry and document history are the contract for either preview.
        await expect(page.locator('.feature-row')).toHaveCount(
          featuresBeforeDrag
        );
      }
      // The proxy changes the displayed part without replaying history. Once
      // motion rests, exact validation checks that the result can be committed.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { offsetPreviewRequests: number })
                .offsetPreviewRequests
          )
        )
        .toBeGreaterThan(0);
      await expect(page.locator('.feature-row')).toHaveCount(
        featuresBeforeDrag
      );
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
      // The one warning is the junction band's approximate-surface disclosure.
      await expect(page.getByRole('contentinfo')).toContainText(
        /warnings1(?!\d)/
      );
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
      // Cached display geometry can appear before the restored history has
      // finished checking. Export readiness proves the current exact build.
      const fileMenu = page.locator('details.file-menu');
      await fileMenu.locator('summary').click();
      await expect(
        fileMenu.getByRole('button', { name: /^Export STEP/ })
      ).toBeEnabled({ timeout: 120_000 });
      await page.keyboard.press('Escape');
      // The one warning is the junction band's approximate-surface disclosure.
      await expect(page.getByRole('contentinfo')).toContainText(
        /warnings1(?!\d)/
      );
      await expect(
        page.locator('.feature-row-main', { hasText: 'Junction fillet' })
      ).toHaveCount(1);
      await page.screenshot({
        path: testInfo.outputPath('filleted-union-resized.png')
      });
      expect(errors).toEqual([]);
    }
  );

declare global {
  interface Window {
    __resizeCommitFrames?: { viewportChip: number; readoutless: number };
    /** Live-document syncs posted to the geometry worker (no request id). */
    __liveSyncs?: number;
    /** While set, edit validations (tagged syncs) wait in `__heldChecks`. */
    __holdChecks?: boolean;
    __heldChecks?: (() => void)[];
  }
}

test(
  'a filleted union side resized by drag keeps its pick and never lights the viewport chip',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const adapter = await createExactKernelAdapter();
    let backup: Buffer;
    try {
      const { document } = await filletedUnion(adapter);
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
    await stubApi(page);
    await page.addInitScript(() => {
      window.__liveSyncs = 0;
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, transfer) {
        const posted = message as { type?: string; requestId?: string } | null;
        if (posted?.type === 'sync' && posted.requestId === undefined)
          window.__liveSyncs! += 1;
        return send.call(this, message, transfer as StructuredSerializeOptions);
      };
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Resize commit chip');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'filleted-union.openzcad',
      mimeType: 'application/json',
      buffer: backup
    });
    const canvas = page.locator('.viewer-host canvas');
    await expect
      .poll(
        () =>
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
          }),
        { timeout: 60_000 }
      )
      .toBe('boolean.face.operand.1.primitive.box.face.x-max');
    const card = page.getByRole('region', { name: 'Resize Body operation' });
    await expect(card).toBeVisible();
    const readout = page.locator('.selection-readout');
    await expect(readout).toContainText('Right face');
    // The bar names the pick and the rail carries its verbs, so the viewport
    // chip (name, verbs, phase) must not appear on any frame. A commit that
    // dropped the pick lit the validating frame's chip over the model for
    // the frames the dense body took to prepare, and took the readout away.
    await page.evaluate(() => {
      const frames = { viewportChip: 0, readoutless: 0 };
      window.__resizeCommitFrames = frames;
      const sample = () => {
        if (
          document.querySelector(
            '.viewer-host .selection-callout.selection-callout-chip'
          )
        )
          frames.viewportChip += 1;
        if (!document.querySelector('.selection-readout'))
          frames.readoutless += 1;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const value = page.getByTestId('direct-manipulation-value');
    const readHandle = () =>
      canvas.evaluate((element) => ({
        x: Number(element.dataset.e2eHandleX),
        y: Number(element.dataset.e2eHandleY),
        dx: Number(element.dataset.e2eHandleDx),
        dy: Number(element.dataset.e2eHandleDy),
        scale: Number(element.dataset.e2eHandlePixelsPerUnit)
      }));
    const contentinfo = page.getByRole('contentinfo');
    const drag = async (from: number, delta: number) => {
      // The re-armed handle, on the moved side and at rest.
      await expect(value).toContainText(String(from));
      await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
      await waitForStillViewport(page);
      const handle = await readHandle();
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + handle.x, box.y + handle.y);
      await page.mouse.down();
      await page.mouse.move(
        box.x + handle.x + handle.dx * handle.scale * delta,
        box.y + handle.y + handle.dy * handle.scale * delta,
        { steps: 12 }
      );
      // Released once the drag reads its target, as a hand would.
      await expect(value).toContainText(String(from + delta));
      const liveSyncs = await page.evaluate(() => window.__liveSyncs);
      await page.mouse.up();
      return liveSyncs;
    };
    // The release check builds exactly what the live document needs, so the
    // commit adopts it: no second rebuild of the same edit follows it.
    const expectNoRebuildAfter = async (liveSyncs: number | undefined) =>
      expect(await page.evaluate(() => window.__liveSyncs)).toBe(liveSyncs);
    const firstRelease = await drag(30, -7);
    await expect(contentinfo).toContainText('width set to 23 mm', {
      timeout: 30_000
    });
    await expect(contentinfo).not.toContainText('Rebuilding geometry', {
      timeout: 30_000
    });
    await expectNoRebuildAfter(firstRelease);
    // Still the moved side, re-armed on the same width for the next drag.
    await expect(card).toBeVisible();
    await expect(readout).toContainText('Right face');
    const secondRelease = await drag(23, -3);
    await expect(contentinfo).toContainText('width set to 20 mm', {
      timeout: 30_000
    });
    await expect(contentinfo).not.toContainText('Rebuilding geometry', {
      timeout: 30_000
    });
    await page.waitForTimeout(500);
    await expectNoRebuildAfter(secondRelease);
    await expect(card).toBeVisible();
    await expect(readout).toContainText('Right face');
    expect(await page.evaluate(() => window.__resizeCommitFrames)).toEqual({
      viewportChip: 0,
      readoutless: 0
    });
  }
);

test(
  'a side taken again while its release validates lands once, where the hand last let go',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const adapter = await createExactKernelAdapter();
    let backup: Buffer;
    try {
      const { document } = await filletedUnion(adapter);
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
    await stubApi(page);
    // Holds each release's exact check in the page, so the hand provably
    // takes the handle again before that check has answered.
    await page.addInitScript(() => {
      window.__heldChecks = [];
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, transfer) {
        const posted = message as { type?: string; requestId?: string } | null;
        const forward = () =>
          send.call(this, message, transfer as StructuredSerializeOptions);
        if (
          window.__holdChecks &&
          posted?.type === 'sync' &&
          posted.requestId !== undefined
        ) {
          window.__heldChecks!.push(forward);
          return;
        }
        return forward();
      };
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Retaken release');
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
    const pickSide = () =>
      expect
        .poll(
          () =>
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
            }),
          { timeout: 60_000 }
        )
        .toBe('boolean.face.operand.1.primitive.box.face.x-max');
    await expect.poll(endX, { timeout: 30_000 }).toBeCloseTo(30, 4);
    await pickSide();
    const value = page.getByTestId('direct-manipulation-value');
    const contentinfo = page.getByRole('contentinfo');
    const heldChecks = () => page.evaluate(() => window.__heldChecks!.length);
    const answerChecks = () =>
      page.evaluate(() => {
        window.__holdChecks = false;
        for (const forward of window.__heldChecks!.splice(0)) forward();
      });
    /**
     * Presses the handle where it is drawn and drags it by `delta`. A handle
     * whose release is still being checked is pressed where it was let go:
     * the viewport keeps drawing that check, so it is never still.
     */
    const press = async (from: number, delta: number, checking = false) => {
      await expect(value).toContainText(String(from));
      await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
      if (!checking) await waitForStillViewport(page);
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
      await page.mouse.move(
        box.x + handle.x + handle.dx * handle.scale * delta,
        box.y + handle.y + handle.dy * handle.scale * delta,
        { steps: 12 }
      );
      await expect(value).toContainText(String(from + delta));
    };

    // Let go at 23 while its check is held, then take the handle again
    // before that check answers, and let go at 20.
    await page.evaluate(() => {
      window.__holdChecks = true;
    });
    await press(30, -7);
    await page.mouse.up();
    await expect.poll(heldChecks).toBe(1);
    await press(23, -3, true);
    await page.mouse.up();
    await expect.poll(heldChecks).toBe(2);
    await answerChecks();
    await expect(contentinfo).toContainText('width set to 20 mm', {
      timeout: 30_000
    });
    await expect.poll(endX, { timeout: 30_000 }).toBeCloseTo(20, 4);
    // One edit, not 23 then 20: a single undo returns to the start.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(endX, { timeout: 30_000 }).toBeCloseTo(30, 4);
    await expect(
      page.getByRole('button', { name: 'Undo', exact: true })
    ).toBeDisabled();

    // Abandoning the retaken drag lands the release it set aside, from that
    // release's own check: no second one is asked for.
    await pickSide();
    await page.evaluate(() => {
      window.__holdChecks = true;
    });
    await press(30, -7);
    await page.mouse.up();
    await expect.poll(heldChecks).toBe(1);
    await press(23, -3, true);
    await page.keyboard.press('Escape');
    await answerChecks();
    await expect(contentinfo).toContainText('width set to 23 mm', {
      timeout: 30_000
    });
    await expect.poll(endX, { timeout: 30_000 }).toBeCloseTo(23, 4);
    expect(await heldChecks()).toBe(0);
  }
);
