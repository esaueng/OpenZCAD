import type { Locator, Page } from '@playwright/test';
import { renderedMinimumY } from './rendered-body-fixtures';
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

/**
 * A 30 × 18 × 24 box with its front face armed for Offset Face, or left on
 * the Resize Body a face pick arms by default.
 */
async function armedBox(
  page: Page,
  options: { hole?: boolean; operation?: 'offset' | 'resize' } = {}
) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Face drag continuity');
  await page.getByRole('button', { name: 'New project' }).click();
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
  if (options.operation === 'resize') {
    await expect(
      page.getByRole('region', { name: 'Resize Body operation' })
    ).toBeVisible();
  } else {
    await page
      .locator('.selection-rail')
      .getByRole('button', { name: 'Selection: Offset', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Offset Face operation' })
    ).toBeVisible();
  }
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
  await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(-value, 3);
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
  // This holed side must use the exact stream: a body stretch would also
  // deform the bore. Exercise validation locking on that route explicitly.
  await page.addInitScript(() => {
    window.__openzcadE2EExactFaceDrag = true;
  });
  const { canvas, handle } = await armedBox(page, { hole: true });
  await page.evaluate(() => {
    window.__holdFinal!.hold = true;
  });
  const endX = handle.x + handle.dx * handle.pixels * 3;
  const endY = handle.y + handle.dy * handle.pixels * 3;
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 12 });
  await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(-3, 3);
  await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');
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

test(
  'clicking the face and at once dragging its arrow never takes the body',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(process.env.CI ? 240_000 : 120_000);
    await holdValidation(page);
    const { canvas, handle } = await armedBox(page);
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
        attributeFilter: ['data-e2e-selected-face', 'data-e2e-offset-ghost']
      });
    });
    await page.evaluate(() => {
      window.__holdFinal!.hold = true;
    });
    // The arrow stands where the face was clicked, so the grab that follows
    // a click lands on the same spot inside the double-click interval and the
    // operating system counts it as the second click. Playwright sends the
    // count it is given rather than working it out, so say what the OS says.
    await page.mouse.click(handle.x, handle.y);
    const pressed = await now(page);
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.move(
      handle.x + handle.dx * handle.pixels * 3,
      handle.y + handle.dy * handle.pixels * 3,
      { steps: 12 }
    );
    await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(-3, 3);
    await page.mouse.up({ clickCount: 2 });
    // A click re-arms a box side as Resize Body, whichever card the drag
    // started from.
    const card = page.getByRole('region', { name: / operation$/ });
    await expect
      .poll(() => page.evaluate(() => window.__holdFinal!.held))
      .toBe(1);
    // That release ended a drag, not a double-click: it used to select the
    // whole body for the frames until the commit, dropping the handle, ghost
    // and preview so the unedited part flashed lavender.
    await page.waitForTimeout(300);
    await expect(card).toContainText('Validating');
    await expect(canvas).toHaveAttribute('data-e2e-offset-ghost', '1');
    await expect(
      page.getByRole('button', { name: 'Selection: Move', exact: true })
    ).toHaveCount(0);
    expect(await removals(page, 'data-e2e-selected-face', pressed)).toBe(0);
    expect(await removals(page, 'data-e2e-offset-ghost', pressed)).toBe(0);
    await page.evaluate(() => window.__holdFinal!.release());
    await expect(page.getByText('depth set to', { exact: false })).toBeVisible({
      timeout: 30_000
    });
    await expect(
      page.getByRole('button', { name: 'Selection: Move', exact: true })
    ).toHaveCount(0);

    // Two clicks that stay put are still a double-click, and take the body.
    const besideX = handle.x - handle.dy * 40;
    const besideY = handle.y + handle.dx * 40;
    await page.mouse.dblclick(besideX, besideY);
    await expect(
      page.locator('.selection-readout .selection-callout-name')
    ).toHaveText('Box 1');
  }
);

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

test(
  'a refused generic face drag holds its last exact preview',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(process.env.CI ? 240_000 : 120_000);
    await page.addInitScript(() => {
      window.__openzcadE2EExactFaceDrag = true;
    });
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
    const front = () =>
      canvas.evaluate(
        (element) =>
          new Promise<number | null>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-render-policy', {
                detail: {
                  resolve: (state: {
                    bodyFaces: { worldBounds?: { min: number[] } }[];
                  }) =>
                    resolve(
                      state.bodyFaces.find((face) => face.worldBounds)
                        ?.worldBounds?.min[1] ?? null
                    )
                }
              })
            );
          })
      );
    for (let value = 1; value <= 5; value++) await to(value);
    await expect.poll(front).toBeCloseTo(5, 4);
    // At 6 mm the face reaches the Ø6 hole. Generic faces deliberately use
    // exact worker previews; an affine height proxy would distort that hole.
    for (let value = 7; value <= 9; value++) await to(value);
    // Total measures to the opposing plane, skipping the hole wall (#1331):
    // the refused 9 mm push reads 18 - 9 = 9 mm, independently of the exact
    // 5 mm preview still displayed.
    await expect(page.getByTestId('direct-manipulation-value')).toContainText(
      '9 mm'
    );
    await expect(page.getByTestId('direct-manipulation-value')).toHaveAttribute(
      'data-state',
      'warning'
    );
    await expect.poll(front).toBeCloseTo(5, 4);
    await expect(canvas).toHaveAttribute('data-e2e-offset-ghost', '1');
    expect(await removals(page, 'data-e2e-offset-ghost', pressed)).toBe(0);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect.poll(front).toBeCloseTo(0, 4);
  }
);

test(
  'a stale-selection release refusal restores the committed face anchor',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      window.__openzcadE2EExactFaceDrag = true;
      const scope = window as unknown as { refuseRelease: boolean };
      scope.refuseRelease = false;
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, transfer) {
        const request = message as { type?: string; requestId?: string };
        if (scope.refuseRelease && request.type === 'sync') {
          window.setTimeout(
            () =>
              this.dispatchEvent(
                new MessageEvent('message', {
                  data: {
                    type: 'sync',
                    ok: false,
                    requestId: request.requestId,
                    error: 'The selected face no longer exists.',
                    // A lost reference crosses the worker typed, as the
                    // worker reports one (`workerRefusal.ts`); the app
                    // routes a stale pick on this code, never the sentence.
                    refusal: {
                      family: 'reference',
                      category: 'invalid_input',
                      code: 'reference_missing'
                    }
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
    const { canvas, handle } = await armedBox(page);
    const anchor = () =>
      canvas.evaluate((element) => [
        Number(element.dataset.e2eChipAnchorWorldX),
        Number(element.dataset.e2eChipAnchorWorldY),
        Number(element.dataset.e2eChipAnchorWorldZ)
      ]);
    const committedAnchor = await anchor();
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(
      handle.x - handle.dx * handle.pixels * 6,
      handle.y - handle.dy * handle.pixels * 6,
      { steps: 12 }
    );
    await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(6, 4);
    await page.evaluate(() => {
      (window as unknown as { refuseRelease: boolean }).refuseRelease = true;
    });
    await page.mouse.up();
    const chip = page.getByTestId('direct-manipulation-value');
    await expect(chip).toHaveAttribute('data-state', 'warning');
    await expect(chip).toContainText('12 mm');
    await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(0, 4);
    await expect.poll(anchor).toEqual(committedAnchor);
    await expect(canvas).not.toHaveAttribute('data-e2e-offset-ghost');
    await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');
    // Moving over the restored part cannot bring back a rejected projection.
    await page.mouse.move(handle.x + 40, handle.y + 20, { steps: 6 });
    await frames(page);
    await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(0, 4);
    await expect.poll(anchor).toEqual(committedAnchor);
    await expect(
      page.locator('.feature-row-main', { hasText: 'Offset face' })
    ).toHaveCount(0);
    // The warning chip still edits the refused total, not the restored span.
    await chip.click();
    const keypad = page.getByRole('dialog', { name: 'Total value' });
    await expect(keypad.getByRole('textbox')).toHaveValue('12');
  }
);

for (const cancel of ['Escape', 'click-away', 'tool switch'] as const) {
  test(`a ${cancel} abandons every typed face preview visual`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const { canvas } = await armedBox(page);
    const anchor = () =>
      canvas.evaluate((element) => [
        Number(element.dataset.e2eChipAnchorWorldX),
        Number(element.dataset.e2eChipAnchorWorldY),
        Number(element.dataset.e2eChipAnchorWorldZ)
      ]);
    const committedAnchor = await anchor();
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Total value' });
    await keypad.getByRole('textbox').fill('21');
    await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(-3, 3);
    await expect(canvas).toHaveAttribute('data-e2e-offset-ghost', '1');
    if (cancel === 'Escape') await keypad.getByRole('textbox').press('Escape');
    else if (cancel === 'click-away')
      await canvas.click({ position: { x: 5, y: 5 } });
    else await page.getByRole('button', { name: 'View', exact: true }).click();
    await expect(keypad).toBeHidden();
    await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(0, 3);
    await expect(canvas).not.toHaveAttribute('data-e2e-offset-ghost');
    await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');
    if (cancel === 'Escape') await expect.poll(anchor).toEqual(committedAnchor);
    await expect(
      page.locator('.feature-row-main', { hasText: 'Offset face' })
    ).toHaveCount(0);
  });
}

test('a refused release retains the accepted face, handle and next pick', async ({
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
  const anchor = () =>
    canvas.evaluate((element) => [
      Number(element.dataset.e2eChipAnchorWorldX),
      Number(element.dataset.e2eChipAnchorWorldY),
      Number(element.dataset.e2eChipAnchorWorldZ)
    ]);
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
  // Through the back of the box: keep the last accepted preview (#731).
  await page.mouse.move(at(24).x, at(24).y, { steps: 12 });
  await page.mouse.up();
  const card = page.getByRole('region', { name: 'Offset Face operation' });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('Validating', { timeout: 30_000 });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(0);
  await expect(canvas).not.toHaveAttribute('data-e2e-offset-ghost');
  await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');
  // Intermediate moves can build too: compare to the last shape actually
  // retained, rather than assuming the first 6 mm preview was the last one.
  const retainedY = await renderedMinimumY(canvas);
  expect(retainedY).toBeGreaterThan(0);
  expect(retainedY).toBeLessThan(18);
  // The arrow is pinned to the retained face, not the refused -24 mm input.
  await expect.poll(async () => (await anchor())[1]).toBeCloseTo(retainedY, 4);
  await expect(canvas).not.toHaveAttribute(
    'data-e2e-selected-face',
    armedFace!
  );
  await expect(chip).toHaveAttribute('data-state', 'warning');
  await expect(chip).toContainText('-6 mm');
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
  await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(-3, 3);
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

/** Logs the selection recede (`data-e2e-recede-levels`) from now on. */
async function recordRecede(canvas: Locator) {
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
      attributeFilter: ['data-e2e-selection-recedes', 'data-e2e-recede-levels']
    });
  });
}

/** One body's recede level out of a `data-e2e-recede-levels` value. */
function recedeLevel(value: string | null, bodyId: string): number | null {
  const entry = (value ?? '')
    .split(',')
    .find((pair) => pair.startsWith(`${bodyId}=`));
  return entry === undefined ? null : Number(entry.slice(bodyId.length + 1));
}

/** Every level the body was drawn at since `from`, in order. */
async function recedeLevels(page: Page, bodyId: string, from: number) {
  const log = await page.evaluate(
    (from) =>
      (window.__faceDragLog ?? []).filter(
        (entry) => entry.t >= from && entry.name === 'data-e2e-recede-levels'
      ),
    from
  );
  return log.map((entry) => recedeLevel(entry.value, bodyId));
}

test(
  'a face drag keeps the rest receded from release through its commit',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(process.env.CI ? 240_000 : 120_000);
    const { canvas, handle } = await armedBox(page);
    // The face pick recedes its own body around the lit face.
    await expect(canvas).toHaveAttribute('data-e2e-selection-recedes', 'true');
    const bodyId = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
    expect(bodyId).toBeTruthy();
    await expect
      .poll(async () =>
        recedeLevel(await canvas.getAttribute('data-e2e-recede-levels'), bodyId)
      )
      .toBe(1);
    await recordRecede(canvas);
    const pressed = await now(page);
    await dragAndCommit(page, canvas, handle, handle.x, handle.y, 3);
    // Through the rebuild that follows the commit, and a little after it.
    await page.waitForTimeout(1200);
    await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
    // The moved face stayed the pick, so the scene never came back to full
    // brightness around it, for a single frame, across preview, release,
    // validation and the rebuilt geometry.
    expect(await removals(page, 'data-e2e-selection-recedes', pressed)).toBe(0);
    const levels = await recedeLevels(page, bodyId, pressed);
    expect(
      levels.filter((level) => level !== 1),
      JSON.stringify(levels)
    ).toEqual([]);
  }
);

test(
  'when a resize commit ends the pick, the scene eases back rather than popping',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(process.env.CI ? 240_000 : 120_000);
    // A box side arms Resize Body, whose commit ends the pick (its handle
    // measures the whole length, so it does not re-arm on the moved face).
    const { canvas, handle } = await armedBox(page, { operation: 'resize' });
    const bodyId = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
    expect(bodyId).toBeTruthy();
    await expect
      .poll(async () =>
        recedeLevel(await canvas.getAttribute('data-e2e-recede-levels'), bodyId)
      )
      .toBe(1);
    await recordRecede(canvas);
    const pressed = await now(page);
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(
      handle.x + handle.dx * handle.pixels * 3,
      handle.y + handle.dy * handle.pixels * 3,
      { steps: 12 }
    );
    await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(-3, 3);
    await page.mouse.up();
    await expect(page.getByText('depth set to', { exact: false })).toBeVisible({
      timeout: 30_000
    });
    await expect(canvas).not.toHaveAttribute('data-e2e-selection-recedes');
    await expect
      .poll(async () =>
        recedeLevel(await canvas.getAttribute('data-e2e-recede-levels'), bodyId)
      )
      .toBe(0);
    // Every frame from the release: held at the recede until the pick ended,
    // then down through intermediate levels, never 1 → 0 in one frame.
    const out = await recedeLevels(page, bodyId, pressed);
    const label = JSON.stringify(out);
    const leaving = out.lastIndexOf(1);
    expect(leaving, label).toBeGreaterThanOrEqual(0);
    const easing = out.slice(leaving + 1);
    expect(easing.at(-1), label).toBe(0);
    expect(
      easing.filter((level) => level !== null && level > 0 && level < 1).length,
      label
    ).toBeGreaterThan(0);
    for (let index = 1; index < easing.length; index++)
      expect(easing[index]!, label).toBeLessThanOrEqual(easing[index - 1]!);

    // The next pick eases the scene back in the same way.
    const picked = await now(page);
    await selectFace(canvas, { x: 0, y: -1, z: 0 });
    await expect
      .poll(async () =>
        recedeLevel(await canvas.getAttribute('data-e2e-recede-levels'), bodyId)
      )
      .toBe(1);
    const back = await recedeLevels(page, bodyId, picked);
    const backLabel = JSON.stringify(back);
    expect(
      back.filter((level) => level !== null && level > 0 && level < 1).length,
      backLabel
    ).toBeGreaterThan(0);
    for (let index = 1; index < back.length; index++)
      expect(back[index]!, backLabel).toBeGreaterThanOrEqual(back[index - 1]!);
  }
);

test('a commit reads as complete while its follow-up rebuild analyses', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await slowAnalysis(page);
  const { canvas } = await armedBox(page);
  const drag = async (value: number) => {
    const current = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      pixels: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(bounds.x + current.x, bounds.y + current.y);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + current.x + current.dx * current.pixels * value,
      bounds.y + current.y + current.dy * current.pixels * value,
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
  await page.evaluate(() => {
    window.__slowAnalysis!.manual = true;
  });
  const held = await page.evaluate(() => window.__slowAnalysis!.held);
  await drag(1);
  await expect
    .poll(() => page.evaluate(() => window.__slowAnalysis!.held))
    .toBeGreaterThan(held);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(3, { timeout: 30_000 });
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).not.toContainText('Validating');
  await drag(-1);
  await page.evaluate(() => {
    window.__slowAnalysis!.armed = false;
    window.__slowAnalysis!.release!();
  });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(4, { timeout: 30_000 });
  await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(-5, 3);
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
  await page.getByRole('button', { name: 'New project' }).click();
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
  // U09 names a removable detail by its feature. Prove the actual face and
  // radius edit remain armed, rather than depending on the older label.
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
  await page.getByTestId('direct-manipulation-value').click();
  await expect(keypad).toBeVisible();
  await expect(keypad.getByRole('textbox')).toHaveValue('2');
  await keypad.getByRole('textbox').press('Escape');
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
  await expect.poll(() => renderedMinimumY(canvas)).toBeCloseTo(-3, 3);
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
