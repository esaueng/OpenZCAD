import type { Locator, Page } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * A face push/pull must not flash intermediate states: the unmoved part
 * mid-drag, a whole-body selection from grabbing the face, or the handle
 * fading out and back in around the commit. Each was one or two frames in a
 * screen recording, so these specs record what the canvas reported on every
 * change rather than sampling the end state.
 */

declare global {
  interface Window {
    __faceDragLog?: { t: number; name: string; value: string | null }[];
    __holdFinal?: { hold: boolean; held: number; release(): void };
    __openzcadE2EExactFaceDrag?: boolean;
  }
}

async function selectFace(canvas: Locator, normal: object) {
  await expect
    .poll(() =>
      canvas.evaluate(
        (element, normal) =>
          new Promise((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: { normal, resolve }
              })
            );
          }),
        normal
      )
    )
    .not.toBeNull();
}

/** A 30 × 18 × 24 box with its front face armed for Offset Face. */
async function armedBox(page: Page, options: { hole?: boolean } = {}) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Face drag continuity');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Width (X)').fill('30');
  await inspector.getByLabel('Depth (Y)').fill('18');
  await inspector.getByLabel('Height (Z)').fill('24');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  const canvas = page.locator('.viewer-host canvas');
  if (options.hole) {
    // A Ø6 through hole in the top, 9 mm behind the front face: pushing the
    // front face past 6 mm runs it into the hole.
    await selectFace(canvas, { x: 0, y: 0, z: 1 });
    await page
      .locator('.selection-card')
      .getByRole('button', { name: 'Selection: Hole', exact: true })
      .click();
    await page.getByRole('button', { name: /^Create hole/ }).click();
    await expect(
      page.locator('.feature-row-main', { hasText: 'Hole' })
    ).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await selectFace(canvas, { x: 0, y: -1, z: 0 });
  await page
    .locator('.selection-card')
    .getByRole('button', { name: 'Selection: Offset', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toBeVisible();
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixels: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  return {
    canvas,
    handle: { ...handle, x: bounds.x + handle.x, y: bounds.y + handle.y }
  };
}

/** Logs every change to the drag's canvas attributes, from now on. */
async function recordCanvas(canvas: Locator) {
  await canvas.evaluate((element) => {
    const log: { t: number; name: string; value: string | null }[] = [];
    window.__faceDragLog = log;
    new MutationObserver((records) => {
      for (const record of records) {
        const name = record.attributeName!;
        log.push({
          t: performance.now(),
          name,
          value: (record.target as Element).getAttribute(name)
        });
      }
    }).observe(element, {
      attributes: true,
      attributeFilter: ['data-e2e-handle-x', 'data-e2e-height-proxy-offset']
    });
  });
}

const now = (page: Page) => page.evaluate(() => performance.now());
const removals = (page: Page, name: string, from: number) =>
  page.evaluate(
    ({ name, from }) =>
      (window.__faceDragLog ?? []).filter(
        (entry) => entry.name === name && entry.t >= from && !entry.value
      ).length,
    { name, from }
  );

/** Drags from (x, y) along the handle by `value`, then releases and waits. */
async function dragAndCommit(
  page: Page,
  canvas: Locator,
  handle: { dx: number; dy: number; pixels: number },
  x: number,
  y: number,
  value: number
) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    x + handle.dx * handle.pixels * value,
    y + handle.dy * handle.pixels * value,
    { steps: 12 }
  );
  await expect(canvas).toHaveAttribute(
    'data-e2e-height-proxy-offset',
    String(value)
  );
  const released = await now(page);
  await page.mouse.up();
  await expect(page.getByText('Offset face by', { exact: false })).toBeVisible({
    timeout: 30_000
  });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(1);
  // Still the moved face, armed for the next drag: never the body.
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Selection: Move', exact: true })
  ).toHaveCount(0);
  return released;
}

test('the handle stays on screen from release through the commit', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  const { canvas, handle } = await armedBox(page);
  await recordCanvas(canvas);
  const released = await dragAndCommit(
    page,
    canvas,
    handle,
    handle.x,
    handle.y,
    3
  );
  // It was held through validation and handed straight to the re-armed one,
  // where it used to fade out on release and back in after the commit.
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  expect(await removals(page, 'data-e2e-handle-x', released)).toBe(0);
});

/** Holds the worker's complete-rebuild replies, so a release stays validating. */
async function holdValidation(page: Page) {
  await page.addInitScript(() => {
    const finals: (() => void)[] = [];
    window.__holdFinal = {
      hold: false,
      held: 0,
      release() {
        this.hold = false;
        for (const deliver of finals.splice(0)) deliver();
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
          const gate = window.__holdFinal!;
          if (
            gate.hold &&
            result.type === 'sync' &&
            typeof result.requestId === 'string'
          ) {
            gate.held += 1;
            finals.push(() => listener.call(this, event));
          } else listener.call(this, event);
        });
      }
    });
  });
}

test('a press on the handle while its release validates changes nothing', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await holdValidation(page);
  const { canvas, handle } = await armedBox(page);
  await page.evaluate(() => {
    window.__holdFinal!.hold = true;
  });
  const endX = handle.x + handle.dx * handle.pixels * 3;
  const endY = handle.y + handle.dy * handle.pixels * 3;
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 12 });
  await expect(canvas).toHaveAttribute('data-e2e-height-proxy-offset', '3');
  await page.mouse.up();
  const card = page.getByRole('region', { name: 'Offset Face operation' });
  await expect
    .poll(() => page.evaluate(() => window.__holdFinal!.held))
    .toBe(1);
  await expect(card).toContainText('Validating');
  // The held handle sits over the face. Its release used to fall through to
  // a selection click on that face and re-arm it mid-validation.
  await page.mouse.click(endX, endY);
  await page.waitForTimeout(300);
  await expect(card).toContainText('Validating');
  await page.evaluate(() => window.__holdFinal!.release());
  await expect(page.getByText('Offset face by', { exact: false })).toBeVisible({
    timeout: 30_000
  });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(1);
});

test('dragging the selected face itself pushes it, as the arrow does', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  const { canvas, handle } = await armedBox(page);
  // Grab the face beside the arrow, not the arrow: this used to start a
  // selection band, and a short sweep took the whole body.
  const startX = handle.x - handle.dy * 40;
  const startY = handle.y + handle.dx * 40;
  await dragAndCommit(page, canvas, handle, startX, startY, 3);

  // A press on the face that does not travel is still a click: it picks the
  // face afresh, never the body.
  await page.mouse.click(startX, startY);
  await expect(page.locator('.selection-card')).toContainText(
    'Box 1 · Front face'
  );
  await expect(
    page.getByRole('button', { name: 'Selection: Move', exact: true })
  ).toHaveCount(0);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(1);
});

test('a value the drag preview cannot show holds the last one it could', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  const { canvas, handle } = await armedBox(page, { hole: true });
  await recordCanvas(canvas);
  const to = (value: number) =>
    page.mouse.move(
      handle.x - handle.dx * handle.pixels * value,
      handle.y - handle.dy * handle.pixels * value,
      { steps: 6 }
    );
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  const pressed = await now(page);
  for (let value = 1; value <= 6; value++) await to(value);
  await expect(canvas).toHaveAttribute('data-e2e-height-proxy-offset', '-6');
  // Past 6 mm the face would cut into the hole, which the drag preview cannot
  // draw. It used to snap back to the unmoved part there.
  for (let value = 7; value <= 9; value++) await to(value);
  await expect(page.getByTestId('direct-manipulation-value')).toContainText(
    '9'
  );
  await expect(canvas).toHaveAttribute('data-e2e-height-proxy-offset', '-6');
  expect(await removals(page, 'data-e2e-height-proxy-offset', pressed)).toBe(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('the face an exact preview redrew can still be grabbed after a refusal', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  // Exact frames renumber the dragged face; force them for every step.
  await page.addInitScript(() => {
    window.__openzcadE2EExactFaceDrag = true;
  });
  const { canvas, handle } = await armedBox(page);
  const chip = page.getByTestId('direct-manipulation-value');
  const at = (value: number) => ({
    x: handle.x - handle.dx * handle.pixels * value,
    y: handle.y - handle.dy * handle.pixels * value
  });
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(at(6).x, at(6).y, { steps: 12 });
  // The chip reads the total: the 18 mm box less the 6 mm push.
  await expect(chip).toHaveText('12 mm');
  await expect(page.locator('.selection-card')).toContainText('Box 1 · Face');
  // Through the back of the 18 mm box: refused, keeping the 6 mm preview.
  await page.mouse.move(at(24).x, at(24).y, { steps: 12 });
  await page.mouse.up();
  const card = page.getByRole('region', { name: 'Offset Face operation' });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('Validating', { timeout: 30_000 });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  const rearmed = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY)
  }));
  const bounds = (await canvas.boundingBox())!;
  // Press the shown face beside the arrow and pull: the face follows.
  const startX = bounds.x + rearmed.x - handle.dy * 40;
  const startY = bounds.y + rearmed.y + handle.dx * 40;
  const before = await chip.textContent();
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(
    startX + handle.dx * handle.pixels * 2,
    startY + handle.dy * handle.pixels * 2,
    { steps: 12 }
  );
  await expect(canvas).toHaveAttribute('data-e2e-offset-ghost', '1');
  await expect(chip).not.toHaveText(before ?? '');
  await page.keyboard.press('Escape');
  await page.mouse.up();
});
