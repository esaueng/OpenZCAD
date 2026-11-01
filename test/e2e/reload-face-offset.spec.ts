import { roundedPlateDocument } from '../support/rounded-plate';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  createProject,
  createPrimitiveInPlace,
  MODEL_ONLY
} from './openzcad-fixtures';

test(
  'cached reload geometry cannot arm an edit; the first ready offset commits once',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => {
      const scope = window as unknown as {
        heldReloads: number;
        holdEcho: boolean;
        releaseReload(): void;
      };
      let hold = sessionStorage.getItem('hold-reload-geometry') === 'yes';
      const pending: (() => void)[] = [];
      scope.heldReloads = 0;
      scope.releaseReload = () => {
        hold = false;
        scope.holdEcho = false;
        pending.splice(0).forEach((send) => send());
      };
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (input, transfer) {
        const message = input as { type?: string; requestId?: string };
        if (
          (hold || (scope.holdEcho && !message.requestId)) &&
          message?.type === 'sync'
        ) {
          scope.heldReloads++;
          pending.push(() =>
            send.call(this, input, transfer as StructuredSerializeOptions)
          );
          return;
        }
        return send.call(this, input, transfer as StructuredSerializeOptions);
      };
    });
    const { document } = await roundedPlateDocument();
    await page.goto('/');
    await page.getByRole('button', { name: 'Import project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'reload-plate.openzcad',
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
    const select = () =>
      canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: { normal: { x: 1, y: 0, z: 0 } }
          })
        )
      );
    await expect
      .poll(async () => {
        await select();
        return canvas.getAttribute('data-e2e-handle-x');
      })
      .not.toBeNull();
    // Wait for the device save before leaving the open project.
    await expect(page.locator('.save-state')).not.toHaveText('Saving');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve, reject) => {
              const request = indexedDB.open('openzcad-v2');
              request.onerror = () =>
                reject(
                  new Error('Could not open project database', {
                    cause: request.error
                  })
                );
              request.onsuccess = () => {
                const db = request.result;
                const all = db
                  .transaction('projects', 'readonly')
                  .objectStore('projects')
                  .getAll();
                all.onerror = () => {
                  db.close();
                  reject(
                    new Error('Could not read saved projects', {
                      cause: all.error
                    })
                  );
                };
                all.onsuccess = () => {
                  db.close();
                  resolve(
                    all.result.some(
                      (doc: {
                        derived?: {
                          bodyRepresentations?: Record<
                            string,
                            { mesh?: { vertices?: { length: number } } }
                          >;
                        };
                      }) =>
                        Object.values(
                          doc.derived?.bodyRepresentations ?? {}
                        ).some((body) => (body.mesh?.vertices?.length ?? 0) > 0)
                    )
                  );
                };
              };
            })
        )
      )
      .toBe(true);
    await page.evaluate(() =>
      sessionStorage.setItem('hold-reload-geometry', 'yes')
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { heldReloads: number }).heldReloads
        )
      )
      .toBeGreaterThan(0);
    await expect(page.locator('.workspace-reveal')).toHaveClass(/is-ready/);
    await expectBodyCount(page, 1);
    await select();
    await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
    await expect(page.getByTestId('direct-manipulation-value')).toBeHidden();
    await expect(canvas).not.toHaveAttribute('data-e2e-handle-x');
    const featureCount = async () => {
      const summary = await page
        .locator('.workspace-status-summary [title]')
        .getAttribute('title');
      return Number(summary?.match(/(\d+) features?/)?.[1]);
    };
    const before = await featureCount();
    await page.evaluate(() =>
      (window as unknown as { releaseReload(): void }).releaseReload()
    );
    await expect
      .poll(async () => {
        await select();
        return canvas.getAttribute('data-e2e-handle-x');
      })
      .not.toBeNull();
    const span = () =>
      canvas.evaluate(
        (element) =>
          new Promise<number>((resolve) =>
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-render-policy', {
                detail: {
                  resolve: (state: {
                    bodyFaces: {
                      worldBounds: { min: number[]; max: number[] };
                    }[];
                  }) => {
                    const bounds = state.bodyFaces[0]!.worldBounds;
                    resolve(bounds.max[0]! - bounds.min[0]!);
                  }
                }
              })
            )
          )
      );
    const original = await span();
    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      scale: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    const rect = (await canvas.boundingBox())!;
    // A validated commit is ready even while its redundant worker echo waits.
    await page.evaluate(() => {
      (window as unknown as { holdEcho: boolean }).holdEcho = true;
    });
    await page.mouse.move(rect.x + handle.x, rect.y + handle.y);
    await page.mouse.down();
    await page.mouse.move(
      rect.x + handle.x + handle.dx * handle.scale * 6,
      rect.y + handle.y + handle.dy * handle.scale * 6,
      { steps: 6 }
    );
    const submitted = await page
      .getByTestId('direct-manipulation-value')
      .innerText();
    await page.mouse.up();
    await expect.poll(span).toBeCloseTo(original + 6, 1);
    await expect.poll(featureCount).toBe(before + 1);
    await expect(canvas).not.toHaveAttribute('data-e2e-offset-ghost');
    await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
      submitted
    );
    const committedVersion = Number(
      (
        await page
          .locator('.workspace-status-summary [title]')
          .getAttribute('title')
      )?.match(/rev (\d+)/)?.[1]
    );
    await expect
      .poll(() =>
        page.evaluate(
          (version) =>
            performance.getEntriesByName('oz:edit.frame').some((entry) => {
              const detail = (entry as PerformanceMeasure).detail as {
                version?: number;
                analysis?: string;
              } | null;
              return (
                detail?.version !== undefined &&
                detail.version === version &&
                detail.analysis === 'ready'
              );
            }),
          committedVersion
        )
      )
      .toBe(true);
    await page.evaluate(() =>
      (window as unknown as { releaseReload(): void }).releaseReload()
    );
    await select();
    await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
      submitted
    );
    await page.evaluate(() =>
      sessionStorage.removeItem('hold-reload-geometry')
    );
    await page.reload();
    await expect
      .poll(async () => {
        await select();
        return canvas.getAttribute('data-e2e-handle-x');
      })
      .not.toBeNull();
    await expect.poll(span).toBeCloseTo(original + 6, 1);
    await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
      submitted
    );
    await expect.poll(featureCount).toBe(before + 1);
    await test.info().attach('first-ready-offset', {
      body: await page.screenshot({
        path: test.info().outputPath('first-ready-offset.png')
      }),
      contentType: 'image/png'
    });
  }
);

test(
  'operation instructions remain readable on desktop and phone',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.goto('/');
    await createProject(page, 'Operation instructions');
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    await page.keyboard.press('Escape');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const help = page.getByLabel('Operation instructions', { exact: true });
      await expect(help).toBeVisible({ timeout: 15_000 });
      await help.click();
      const instructions = page.locator('.workspace-hint-help[open] > p');
      await expect(instructions).toBeVisible();
      const geometry = await instructions.evaluate((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        width: window.innerWidth,
        overflow: element.scrollWidth > element.clientWidth + 1,
        unobscured: element.contains(
          document.elementFromPoint(
            element.getBoundingClientRect().left + element.clientWidth / 2,
            element.getBoundingClientRect().top + element.clientHeight / 2
          )
        )
      }));
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.width);
      expect(geometry.overflow).toBe(false);
      expect(geometry.unobscured).toBe(true);
      await test.info().attach(`instructions-${width}`, {
        body: await page.screenshot({
          path: test.info().outputPath(`instructions-${width}.png`)
        }),
        contentType: 'image/png'
      });
      await help.focus();
      await page.keyboard.press('Escape');
      await expect(page.locator('.workspace-hint-help')).not.toHaveAttribute(
        'open'
      );
    }
  }
);
