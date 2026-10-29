import type { Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi,
  finishInPlaceCommand
} from './openzcad-fixtures';

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
    __holdPreviews?: { hold: boolean; held: number; deliver(): void };
    __openzcadE2EExactFaceDrag?: boolean;
    __slowAnalysis?: {
      armed: boolean;
      held: number;
      /** Hold until `release()` instead of for 700 ms. */
      manual?: boolean;
      release?: () => void;
    };
    __cardlessFrames?: number;
    __afterCommit?: { waiting: number; unselectedRows: number };
    __bodyCardFrames?: number;
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
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '30', depth: '18', height: '24' }
  });
  const canvas = page.locator('.viewer-host canvas');
  if (options.hole) {
    // A Ø6 through hole in the top, 9 mm behind the front face: pushing the
    // front face past 6 mm runs it into the hole.
    await selectFace(canvas, { x: 0, y: 0, z: 1 });
    await page
      .locator('.selection-rail')
      .getByRole('button', { name: 'Selection: Hole', exact: true })
      .click();
    // U09: Hole runs in place from the face just picked, at the point it
    // was picked: the Ø6 through default, then Done.
    await finishInPlaceCommand(page, 'Hole');
    await expect(
      page.locator('.feature-row-main', { hasText: 'Hole' })
    ).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await selectFace(canvas, { x: 0, y: -1, z: 0 });
  await page
    .locator('.selection-rail')
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
      attributeFilter: [
        'data-e2e-handle-x',
        'data-e2e-height-proxy-offset',
        'data-e2e-offset-ghost'
      ]
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
  await expect(page.locator('.selection-readout')).toContainText(
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
  // Total reads the line from the arrow back to where the material ends,
  // and the arrow stands right in front of the hole: 6 mm to its wall, so
  // a 9 mm push reads past it.
  await expect(page.getByTestId('direct-manipulation-value')).toContainText(
    '-3 mm'
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
  const armedFace = await canvas.getAttribute('data-e2e-selected-face');
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(at(6).x, at(6).y, { steps: 12 });
  // The chip reads the total: the 18 mm box less the 6 mm push.
  await expect(chip).toHaveText('12 mm');
  // The exact preview is on screen: the face drawn selected is its own,
  // renumbered one (the card keeps naming the face it came from).
  await expect(canvas).not.toHaveAttribute(
    'data-e2e-selected-face',
    armedFace ?? ''
  );
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

/**
 * Once armed, lets a rebuild's early meshes through and holds everything the
 * worker sends after them for 700 ms, in order: the analysis of a large
 * model takes that long, while a small one finishes inside the same frame.
 */
async function slowAnalysis(page: Page) {
  await page.addInitScript(() => {
    const flushes: (() => void)[] = [];
    window.__slowAnalysis = {
      armed: false,
      held: 0,
      release() {
        this.manual = false;
        for (const flush of flushes.splice(0)) flush();
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(
      Worker.prototype,
      'onmessage'
    )!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      ...descriptor,
      set(listener: (event: MessageEvent) => void) {
        let holdingUntil = 0;
        let queue: MessageEvent[] = [];
        const flush = () => {
          const due = queue;
          queue = [];
          holdingUntil = 0;
          for (const event of due) listener.call(this, event);
        };
        descriptor.set!.call(this, (event: MessageEvent) => {
          const gate = window.__slowAnalysis!;
          if (holdingUntil) {
            queue.push(event);
            return;
          }
          listener.call(this, event);
          const data = event.data as {
            type?: string;
            packet?: { state?: { analysis?: string } };
          };
          if (
            gate.armed &&
            data.type === 'projection-delta' &&
            data.packet?.state?.analysis === 'pending'
          ) {
            gate.held += 1;
            holdingUntil = performance.now() + 700;
            if (gate.manual) flushes.push(flush);
            else setTimeout(flush, 700);
          }
        });
      }
    });
  });
}

test('the committed face stays selected while the follow-up rebuild analyses', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await slowAnalysis(page);
  const { canvas, handle } = await armedBox(page);
  await page.evaluate(() => {
    window.__slowAnalysis!.armed = true;
    window.__cardlessFrames = 0;
    const sample = () => {
      const card = document.querySelector('.selection-rail');
      if (!card || /direct edit/i.test(document.body.innerText))
        window.__cardlessFrames! += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.dx * handle.pixels * 3,
    handle.y + handle.dy * handle.pixels * 3,
    { steps: 12 }
  );
  await expect(canvas).toHaveAttribute('data-e2e-height-proxy-offset', '3');
  await page.mouse.up();
  await expect(page.getByText('Offset face by', { exact: false })).toBeVisible({
    timeout: 30_000
  });
  await expect
    .poll(() => page.evaluate(() => window.__slowAnalysis!.held))
    .toBeGreaterThan(0);
  // Through the held analysis and a little after it.
  await page.waitForTimeout(1200);
  await expect(page.locator('.selection-readout')).toContainText(
    'Box 1 · Front face'
  );
  expect(await page.evaluate(() => window.__cardlessFrames)).toBe(0);
});

test('a commit reads as complete while its follow-up rebuild analyses', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await slowAnalysis(page);
  const { canvas, handle } = await armedBox(page);
  const drag = async (value: number) => {
    const x = Number(await canvas.getAttribute('data-e2e-handle-x'));
    const y = Number(await canvas.getAttribute('data-e2e-handle-y'));
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(bounds.x + x, bounds.y + y);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + x + handle.dx * handle.pixels * value,
      bounds.y + y + handle.dy * handle.pixels * value,
      { steps: 8 }
    );
    await page.mouse.up();
  };
  await drag(3);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(1, { timeout: 30_000 });
  // From here the follow-up rebuild's analysis is held for 700 ms.
  await page.evaluate(() => {
    window.__slowAnalysis!.armed = true;
    window.__afterCommit = { waiting: 0, unselectedRows: 0 };
    const sample = () => {
      const tally = window.__afterCommit!;
      if (
        [...document.querySelectorAll('button')].some((button) =>
          /Waiting for exact geometry/.test(
            `${button.getAttribute('aria-label') ?? ''} ${button.title}`
          )
        )
      )
        tally.waiting += 1;
      if (!document.querySelector('.feature-row.selected'))
        tally.unselectedRows += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await drag(2);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(2, { timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => window.__slowAnalysis!.held))
    .toBeGreaterThan(0);
  // Through the held analysis: no tool waits, the History row stays picked.
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.__afterCommit)).toEqual({
    waiting: 0,
    unselectedRows: 0
  });
  // A drag released inside a held window is not refused either.
  const held = await page.evaluate(() => window.__slowAnalysis!.held);
  await drag(1);
  await expect
    .poll(() => page.evaluate(() => window.__slowAnalysis!.held))
    .toBeGreaterThan(held);
  await drag(-1);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(3, { timeout: 30_000 });
  await expect(
    page.getByText('still rebuilding', { exact: false })
  ).toHaveCount(0);
});

test('applying a fillet goes straight from its preview to the blend face', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await slowAnalysis(page);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet continuity');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'box');
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              setTimeout(() => resolve(false), 1500);
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-edge', {
                  detail: {
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        ),
      { timeout: 30_000 }
    )
    .toBe(true);
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('2');
  await page.evaluate(() => {
    window.__slowAnalysis!.armed = true;
    window.__bodyCardFrames = 0;
    const sample = () => {
      // The whole-body card offers Move; a face's card never does.
      if (document.querySelector('[aria-label="Selection: Move"]'))
        window.__bodyCardFrames! += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Fillet' })
  ).toHaveCount(1, { timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => window.__slowAnalysis!.held))
    .toBeGreaterThan(0);
  await page.waitForTimeout(1200);
  await expect(page.locator('.selection-readout')).toContainText('Blend face');
  expect(await page.evaluate(() => window.__bodyCardFrames)).toBe(0);
});

test('a tool that needs the finished model waits for a genuine rebuild', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await slowAnalysis(page);
  const { canvas, handle } = await armedBox(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.dx * handle.pixels * 3,
    handle.y + handle.dy * handle.pixels * 3,
    { steps: 8 }
  );
  await expect(canvas).toHaveAttribute('data-e2e-height-proxy-offset', '3');
  await page.mouse.up();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(1, { timeout: 30_000 });
  await page.keyboard.press('Escape');
  // A rename is a real rebuild: the model on screen is the one it replaces.
  // Held until released: CI runners are slow enough that a timed hold can
  // end before the tool button is pressed.
  await page.evaluate(() => {
    window.__slowAnalysis!.armed = true;
    window.__slowAnalysis!.manual = true;
  });
  const objects = page.getByRole('list', { name: 'Objects' });
  await objects.getByRole('button', { name: 'Rename body Box 1' }).click();
  const field = objects.getByRole('textbox', { name: 'Rename body Box 1' });
  await field.fill('Plate');
  await field.press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.__slowAnalysis!.held))
    .toBeGreaterThan(0);
  // The rail shows readiness a beat late (so a quick rebuild never blinks
  // it), but launches check it at once. Whichever a runner's speed lands on,
  // Hole must not open: a click while the rail still shows it ready is
  // refused with a status, and once the rail catches up it is disabled and
  // names the wait.
  const hole = page.getByRole('button', { name: /^Hole/ }).first();
  await hole.click({ timeout: 1_000 }).catch(() => undefined);
  await expect(hole).toBeDisabled();
  await expect(hole).toHaveAccessibleName(/Waiting for exact geometry/);
  await expect(page.getByRole('region', { name: /^Hole/ })).toHaveCount(0);
  await page.evaluate(() => window.__slowAnalysis!.release!());
});

/**
 * Holds the worker's exact preview replies until the spec delivers them, so
 * each typed value's frame lands exactly when the spec says.
 */
async function holdPreviews(page: Page) {
  await page.addInitScript(() => {
    const held: (() => void)[] = [];
    window.__holdPreviews = {
      hold: false,
      held: 0,
      deliver() {
        for (const send of held.splice(0)) send();
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
          const gate = window.__holdPreviews!;
          if (
            gate.hold &&
            (event.data as { type?: string }).type === 'preview-geometry'
          ) {
            gate.held += 1;
            held.push(() => listener.call(this, event));
          } else listener.call(this, event);
        });
      }
    });
  });
}

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

test('typing an offset keeps the ghost and handle while exact previews land', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await holdPreviews(page);
  const { canvas } = await armedBox(page);
  await recordCanvas(canvas);
  await page.evaluate(() => {
    window.__holdPreviews!.hold = true;
  });
  const held = () => page.evaluate(() => window.__holdPreviews!.held);
  await page.getByTestId('direct-manipulation-value').click();
  // A box side reads its span: 18 mm deep, so 20 is a 2 mm pull.
  const keypad = page.getByRole('dialog', { name: 'Total value' });
  await expect(keypad).toBeVisible();
  const field = keypad.getByRole('textbox');
  const typing = await now(page);
  let landed = 0;
  for (const value of ['20', '23', '26']) {
    await field.fill(value);
    await expect(canvas).toHaveAttribute('data-e2e-offset-ghost', '1');
    // The exact frame for this value is in hand; let it land.
    await expect.poll(held, { timeout: 30_000 }).toBeGreaterThan(landed);
    landed = await held();
    await page.evaluate(() => window.__holdPreviews!.deliver());
    await frames(page);
    await frames(page);
  }
  // The ghost of the part as it was, and the handle, stayed up throughout.
  expect(await removals(page, 'data-e2e-offset-ghost', typing)).toBe(0);
  expect(await removals(page, 'data-e2e-handle-x', typing)).toBe(0);

  // Back at the baseline there is no change to show, so no ghost; the next
  // change takes it again.
  await field.fill('18');
  await expect(canvas).not.toHaveAttribute('data-e2e-offset-ghost', /.+/);
  await field.fill('22');
  await expect(canvas).toHaveAttribute('data-e2e-offset-ghost', '1');

  // Escape abandons the typed value: no ghost survives it, nothing is added.
  await page.evaluate(() => {
    window.__holdPreviews!.hold = false;
    window.__holdPreviews!.deliver();
  });
  await field.press('Escape');
  await expect(keypad).toBeHidden();
  await expect(canvas).not.toHaveAttribute('data-e2e-offset-ghost', /.+/);
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(0);

  // Applying a typed value commits it cleanly.
  await page.getByTestId('direct-manipulation-value').click();
  await expect(keypad).toBeVisible();
  await field.fill('21');
  await field.press('Enter');
  await expect(page.getByText('Offset face by', { exact: false })).toBeVisible({
    timeout: 30_000
  });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(1);
  await expect(canvas).not.toHaveAttribute('data-e2e-offset-ghost', /.+/);
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toBeVisible();
});
