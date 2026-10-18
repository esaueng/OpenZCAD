import type { Page } from '@playwright/test';
import {
  expect,
  test,
  stubApi,
  expectConsumedBodyCount
} from './openzcad-fixtures';

// Streamed preview frames arrive much later on the 2-core CI runners under
// SwiftShader than on a workstation. Budgets are upper bounds, not waits.
const PREVIEW_BUDGET_MS = process.env.CI ? 60_000 : 30_000;

const editPresentationMeasures = (page: Page) =>
  page.evaluate(async () => {
    // Flush the scheduled render as well as the synchronous mesh install.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    return ['oz:edit.installed', 'oz:edit.frame'].flatMap((name) =>
      performance.getEntriesByName(name, 'measure').map((entry) => ({
        name,
        detail: (entry as PerformanceMeasure).detail as {
          projectId: string;
          version: number;
          analysis: 'pending' | 'ready';
        }
      }))
    );
  });

const renderedWorldBounds = (page: Page) =>
  page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<{ min: number[]; max: number[] }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                bodyFaces: {
                  worldBounds?: { min: number[]; max: number[] };
                }[];
              }) => resolve(state.bodyFaces[0]!.worldBounds!)
            }
          })
        );
      })
  );

/**
 * Chamfers keep this fixture on the exact-preview path. Plain and rounded
 * cylinders use a viewport preview and rebuild only on release; their drag
 * behavior is covered separately in cylinder-preview.spec.ts.
 */
async function armChamferedTopCapOffset(page: Page) {
  await stubApi(page);
  await page.addInitScript(() => {
    const scope = window as typeof window & { facePreviewRequests?: string[] };
    scope.facePreviewRequests = [];
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      const type = (message as { type?: string } | null)?.type;
      if (
        type === 'preview-geometry' ||
        (type === 'sync' &&
          typeof (message as { requestId?: unknown }).requestId === 'string')
      )
        scope.facePreviewRequests!.push(type);
      return send.call(this, message, transfer as StructuredSerializeOptions);
    };
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Planar Live Preview');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await page.getByRole('button', { name: /^Chamfer/ }).click();
  await inspector.getByRole('button', { name: 'Select all 2 edges' }).click();
  await inspector.getByLabel('Distance', { exact: true }).fill('1');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expectConsumedBodyCount(page, 1);
  await expect(
    page.locator('.body-row', { hasText: 'Cylinder 1' })
  ).toBeVisible();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const selectTopCap = () =>
    canvas.evaluate((element) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: { surface: 'top-cap' }
        })
      );
    });
  const readAxisLength = () =>
    canvas.evaluate(
      (element) =>
        new Promise<number | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: {
                surface: 'wall',
                select: false,
                resolve: (
                  geometry: {
                    axisStart?: { x: number; y: number; z: number };
                    axisEnd?: { x: number; y: number; z: number };
                  } | null
                ) => {
                  if (!geometry?.axisStart || !geometry.axisEnd) {
                    resolve(null);
                    return;
                  }
                  // The straight wall excludes the two 1 mm chamfer rims.
                  resolve(
                    2 +
                      Math.hypot(
                        geometry.axisEnd.x - geometry.axisStart.x,
                        geometry.axisEnd.y - geometry.axisStart.y,
                        geometry.axisEnd.z - geometry.axisStart.z
                      )
                  );
                }
              }
            })
          );
        })
    );

  await expect
    .poll(
      async () => {
        await selectTopCap();
        return canvas.getAttribute('data-e2e-handle-x');
      },
      { timeout: 120_000 }
    )
    .not.toBeNull();
  const chip = page.getByTestId('direct-manipulation-value');
  await expect(chip).toHaveText('28 mm');
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  expect(Object.values(handle).every(Number.isFinite)).toBe(true);
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const start = { x: bounds!.x + handle.x, y: bounds!.y + handle.y };
  return {
    canvas,
    chip,
    readAxisLength,
    selectTopCap,
    handle,
    start,
    consoleErrors
  };
}

interface FacePreviewGate {
  holdPreview: boolean;
  holdFinal: boolean;
  previewDelayMs: number;
  heldPreview: number;
  heldFinal: number;
  releasePreview(): void;
  releaseFinal(): void;
}

async function installFacePreviewGate(page: Page) {
  await page.addInitScript(() => {
    const scope = window as typeof window & {
      facePreviewGate: FacePreviewGate;
    };
    const previews: (() => void)[] = [];
    const finals: (() => void)[] = [];
    scope.facePreviewGate = {
      holdPreview: false,
      holdFinal: false,
      previewDelayMs: 0,
      heldPreview: 0,
      heldFinal: 0,
      releasePreview() {
        this.holdPreview = false;
        for (const release of previews.splice(0)) release();
      },
      releaseFinal() {
        this.holdFinal = false;
        for (const release of finals.splice(0)) release();
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(
      Worker.prototype,
      'onmessage'
    )!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      ...descriptor,
      set(listener: (event: MessageEvent) => void) {
        descriptor.set!.call(this, (event: MessageEvent) => {
          const result = event.data as { type?: string; requestId?: string };
          const gate = scope.facePreviewGate;
          if (gate.holdPreview && result.type === 'preview-geometry') {
            gate.heldPreview += 1;
            previews.push(() => listener.call(this, event));
          } else if (
            gate.previewDelayMs > 0 &&
            result.type === 'preview-geometry'
          ) {
            setTimeout(() => listener.call(this, event), gate.previewDelayMs);
          } else if (
            gate.holdFinal &&
            result.type === 'sync' &&
            typeof result.requestId === 'string'
          ) {
            gate.heldFinal += 1;
            finals.push(() => listener.call(this, event));
          } else listener.call(this, event);
        });
      }
    });
  });
}

test('shows completed exact frames while face pointer input stays ahead of the worker', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await installFacePreviewGate(page);
  const { canvas, chip, readAxisLength, handle, start, consoleErrors } =
    await armChamferedTopCapOffset(page);
  await page.evaluate(() => {
    (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate.previewDelayMs = 200;
  });
  await canvas.evaluate((element) => {
    element.addEventListener(
      'pointerdown',
      (event) => {
        if (!(event instanceof PointerEvent)) return;
        element.dataset.continuousPointerId = String(event.pointerId);
      },
      { once: true }
    );
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await canvas.evaluate(
    async (element, { start, handle }) => {
      for (let sample = 1; sample <= 60; sample += 1) {
        const offset = 1 + sample * 0.1;
        element.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            isPrimary: true,
            pointerId: Number(element.dataset.continuousPointerId),
            buttons: 1,
            shiftKey: true,
            clientX: start.x + handle.dx * handle.pixelsPerUnit * offset,
            clientY: start.y + handle.dy * handle.pixelsPerUnit * offset
          })
        );
        // Deliver precise positions inside the browser, avoiding both snap
        // plateaus and automation round trips that can let the hand rest.
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    },
    { start, handle }
  );
  expect(await readAxisLength()).toBeGreaterThan(28.5);
  await expect(
    page
      .getByRole('region', { name: 'Offset Face operation' })
      .locator('.selection-callout-phase-dot')
  ).toHaveAttribute('aria-label', 'Dragging');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(chip).toHaveText('28 mm');
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(28, 4);
  expect(consoleErrors).toEqual([]);
});

test('reuses an exact frame on reversal and waits for complete validation on release', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await installFacePreviewGate(page);
  const {
    canvas,
    chip,
    readAxisLength,
    selectTopCap,
    handle,
    start,
    consoleErrors
  } = await armChamferedTopCapOffset(page);
  const requests = () =>
    page.evaluate(() => {
      const messages = (
        window as typeof window & { facePreviewRequests: string[] }
      ).facePreviewRequests;
      return {
        preview: messages.filter((type) => type === 'preview-geometry').length,
        full: messages.filter((type) => type === 'sync').length
      };
    });
  const moveBy = (offset: number) =>
    page.mouse.move(
      start.x + handle.dx * handle.pixelsPerUnit * offset,
      start.y + handle.dy * handle.pixelsPerUnit * offset,
      { steps: 1 }
    );
  const beforeDrag = await requests();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await moveBy(3);
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(31, 4);
  const previewBounds = await renderedWorldBounds(page);
  expect(previewBounds.max[2]! - previewBounds.min[2]!).toBeCloseTo(31, 4);
  expect((await requests()).full).toBe(beforeDrag.full);

  // Hold the next worker reply, then reverse to the frame already on screen.
  // Returning to it must neither queue another rebuild nor accept the older
  // reply over the frame matching the current pointer position.
  await page.evaluate(() => {
    (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate.holdPreview = true;
  });
  await moveBy(5);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { facePreviewGate: FacePreviewGate })
            .facePreviewGate.heldPreview
      )
    )
    .toBe(1);
  const beforeReversal = await requests();
  await moveBy(3);
  await expect(chip).toHaveText('31 mm');
  await expect(chip).toHaveAttribute('data-state', 'ready');
  expect(await readAxisLength()).toBeCloseTo(31, 4);
  expect(await requests()).toEqual(beforeReversal);
  await page.evaluate(async () => {
    (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate.releasePreview();
    // Let the ignored reply finish and React paint any degradation callback.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  });
  await expect(chip).toHaveAttribute('data-state', 'ready');
  expect(await readAxisLength()).toBeCloseTo(31, 4);

  await page.evaluate(() => {
    (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate.holdFinal = true;
  });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { facePreviewGate: FacePreviewGate })
            .facePreviewGate.heldFinal
      )
    )
    .toBe(1);
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toContainText('Validating');
  // A released drag keeps the drawer suspended through validation; opening
  // it explicitly must still disclose the preview's incomplete analysis.
  await page.getByRole('button', { name: 'Objects panel', exact: true }).click();
  await expect(page.getByText('Preparing model details…')).toBeVisible();
  await expect(page.getByRole('contentinfo')).not.toContainText(
    'Cylinder height set to 31 mm.'
  );
  expect(await readAxisLength()).toBeCloseTo(31, 4);
  expect(await requests()).toEqual({
    preview: beforeReversal.preview,
    full: beforeDrag.full + 1
  });
  await page.evaluate(() =>
    (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate.releaseFinal()
  );
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cylinder height set to 31 mm.'
  );
  await expect(page.getByText('Preparing model details…')).toBeHidden();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(28, 4);

  // A reply delivered after Escape must not resurrect the canceled gesture.
  await selectTopCap();
  await expect(chip).toHaveText('28 mm');
  const nextHandle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  const beforeCancel = await requests();
  await page.evaluate(() => {
    const gate = (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate;
    gate.heldPreview = 0;
    gate.holdPreview = true;
  });
  await page.mouse.move(bounds.x + nextHandle.x, bounds.y + nextHandle.y);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + nextHandle.x + nextHandle.dx * nextHandle.pixelsPerUnit * 4,
    bounds.y + nextHandle.y + nextHandle.dy * nextHandle.pixelsPerUnit * 4,
    { steps: 1 }
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { facePreviewGate: FacePreviewGate })
            .facePreviewGate.heldPreview
      )
    )
    .toBe(1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.evaluate(() =>
    (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate.releasePreview()
  );
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(28, 4);
  await expect(chip).toHaveText('28 mm');
  expect((await requests()).full).toBe(beforeCancel.full);
  expect(consoleErrors).toEqual([]);
});

test('keeps generic face geometry unchanged while the exact offset rebuild is pending', async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const scope = window as typeof window & { holdOffsetPreview?: boolean };
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (
        scope.holdOffsetPreview &&
        ['sync', 'preview-geometry'].includes(
          (message as { type?: string } | null)?.type ?? ''
        )
      ) {
        // Keep the exact worker genuinely pending for this cancel-path test.
        // A short timer races on slower CI runners: the exact result can land
        // between the proxy-bounds and HUD assertions and correctly remove
        // the temporary preview before the assertion observes it.
        return;
      }
      return send.call(this, message, transfer as StructuredSerializeOptions);
    };
  });
  const { canvas, handle, start, consoleErrors } =
    await armChamferedTopCapOffset(page);
  const before = await renderedWorldBounds(page);
  await page.evaluate(() => {
    (
      window as typeof window & { holdOffsetPreview?: boolean }
    ).holdOffsetPreview = true;
  });

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 4,
    start.y + handle.dy * handle.pixelsPerUnit * 4,
    { steps: 1 }
  );
  // An unqualified local face edit must not scale the entire body while
  // waiting: that moves unrelated geometry and disagrees with the kernel.
  await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');
  expect(await renderedWorldBounds(page)).toEqual(before);
  await expect(
    page.getByText('Preview · exact on release', { exact: true })
  ).not.toBeVisible();

  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');
  expect(await renderedWorldBounds(page)).toEqual(before);
  expect(consoleErrors).toEqual([]);
});

test('streams exact planar previews and restores invalid or canceled offsets', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  const { canvas, chip, readAxisLength, handle, start, consoleErrors } =
    await armChamferedTopCapOffset(page);
  const requests = () =>
    page.evaluate(() => {
      const messages = (
        window as typeof window & { facePreviewRequests: string[] }
      ).facePreviewRequests;
      return {
        preview: messages.filter((type) => type === 'preview-geometry').length,
        full: messages.filter((type) => type === 'sync').length
      };
    });
  const beforeDrag = await requests();
  // The live base has a real trace; otherwise absence during preview would
  // pass even if authoritative instrumentation were accidentally disabled.
  await expect
    .poll(async () =>
      (await editPresentationMeasures(page)).some(
        ({ name, detail }) =>
          name === 'oz:edit.frame' && detail.analysis === 'ready'
      )
    )
    .toBe(true);
  const baseMeasures = await editPresentationMeasures(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 2,
    start.y + handle.dy * handle.pixelsPerUnit * 2,
    { steps: 1 }
  );
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(30, 4);
  const duringDrag = await requests();
  expect(duringDrag.preview).toBeGreaterThan(beforeDrag.preview);
  expect(duringDrag.full).toBe(beforeDrag.full);
  expect(await editPresentationMeasures(page)).toEqual(baseMeasures);
  // A second pointer value after the first exact frame must replace it rather
  // than leaving the coalescer stuck on the first sample. Offset-face keeps
  // previewing after a slow frame, but the chip reports the lag as deferred
  // and the second sample may land late -- routine on the 2-core CI runners.
  // Both outcomes are correct; silently holding the first sample is the
  // regression worth catching.
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 5,
    start.y + handle.dy * handle.pixelsPerUnit * 5,
    { steps: 1 }
  );
  const secondSample = async () => {
    if ((await chip.getAttribute('data-state')) === 'deferred') {
      return 'catching-up';
    }
    const length = await readAxisLength();
    return length !== null && Math.abs(length - 33) < 5e-5
      ? 'advanced'
      : 'stale';
  };
  await expect
    .poll(secondSample, { timeout: PREVIEW_BUDGET_MS })
    .not.toBe('stale');
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
  await expect(
    page
      .getByRole('region', { name: 'Offset Face operation' })
      .locator('.selection-callout-phase-dot')
  ).toHaveAttribute('aria-label', 'Dragging');
  // The drag has the stage: the drawer (and its History count) steps aside
  // until the gesture ends; the count is checked again once it has.
  await expect(page.locator('.model-drawer-float')).toHaveCount(0);
  expect(await editPresentationMeasures(page)).toEqual(baseMeasures);

  // Still holding the button, drive the total below zero. The kernel refuses
  // it: the handle keeps tracking and the chip turns to its warning state,
  // but the shape stays at the last value that built — it must not snap back
  // to the 28 mm the drag started from under a pointer that is still down.
  const lastValid = await readAxisLength();
  expect(lastValid).not.toBeNull();
  expect(lastValid!).toBeGreaterThan(28.5);
  await page.mouse.move(
    start.x - handle.dx * handle.pixelsPerUnit * 40,
    start.y - handle.dy * handle.pixelsPerUnit * 40,
    { steps: 1 }
  );
  await expect(chip).toHaveAttribute('data-state', 'warning', {
    timeout: PREVIEW_BUDGET_MS
  });
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toContainText('Failed');
  expect(await readAxisLength()).toBeCloseTo(lastValid!, 4);
  // A value that builds again recovers the gesture in place.
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 4,
    start.y + handle.dy * handle.pixelsPerUnit * 4,
    { steps: 1 }
  );
  await expect(chip).not.toHaveAttribute('data-state', 'warning', {
    timeout: PREVIEW_BUDGET_MS
  });
  await expect(
    page
      .getByRole('region', { name: 'Offset Face operation' })
      .locator('.selection-callout-phase-dot')
  ).toHaveAttribute('aria-label', 'Dragging');

  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(28, 4);
  await expect(chip).toHaveText('28 mm');
  await expect(chip).toHaveAttribute('data-state', 'ready');

  await chip.click();
  let keypad = page.getByRole('dialog', { name: 'Total value' });
  await keypad.getByRole('textbox').fill('-1');
  const apply = keypad.getByRole('button', { name: 'Apply total' });
  await expect(apply).toBeDisabled({ timeout: PREVIEW_BUDGET_MS });
  await expect(keypad.getByRole('alert')).toBeVisible();
  await expect(chip).toHaveAttribute('data-state', 'warning');
  await expect(chip).toContainText('⚠ -1 mm');
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(28, 4);
  await page.keyboard.press('Escape');
  await expect(keypad).toBeHidden();
  await expect(chip).toHaveText('28 mm');
  await expect(chip).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();

  const beforeTypedPreview = await editPresentationMeasures(page);
  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Total value' });
  await keypad.getByRole('textbox').fill('35.7');
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(35.7, 4);
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
  await expect(
    keypad.getByRole('button', { name: 'Apply total' })
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  expect(await editPresentationMeasures(page)).toEqual(beforeTypedPreview);
  const beforeApply = await requests();
  await keypad.getByRole('button', { name: 'Apply total' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cylinder height set to 35.7 mm.'
  );
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(35.7, 4);
  expect((await requests()).full).toBeGreaterThan(beforeApply.full);
  const baseRevision = baseMeasures
    .filter(({ name }) => name === 'oz:edit.frame')
    .at(-1)!.detail;
  for (const phase of ['oz:edit.installed', 'oz:edit.frame']) {
    await expect
      .poll(async () =>
        (await editPresentationMeasures(page)).some(
          ({ name, detail }) =>
            name === phase &&
            detail.projectId === baseRevision.projectId &&
            detail.version > baseRevision.version &&
            detail.analysis === 'ready'
        )
      )
      .toBe(true);
  }
  expect(consoleErrors).toEqual([]);
});

test('keeps the last value that built when a drag is released on a refusal', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  const { chip, readAxisLength, handle, start, consoleErrors } =
    await armChamferedTopCapOffset(page);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 5,
    start.y + handle.dy * handle.pixelsPerUnit * 5,
    { steps: 2 }
  );
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeGreaterThan(28.5);
  const lastValid = (await readAxisLength())!;
  // Past the cylinder's own height the offset would remove the body.
  await page.mouse.move(
    start.x - handle.dx * handle.pixelsPerUnit * 40,
    start.y - handle.dy * handle.pixelsPerUnit * 40,
    { steps: 1 }
  );
  await expect(chip).toHaveAttribute('data-state', 'warning', {
    timeout: PREVIEW_BUDGET_MS
  });
  await page.mouse.up();
  const card = page.getByRole('region', { name: 'Offset Face operation' });
  await expect(card).toContainText('Failed');
  // The model still shows the last value that built, and the card offers to
  // keep it instead of sending the hand back to find it.
  expect(await readAxisLength()).toBeCloseTo(lastValid, 4);
  await card.getByRole('button', { name: /^Keep / }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    /Cylinder height set to \d+(\.\d+)? mm\./,
    { timeout: PREVIEW_BUDGET_MS }
  );
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(lastValid, 2);
  // The kept value edits the cylinder's height; no additional feature appears.
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('retains the last accepted shape when release validation beats an invalid preview', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await installFacePreviewGate(page);
  const { chip, readAxisLength, handle, start, consoleErrors } =
    await armChamferedTopCapOffset(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 5,
    start.y + handle.dy * handle.pixelsPerUnit * 5,
    { steps: 1 }
  );
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(33, 4);
  await page.evaluate(() => {
    (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate.holdPreview = true;
  });
  // A positive 1 mm height passes primitive preflight, but cannot retain
  // both 1 mm chamfers. Hold that exact refusal until after mouse release,
  // so final validation is the first place the UI learns it is invalid.
  await page.mouse.move(
    start.x - handle.dx * handle.pixelsPerUnit * 27,
    start.y - handle.dy * handle.pixelsPerUnit * 27,
    { steps: 1 }
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as typeof window & { facePreviewGate: FacePreviewGate })
              .facePreviewGate.heldPreview
        ),
      { timeout: PREVIEW_BUDGET_MS }
    )
    .toBeGreaterThan(0);
  await page.mouse.up();
  const card = page.getByRole('region', { name: 'Offset Face operation' });
  await expect(card).toContainText('Failed', { timeout: PREVIEW_BUDGET_MS });
  expect(await readAxisLength()).toBeCloseTo(33, 4);
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await page.evaluate(() =>
    (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate.releasePreview()
  );
  // The late, canceled refusal must not replace or clear the retained mesh.
  await expect(chip).toHaveAttribute('data-state', 'warning');
  expect(await readAxisLength()).toBeCloseTo(33, 4);
  const retainedPreview = test.info().outputPath('last-valid-preview.png');
  await page.screenshot({ path: retainedPreview });
  await test.info().attach('last-valid-preview-after-release-refusal', {
    path: retainedPreview,
    contentType: 'image/png'
  });
  await card.getByRole('button', { name: /^Keep / }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cylinder height set to 33 mm.',
    { timeout: PREVIEW_BUDGET_MS }
  );
  await expect.poll(readAxisLength).toBeCloseTo(33, 4);
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(28, 4);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(33, 4);
  expect(consoleErrors).toEqual([]);
});

test('clears the catching-up preview state when a degraded gesture is canceled', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  // Forcing the budget to 0 makes every rebuild count as slow, so offset-face
  // degrades on its first frame instead of whenever the kernel happens to be
  // slow. Without this the deferred path is unreachable on a fast machine and
  // a coin toss on CI.
  await page.addInitScript(() => {
    window.__openzcadE2ESlowFrameMs = 0;
  });
  await installFacePreviewGate(page);
  const { chip, readAxisLength, handle, start, consoleErrors } =
    await armChamferedTopCapOffset(page);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 2,
    start.y + handle.dy * handle.pixelsPerUnit * 2,
    { steps: 1 }
  );
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(30, 4);
  // A slow frame that already caught up must leave the value ready. Keep
  // the next value genuinely pending before expecting catching-up feedback.
  await expect(chip).toHaveAttribute('data-state', 'ready');
  await page.evaluate(() => {
    (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate.holdPreview = true;
  });
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 3,
    start.y + handle.dy * handle.pixelsPerUnit * 3,
    { steps: 1 }
  );
  await expect(chip).toHaveAttribute('data-state', 'deferred', {
    timeout: PREVIEW_BUDGET_MS
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { facePreviewGate: FacePreviewGate })
            .facePreviewGate.heldPreview
      )
    )
    .toBe(1);

  // clear() re-arms the previewer, so the chip must leave its catching-up
  // state. It used to stay deferred until the next commit.
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.evaluate(() =>
    (
      window as typeof window & { facePreviewGate: FacePreviewGate }
    ).facePreviewGate.releasePreview()
  );
  await expect(chip).toHaveAttribute('data-state', 'ready', {
    timeout: PREVIEW_BUDGET_MS
  });
  await expect(chip).toHaveText('28 mm');
  await expect
    .poll(readAxisLength, { timeout: PREVIEW_BUDGET_MS })
    .toBeCloseTo(28, 4);
  expect(consoleErrors).toEqual([]);
});

test('streams an exact extrude preview while a region drag is held', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Region Live Preview');
  await page.getByRole('button', { name: 'Create project' }).click();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  // Let the sketch-entry glide land before drawing on the plane.
  await page.waitForTimeout(1000);

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const corner = {
    x: bounds!.x + bounds!.width * 0.45,
    y: bounds!.y + bounds!.height * 0.45
  };
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await sketchTools.getByRole('button', { name: /^Rectangle/ }).click();
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 120, corner.y + 90, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Sketch 01 started.'
  );

  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Closed sketch profile selected'
  );
  const chip = page.getByTestId('direct-manipulation-value');
  await expect(chip).toHaveText('+0 mm');
  // Nothing solid exists yet: the sketch is the only thing on screen.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '0');

  await expect
    .poll(() => canvas.getAttribute('data-e2e-handle-x'), {
      timeout: PREVIEW_BUDGET_MS
    })
    .not.toBeNull();
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  expect(Object.values(handle).every(Number.isFinite)).toBe(true);
  const start = { x: bounds!.x + handle.x, y: bounds!.y + handle.y };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 12,
    start.y + handle.dy * handle.pixelsPerUnit * 12,
    { steps: 4 }
  );
  // The exact solid lands while the button is still down — the geometry
  // follows the hand instead of appearing on release.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: PREVIEW_BUDGET_MS
  });
  await expect(chip).toHaveText(/^\+\d+(\.\d+)? mm$/);

  await page.mouse.up();
  // Release is a draft: inspect or change its intent before confirming.
  await expect(
    page.locator('.feature-row-main', { hasText: 'Extrude' })
  ).toHaveCount(0);
  await page
    .getByRole('form', { name: 'Extrude settings' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page.getByRole('contentinfo')).toContainText(
    /Extruded region by \d+(\.\d+)? mm/,
    { timeout: PREVIEW_BUDGET_MS }
  );
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');

  // Create closes the extrude as every other create card closes (design
  // review G15): no card, no selection callout, no handle and no chip are
  // left up over the solid it just made.
  await expect(
    page.getByRole('region', { name: 'Extrude operation' })
  ).toHaveCount(0);
  await expect(page.locator('.selection-callout-chip')).toHaveCount(0);
  await expect(chip).toBeHidden();
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /.+/);
  await expect(canvas).not.toHaveAttribute('data-e2e-selected-face', /.+/);

  // Picking the far cap arms its handle on demand: the chip reads the stored
  // distance, and the card says Extrude.
  const cap = await canvas.evaluate(
    (element) =>
      new Promise<{ hasReference: boolean } | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: { normal: { x: 0, y: 0, z: 1 }, resolve }
          })
        );
      })
  );
  expect(cap).not.toBeNull();
  await expect(chip).toHaveText(/^\d+(\.\d+)? mm$/);
  await expect(
    page.getByRole('region', { name: 'Extrude operation' })
  ).toBeVisible();
  const before = Number((await chip.textContent())!.match(/[\d.]+/)![0]);
  await expect
    .poll(() => canvas.getAttribute('data-e2e-handle-x'), {
      timeout: PREVIEW_BUDGET_MS
    })
    .not.toBeNull();
  const capHandle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  expect(Object.values(capHandle).every(Number.isFinite)).toBe(true);
  const capStart = { x: bounds!.x + capHandle.x, y: bounds!.y + capHandle.y };
  await page.mouse.move(capStart.x, capStart.y);
  await page.mouse.down();
  await page.mouse.move(
    capStart.x + capHandle.dx * capHandle.pixelsPerUnit * 6,
    capStart.y + capHandle.dy * capHandle.pixelsPerUnit * 6,
    { steps: 4 }
  );
  await page.mouse.up();
  // A second drag edits the same feature's distance rather than adding a
  // second extrude or a local push/pull.
  await expect(page.getByRole('contentinfo')).toContainText(
    /Extrude distance set to \d+(\.\d+)? mm/,
    { timeout: PREVIEW_BUDGET_MS }
  );
  const after = Number(
    (await page.getByRole('contentinfo').textContent())!.match(
      /distance set to ([\d.]+)/
    )![1]
  );
  expect(after).toBeGreaterThan(before);
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Extrude' })
  ).toHaveCount(1);
  expect(consoleErrors).toEqual([]);
});

interface DragTimingRequest {
  id: string;
  at: number;
  responseAt?: number;
  ok?: boolean;
  warnings?: string[];
  hasQuantities?: boolean;
}
interface DragTimingSample {
  delta: number;
  at: number;
  requestStart: number;
  frameAt?: number;
}
interface ExactDragProbe {
  requests: DragTimingRequest[];
  samples: DragTimingSample[];
  pointerId?: number;
}
declare global {
  interface Window {
    __ozExactDragProbe: ExactDragProbe;
  }
}

// Opt-in timing evidence, never a wall-clock CI gate. Reuse the exact fixture
// and actual drag handler above, rather than measuring typed input or a proxy.
// OZ_PERF=1 pnpm test:e2e visual-selection-live-preview -g 'measures exact' \
//   --workers=1 --repeat-each=3
for (const surface of ['top-cap', 'wall'] as const) {
  test(`measures exact ${surface} drag input, worker reply and rendered frame`, async ({
    page,
    browser
  }) => {
    test.skip(process.env.OZ_PERF !== '1', 'Set OZ_PERF=1 for drag timing.');
    test.setTimeout(process.env.CI ? 240_000 : 120_000);
    await installFacePreviewGate(page);
    await page.addInitScript(() => {
      const probe: ExactDragProbe = { requests: [], samples: [] };
      window.__ozExactDragProbe = probe;
      const send = Worker.prototype.postMessage;
      const watched = new WeakSet<Worker>();
      Worker.prototype.postMessage = function (message, transfer) {
        const input = message as { type?: string; requestId: string };
        if (input?.type === 'preview-geometry')
          probe.requests.push({ id: input.requestId, at: performance.now() });
        if (!watched.has(this)) {
          watched.add(this);
          this.addEventListener(
            'message',
            (event: MessageEvent) => {
              const result = event.data as {
                type?: string;
                requestId?: string;
                ok?: boolean;
                geometry?: {
                  warnings: string[];
                  bodyRepresentations: Record<string, { volume?: number }>;
                };
              };
              if (result.type !== 'preview-geometry') return;
              const request = probe.requests.find(
                (entry) => entry.id === result.requestId
              );
              if (!request) return;
              request.responseAt = performance.now();
              request.ok = result.ok;
              request.warnings = result.geometry?.warnings;
              request.hasQuantities = Object.values(
                result.geometry?.bodyRepresentations ?? {}
              ).some((body) => body.volume !== undefined);
            },
            { capture: true }
          );
        }
        return send.call(this, message, transfer as StructuredSerializeOptions);
      };
    });
    const { canvas, consoleErrors } = await armChamferedTopCapOffset(page);
    await expect(page).toHaveURL(
      new URL('/', test.info().project.use.baseURL).href
    );
    await expect(page).toHaveTitle('OpenZCAD');
    await canvas.evaluate(
      (element, surface) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: { surface }
          })
        ),
      surface
    );
    await expect(canvas).toHaveAttribute(
      'data-e2e-chip-anchor-rig',
      surface === 'wall' ? 'cylinder-radius' : 'offset-face'
    );
    await canvas.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      scale: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    expect(Object.values(handle).every(Number.isFinite)).toBe(true);
    const box = (await canvas.boundingBox())!;
    const start = { x: box.x + handle.x, y: box.y + handle.y };
    const before = await renderedWorldBounds(page);
    const beforeMeasures = await editPresentationMeasures(page);
    const fullRequests = () =>
      page.evaluate(
        () =>
          (
            window as typeof window & { facePreviewRequests: string[] }
          ).facePreviewRequests.filter((type) => type === 'sync').length
      );
    const fullBefore = await fullRequests();
    await canvas.evaluate((element) =>
      element.addEventListener(
        'pointerdown',
        (event) => {
          window.__ozExactDragProbe.pointerId = (
            event as PointerEvent
          ).pointerId;
        },
        { once: true }
      )
    );
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await canvas.evaluate(
      async (element, { handle, start, surface, budget }) => {
        const probe = window.__ozExactDragProbe;
        for (let delta = 2; delta <= 8; delta += 1) {
          const sample: DragTimingSample = {
            delta,
            at: performance.now(),
            requestStart: probe.requests.length
          };
          probe.samples.push(sample);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              element.removeEventListener('openzcad:e2e-camera-frame', frame);
              reject(new Error(`Exact ${surface} frame ${delta} timed out.`));
            }, budget);
            const frame = () => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-render-policy', {
                  detail: {
                    resolve: (state: {
                      bodyFaces: { worldBounds?: { max: number[] } }[];
                    }) => {
                      const bounds = state.bodyFaces[0]?.worldBounds;
                      const axis = surface === 'wall' ? 0 : 2;
                      const expected = (surface === 'wall' ? 14 : 28) + delta;
                      if (
                        !bounds ||
                        Math.abs(bounds.max[axis]! - expected) > 1e-4
                      )
                        return;
                      sample.frameAt = performance.now();
                      clearTimeout(timer);
                      element.removeEventListener(
                        'openzcad:e2e-camera-frame',
                        frame
                      );
                      resolve();
                    }
                  }
                })
              );
            };
            element.addEventListener('openzcad:e2e-camera-frame', frame);
            element.dispatchEvent(
              new PointerEvent('pointermove', {
                bubbles: true,
                cancelable: true,
                pointerType: 'mouse',
                isPrimary: true,
                pointerId: probe.pointerId!,
                buttons: 1,
                shiftKey: true,
                clientX: start.x + handle.dx * handle.scale * delta,
                clientY: start.y + handle.dy * handle.scale * delta
              })
            );
          });
        }
      },
      { handle, start, surface, budget: PREVIEW_BUDGET_MS }
    );
    const observation = await page.evaluate(() => {
      const probe = window.__ozExactDragProbe;
      const canvas = document.querySelector<HTMLCanvasElement>(
        '.viewer-host canvas'
      )!;
      const gl = canvas.getContext('webgl2')!;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        requests: probe.requests,
        samples: probe.samples.map((sample) => {
          const request = probe.requests[sample.requestStart]!;
          return {
            delta: sample.delta,
            inputToRequestMs: request.at - sample.at,
            requestToReplyMs: request.responseAt! - request.at,
            replyToFrameMs: sample.frameAt! - request.responseAt!,
            inputToFrameMs: sample.frameAt! - sample.at
          };
        }),
        userAgent: navigator.userAgent,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        renderer: String(
          gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
        )
      };
    });
    expect(observation.requests).toHaveLength(7);
    for (const request of observation.requests) {
      expect(request.ok).toBe(true);
      expect(request.warnings).toEqual([]);
      expect(request.hasQuantities).toBe(false);
    }
    for (const sample of observation.samples) {
      for (const elapsed of [
        sample.inputToRequestMs,
        sample.requestToReplyMs,
        sample.replyToFrameMs
      ]) {
        expect(Number.isFinite(elapsed)).toBe(true);
        expect(elapsed).toBeGreaterThanOrEqual(0);
      }
    }
    await expect(canvas).not.toHaveAttribute(
      'data-e2e-cylinder-proxy-radius',
      /.+/
    );
    await expect(canvas).not.toHaveAttribute(
      'data-e2e-height-proxy-offset',
      /.+/
    );
    expect(await fullRequests()).toBe(fullBefore);
    const previewBounds = await renderedWorldBounds(page);
    // In-page move samples avoid automation round trips. Synchronize the
    // trusted pointer before release, whose coordinates Playwright owns.
    await page.mouse.move(
      start.x + handle.dx * handle.scale * 8,
      start.y + handle.dy * handle.scale * 8
    );
    await page.evaluate(() => {
      (
        window as typeof window & { facePreviewGate: FacePreviewGate }
      ).facePreviewGate.holdFinal = true;
    });
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { facePreviewGate: FacePreviewGate })
              .facePreviewGate.heldFinal
        )
      )
      .toBe(1);
    expect(await fullRequests()).toBe(fullBefore + 1);
    await page
      .getByRole('button', { name: 'Objects panel', exact: true })
      .click();
    await expect(page.getByText('Preparing model details…')).toBeVisible();
    // The preview cannot change history before the complete worker result.
    await page
      .getByRole('button', { name: 'History panel', exact: true })
      .click();
    await expect(page.locator('.feature-row')).toHaveCount(2);
    expect(await editPresentationMeasures(page)).toEqual(beforeMeasures);
    await page.evaluate(() =>
      (
        window as typeof window & { facePreviewGate: FacePreviewGate }
      ).facePreviewGate.releaseFinal()
    );
    await expect(page.getByText('Preparing model details…')).toBeHidden();
    await expect(page.getByRole('contentinfo')).toContainText(
      surface === 'wall' ? 'Adjusted cylinder diameter' : 'height set'
    );
    expect(await renderedWorldBounds(page)).toEqual(previewBounds);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => renderedWorldBounds(page)).toEqual(before);
    expect(consoleErrors).toEqual([]);
    const evidence = {
      surface,
      browserVersion: browser.version(),
      ...observation
    };
    await test.info().attach('exact-drag-latency.json', {
      body: JSON.stringify(evidence),
      contentType: 'application/json'
    });
    console.log('[exact drag latency]', JSON.stringify(evidence));
  });
}
