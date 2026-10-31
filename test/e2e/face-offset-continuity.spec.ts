import { roundedPlateDocument } from '../support/rounded-plate';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY
} from './openzcad-fixtures';

interface ContinuityFrame {
  face: string | null;
  chipVisible: boolean;
  value: string;
  rotated: boolean;
  emissives: number[];
  bounds: { min: number[]; max: number[] }[];
}

interface ContinuityWindow extends Window {
  holdOffset?: boolean;
  heldOffsets: number;
  releaseOffset(): void;
  offsetFrames: ContinuityFrame[];
  recordOffset: boolean;
}

for (const [name, normal, axis, amount] of [
  ['side', { x: 1, y: 0, z: 0 }, 0, 6],
  ['top', { x: 0, y: 0, z: 1 }, 2, 2],
  ['bottom', { x: 0, y: 0, z: -1 }, 2, 2]
] as const) {
  test(
    `${name} offset keeps its shape, face and horizontal controls through release`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(120_000);
      await stubApi(page, { panelLayout: MODEL_ONLY });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.emulateMedia({
        reducedMotion: name === 'bottom' ? 'reduce' : 'no-preference'
      });
      await page.addInitScript(() => {
        const scope = window as unknown as ContinuityWindow;
        const pending: (() => void)[] = [];
        scope.heldOffsets = 0;
        scope.releaseOffset = () => {
          scope.holdOffset = false;
          for (const release of pending.splice(0)) release();
        };
        const send = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, transfer) {
          if (
            scope.holdOffset &&
            (message as { type?: string } | null)?.type === 'sync'
          ) {
            scope.heldOffsets++;
            pending.push(() =>
              send.call(this, message, transfer as StructuredSerializeOptions)
            );
            return;
          }
          return send.call(
            this,
            message,
            transfer as StructuredSerializeOptions
          );
        };
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { document: plateDocument } = await roundedPlateDocument();
      await page.goto('/');
      await page.getByRole('button', { name: 'Import project' }).click();
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'plate.openzcad',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            format: 'openzcad-project',
            version: 1,
            document: plateDocument,
            files: []
          })
        )
      });
      await expectBodyCount(page, 1);
      const canvas = page.locator('.viewer-host canvas');
      await expect
        .poll(async () => {
          await canvas.evaluate(
            (element, normal) =>
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-planar-face', {
                  detail: { normal }
                })
              ),
            normal
          );
          return canvas.getAttribute('data-e2e-handle-x');
        })
        .not.toBeNull();
      const chip = page.getByTestId('direct-manipulation-value');
      await expect(chip).toBeVisible();
      const handle = await canvas.evaluate((element) => ({
        x: Number(element.dataset.e2eHandleX),
        y: Number(element.dataset.e2eHandleY),
        dx: Number(element.dataset.e2eHandleDx),
        dy: Number(element.dataset.e2eHandleDy),
        perUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
      }));
      const rect = (await canvas.boundingBox())!;
      const start = { x: rect.x + handle.x, y: rect.y + handle.y };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(
        start.x + handle.dx * handle.perUnit * amount,
        start.y + handle.dy * handle.perUnit * amount,
        { steps: 6 }
      );
      await expect(canvas).toHaveAttribute(
        'data-e2e-height-proxy-offset',
        /.+/
      );
      await expect(chip).toHaveAttribute('data-variant', 'pin');
      const submitted = (await chip.innerText()).replace(/\s+/g, ' ').trim();
      await page.evaluate(() => {
        const scope = window as unknown as ContinuityWindow;
        scope.holdOffset = true;
        scope.offsetFrames = [];
        scope.recordOffset = true;
        const record = () => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            '.viewer-host canvas'
          )!;
          const chip = document.querySelector<HTMLElement>(
            '[data-testid="direct-manipulation-value"]'
          )!;
          canvas.dispatchEvent(
            new CustomEvent('openzcad:e2e-render-policy', {
              detail: {
                resolve: (state: {
                  bodyFaces: {
                    emissive: number;
                    worldBounds?: { min: number[]; max: number[] };
                  }[];
                }) => {
                  scope.offsetFrames.push({
                    face: canvas.dataset.e2eSelectedFace ?? null,
                    chipVisible:
                      !chip.hidden && getComputedStyle(chip).display !== 'none',
                    value: chip.textContent.replace(/\s+/g, ' ').trim(),
                    rotated:
                      chip.style.getPropertyValue('--chip-rotate') !== '',
                    emissives: state.bodyFaces.map((face) => face.emissive),
                    bounds: state.bodyFaces.flatMap((face) =>
                      face.worldBounds ? [face.worldBounds] : []
                    )
                  });
                }
              }
            })
          );
          if (scope.recordOffset) requestAnimationFrame(record);
        };
        requestAnimationFrame(record);
      });
      await page.mouse.up();
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as ContinuityWindow).heldOffsets
          )
        )
        .toBeGreaterThan(0);
      await expect(
        page.getByRole('region', { name: 'Offset Face operation' })
      ).toContainText('Validating');
      await expect(chip).toBeVisible();
      await expect(chip).toHaveText(submitted);
      await test.info().attach(`${name}-validating`, {
        body: await page.screenshot({
          path: test.info().outputPath(`${name}-validating.png`)
        }),
        contentType: 'image/png'
      });
      await page.evaluate(() =>
        (window as unknown as ContinuityWindow).releaseOffset()
      );
      await expect(
        page.getByRole('region', { name: 'Offset Face operation' })
      ).not.toContainText('Validating');
      await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
      await expect(canvas).not.toHaveAttribute('data-e2e-offset-ghost');
      const frames = await page.evaluate(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        const scope = window as unknown as ContinuityWindow;
        scope.recordOffset = false;
        return scope.offsetFrames;
      });
      await test.info().attach(`${name}-frames`, {
        body: JSON.stringify(frames),
        contentType: 'application/json'
      });
      expect(frames.length).toBeGreaterThan(2);
      for (const [index, frame] of frames.entries()) {
        expect(frame.face).not.toBeNull();
        expect(
          frame.chipVisible,
          JSON.stringify({ index, count: frames.length, frame })
        ).toBe(true);
        expect(frame.value).toBe(submitted);
        expect(frame.rotated).toBe(false);
        expect(frame.emissives.every((value) => value === 0)).toBe(true);
        // A visual proxy and the authoritative solid must keep the same reach
        // through the hold and the handoff: no intermediate baseline body.
        const before = frames[0]!.bounds[0]!;
        const now = frame.bounds[0]!;
        expect(now.min[axis]).toBeCloseTo(before.min[axis]!, 3);
        expect(now.max[axis]).toBeCloseTo(before.max[axis]!, 3);
      }
      await test.info().attach(`${name}-committed`, {
        body: await page.screenshot({
          path: test.info().outputPath(`${name}-committed.png`)
        }),
        contentType: 'image/png'
      });
      expect(errors).toEqual([]);
      const span = () =>
        canvas.evaluate(
          (element, axis) =>
            new Promise<number>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-render-policy', {
                  detail: {
                    resolve: (state: {
                      bodyFaces: {
                        worldBounds: { min: number[]; max: number[] };
                      }[];
                    }) => {
                      const bounds = state.bodyFaces[0]!.worldBounds;
                      resolve(bounds.max[axis]! - bounds.min[axis]!);
                    }
                  }
                })
              );
            }),
          axis
        );
      const committedSpan = await span();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(span).toBeCloseTo(axis === 0 ? 80 : 6, 3);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect.poll(span).toBeCloseTo(committedSpan, 3);
    }
  );
}
