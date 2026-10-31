import {
  createProjectDocument,
  gearBody,
  addSketchFeature,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { writeFile } from 'node:fs/promises';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  expectBodyCount,
  waitForStillViewport
} from './openzcad-fixtures';

interface ValidationTrace {
  diameter: number | undefined;
  version: number;
  operationId: string;
  requestId: string;
  kind: string;
  started: number;
  finished?: number;
}
type BoreScope = typeof window & {
  boreTrace: ValidationTrace[];
  holdBore: boolean;
  releaseBore(): void;
};

for (const completed of [true, false]) {
  test(
    `hole release reuses ${completed ? 'finished' : 'running'} rest validation`,
    { tag: '@ci-smoke' },
    async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await stubApi(page, { panelLayout: MODEL_ONLY });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.addInitScript(() => {
        const scope = window as BoreScope;
        scope.boreTrace = [];
        scope.holdBore = false;
        const queued: (() => void)[] = [];
        scope.releaseBore = () => {
          scope.holdBore = false;
          queued.splice(0).forEach((send) => send());
        };
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(...args: ConstructorParameters<typeof Worker>) {
            super(...args);
            this.addEventListener('message', (event) => {
              const message = event.data as {
                type?: string;
                requestId?: string;
              };
              if (
                message.type !== 'sync' &&
                message.type !== 'preview-geometry'
              )
                return;
              const record = scope.boreTrace.find(
                (entry) => entry.requestId === message.requestId
              );
              if (record) record.finished = performance.now();
            });
          }
          override postMessage(
            message: unknown,
            transfer?: Transferable[] | StructuredSerializeOptions
          ) {
            const request = message as {
              type?: string;
              requestId?: string;
              document?: {
                name: string;
                version: number;
                nodes: Record<
                  string,
                  {
                    data?: {
                      featureKind?: string;
                      operation?: { diameter?: number };
                    };
                  }
                >;
              };
            };
            if (
              request.requestId &&
              request.document?.name === 'Bore validation' &&
              Object.values(request.document.nodes).some(
                (node) => node.data?.featureKind === 'direct-edit'
              ) &&
              (request.type === 'sync' || request.type === 'preview-geometry')
            ) {
              const diameter = Object.values(request.document.nodes)
                .filter((node) => node.data?.featureKind === 'direct-edit')
                .at(-1)?.data?.operation?.diameter;
              scope.boreTrace.push({
                diameter,
                version: request.document.version,
                operationId: Object.entries(request.document.nodes)
                  .filter(
                    ([, node]) => node.data?.featureKind === 'direct-edit'
                  )
                  .map(([id]) => id)
                  .join(';'),
                requestId: request.requestId,
                kind: request.type,
                started: performance.now()
              });
              if (
                scope.holdBore &&
                request.type === 'sync' &&
                diameter === 12
              ) {
                queued.push(() =>
                  super.postMessage(
                    message,
                    transfer as StructuredSerializeOptions
                  )
                );
                return;
              }
            }
            super.postMessage(message, transfer as StructuredSerializeOptions);
          }
        };
      });
      const gear = gearBody(
        createProjectDocument('Bore validation', toUserId('user_e2e')),
        {
          name: 'Gear',
          gearType: 'external',
          sizing: 'module',
          pitch: 2,
          teeth: 20,
          faceWidth: 40,
          origin: { x: 0, y: 0, z: 0 },
          axis: { x: 0, y: 0, z: 1 }
        }
      );
      const sketch = addSketchFeature(gear.document, {
        name: 'Bore sketch',
        plane: 'XY',
        offset: 0,
        objects: [{ objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 }]
      });
      const { document } = extrudeSketch(sketch.document, {
        name: 'Bore',
        sketchId: sketch.sketchId,
        distance: 40,
        operation: 'cut',
        targetBodyId: gear.bodyId
      });
      await page.route('**/api/projects', async (route) => {
        if (route.request().method() === 'POST') {
          await route.fulfill({ json: { document } });
        } else await route.fallback();
      });
      await page.goto('/');
      await expect(page).toHaveTitle(/OpenZCAD/);
      await page.getByLabel('Project name').fill('Bore validation');
      await page.getByRole('button', { name: 'New project' }).click();
      const canvas = page.locator('.viewer-host canvas');
      await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
        timeout: 30_000
      });
      await expectBodyCount(page, 1);
      await waitForStillViewport(page);
      await expect
        .poll(() =>
          canvas.evaluate(
            (element) =>
              new Promise<number | null>((resolve) =>
                element.dispatchEvent(
                  new CustomEvent('openzcad:e2e-select-cylinder', {
                    detail: {
                      surface: 'wall',
                      radius: 5,
                      resolve: (value: { radius?: number } | null) =>
                        resolve(value?.radius ?? null)
                    }
                  })
                )
              )
          )
        )
        .toBe(5);
      await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
      await waitForStillViewport(page);
      await canvas.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      );
      const handle = await canvas.evaluate((element) => {
        const data = (element as HTMLElement).dataset;
        return {
          x: Number(data.e2eHandleX),
          y: Number(data.e2eHandleY),
          dx: Number(data.e2eHandleDx),
          dy: Number(data.e2eHandleDy),
          scale: Number(data.e2eHandlePixelsPerUnit)
        };
      });
      const pinAt = () =>
        canvas.evaluate(
          (element) =>
            new Promise<{ x: number; y: number }>((resolve) => {
              const data = (element as HTMLElement).dataset;
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-project-points', {
                  detail: {
                    points: [
                      [
                        Number(data.e2eChipAnchorWorldX),
                        Number(data.e2eChipAnchorWorldY),
                        Number(data.e2eChipAnchorWorldZ)
                      ]
                    ],
                    resolve: (state: { points: { x: number; y: number }[] }) =>
                      resolve(state.points[0]!)
                  }
                })
              );
            })
        );
      const pin = await pinAt();
      await page.evaluate((held) => {
        (window as BoreScope).holdBore = held;
      }, !completed);
      await page.mouse.move(pin.x, pin.y);
      await page.mouse.down();
      await page.mouse.move(
        pin.x + handle.dx * handle.scale,
        pin.y + handle.dy * handle.scale,
        { steps: 4 }
      );
      await testInfo.attach('during-bore-drag', {
        body: await page.screenshot({
          path: testInfo.outputPath('during-bore-drag.png')
        }),
        contentType: 'image/png'
      });
      await expect(page.getByTestId('direct-manipulation-value')).toContainText(
        '12'
      );
      const usesProxy =
        (await canvas.getAttribute('data-e2e-cylinder-proxy-radius')) !== null;
      const radius = 6;
      expect(radius).toBeGreaterThan(5);
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (window as BoreScope).boreTrace.filter(
                  (entry) => entry.kind === 'sync' && entry.diameter === 12
                ).length
            ),
          { timeout: 30_000 }
        )
        .toBe(1);
      if (completed)
        await expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  (window as BoreScope).boreTrace.find(
                    (entry) => entry.kind === 'sync' && entry.diameter === 12
                  )?.finished ?? null
              ),
            { timeout: 30_000 }
          )
          .not.toBeNull();
      const released = Date.now();
      await page.mouse.up();
      if (!completed) {
        if (usesProxy)
          await expect(
            page.getByText('Checking exact result…', { exact: true })
          ).toBeVisible();
        await expect(
          page.getByRole('status', { name: 'Checking' })
        ).toBeVisible();
        await expect(
          page.getByText('Preview · exact on release', { exact: true })
        ).not.toBeVisible();
        await testInfo.attach('checking-held-hole', {
          body: await page.screenshot({
            path: testInfo.outputPath('checking-held-hole.png')
          }),
          contentType: 'image/png'
        });
        const heldTrace = await page.evaluate(
          () => (window as BoreScope).boreTrace
        );
        expect(
          heldTrace.filter(
            (entry) => entry.kind === 'sync' && entry.diameter === 12
          ),
          JSON.stringify(heldTrace)
        ).toHaveLength(1);
        await page.evaluate(() => (window as BoreScope).releaseBore());
      }
      await expect(page.getByRole('status', { name: 'Checking' })).toHaveCount(
        0,
        { timeout: 30_000 }
      );
      await expect(canvas).not.toHaveAttribute(
        'data-e2e-cylinder-proxy-radius',
        /.+/,
        { timeout: 30_000 }
      );
      await expect(
        page.getByRole('button', { name: 'Edit not applied' })
      ).toHaveCount(0);
      const trace = await page.evaluate(() => (window as BoreScope).boreTrace);
      expect(
        trace.filter((entry) => entry.kind === 'sync' && entry.diameter === 12),
        JSON.stringify(trace)
      ).toHaveLength(1);
      const workPath = testInfo.outputPath('validation-work.json');
      await writeFile(
        workPath,
        JSON.stringify(
          { trace, releaseToResultMs: Date.now() - released },
          null,
          2
        )
      );
      await testInfo.attach('validation-work', {
        path: workPath,
        contentType: 'application/json'
      });
      await expect
        .poll(() =>
          canvas.evaluate(
            (element) =>
              new Promise<number | null>((resolve) =>
                element.dispatchEvent(
                  new CustomEvent('openzcad:e2e-select-cylinder', {
                    detail: {
                      surface: 'wall',
                      radius: 6,
                      select: false,
                      resolve: (value: { radius?: number } | null) =>
                        resolve(value?.radius ?? null)
                    }
                  })
                )
              )
          )
        )
        .toBe(6);
      const menu = page.locator('details.file-menu');
      await menu.locator('summary').click();
      const pending = page.waitForEvent('download');
      await menu.getByRole('button', { name: /Export project/ }).click();
      const stream = await (await pending).createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const saved = (
        JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          document: ProjectDocument;
        }
      ).document;
      const edit = Object.values(saved.nodes).find(
        (node) =>
          node.kind === 'feature' && node.data.featureKind === 'direct-edit'
      );
      expect(edit?.id).toBe(
        trace.find((entry) => entry.kind === 'sync' && entry.diameter === 12)!
          .operationId
      );
      expect(
        edit &&
          edit.kind === 'feature' &&
          edit.data.featureKind === 'direct-edit' &&
          'diameter' in edit.data.operation &&
          edit.data.operation.diameter
      ).toBe(radius * 2);
      if (completed) {
        await waitForStillViewport(page);
        const second = await pinAt();
        await page.mouse.move(second.x, second.y);
        await page.mouse.down();
        await page.mouse.move(
          second.x + handle.dx * handle.scale * 20,
          second.y + handle.dy * handle.scale * 20,
          { steps: 4 }
        );
        await page.mouse.up();
        await expect(
          page.getByRole('button', { name: 'Edit not applied' })
        ).toBeVisible({ timeout: 30_000 });
        await page.keyboard.press('Escape');
        await expect(
          page.getByRole('button', { name: 'Edit not applied' })
        ).toBeVisible();
        const notice = page.getByRole('button', { name: 'Edit not applied' });
        const refusalText = (await notice.getAttribute('title'))!.replace(
          ' Open the activity log for details.',
          ''
        );
        await notice.click();
        const log = page.getByRole('region', { name: 'Activity log' });
        await expect(log).toContainText(refusalText);
        await expect(log.locator('ol')).toBeVisible();
        await testInfo.attach('refusal-after-deselect', {
          body: await page.screenshot({
            path: testInfo.outputPath('refusal-after-deselect.png')
          }),
          contentType: 'image/png'
        });
      }
      expect(errors).toEqual([]);
    }
  );
}
