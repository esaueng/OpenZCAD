import type { Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi,
  expectBodyCount,
  enableFullRender,
  locateEdge,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * Viewer state must not replay or blink when something unrelated changes:
 * a normal-to-face glide is one camera move, not one per later update, and
 * an armed handle is not rebuilt (faded out and back in) because its card,
 * keypad or a preview re-derived the same target.
 */

declare global {
  interface Window {
    __handleLog?: { t: number; value: string | null }[];
    __holdFinal?: { hold: boolean; held: number; release(): void };
    __highlightShaderWork?: {
      links: number;
      initializations: number;
      warmDraws: number;
    };
  }
}

interface CameraState {
  position: number[];
  target: number[];
}

function camera(canvas: Locator): Promise<CameraState> {
  return canvas.evaluate(
    (element) =>
      new Promise<CameraState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-input-state', {
            detail: {
              resolve: (state: { camera: CameraState }) => resolve(state.camera)
            }
          })
        );
      })
  );
}

async function newProject(page: Page, name: string) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
}

async function addBox(page: Page) {
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
}

test('first hover reuses prepared highlight shaders after a body rebuild', async ({
  page
}) => {
  await enableFullRender(page);
  await page.addInitScript(() => {
    const counts = (window.__highlightShaderWork = {
      links: 0,
      initializations: 0,
      warmDraws: 0
    });
    const prototype = WebGL2RenderingContext.prototype;
    for (const name of [
      'linkProgram',
      'getProgramInfoLog',
      'drawArrays',
      'drawElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
      'clear',
      'clearBufferiv',
      'clearBufferuiv',
      'clearBufferfv',
      'clearBufferfi'
    ] as const) {
      const original = prototype[name];
      Object.defineProperty(prototype, name, {
        configurable: true,
        writable: true,
        value: function (this: WebGL2RenderingContext, ...args: unknown[]) {
          if (
            this.canvas instanceof HTMLCanvasElement &&
            this.canvas.closest('.viewer-host')
          ) {
            if (name === 'linkProgram') counts.links++;
            else if (name === 'getProgramInfoLog') counts.initializations++;
            else if (
              performance.getEntriesByName(
                'oz:viewer.interactionShaderReflection:start'
              ).length
            )
              counts.warmDraws++;
          }
          return Reflect.apply(original, this, args) as unknown;
        }
      });
    }
  });
  await newProject(page, 'Prepared hover shaders');
  await addBox(page);
  await page.waitForFunction(
    () =>
      performance.getEntriesByName('oz:viewer.interactionShaders:ready')
        .length > 0
  );
  // A new exact result replaces edge materials. The warm-up owners must keep
  // their programs alive independently of that first body's material lifetime.
  await createPrimitiveInPlace(page, 'cylinder', { at: { x: 30 } });
  await expectBodyCount(page, 2);
  await page.keyboard.press('Escape');
  const canvas = page.locator('.viewer-host canvas').first();
  const before = await page.evaluate(() => ({
    ...window.__highlightShaderWork!
  }));
  const box = (await canvas.boundingBox())!;
  let sawFace = false;
  for (let row = 0; row < 5 && !sawFace; row++) {
    for (let column = 0; column < 7 && !sawFace; column++) {
      await page.mouse.move(
        box.x + box.width * (0.25 + column / 12),
        box.y + box.height * (0.3 + row / 12)
      );
      sawFace = await canvas.evaluate(
        (element) =>
          new Promise<boolean>((resolve) => {
            requestAnimationFrame(() =>
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-hover-face-state', {
                  detail: {
                    resolve: (state: {
                      slots: { visible: boolean; triangleCount: number }[];
                    }) =>
                      resolve(
                        state.slots.some(
                          (slot) => slot.visible && slot.triangleCount > 0
                        )
                      )
                  }
                })
              )
            );
          })
      );
    }
  }
  expect(sawFace).toBe(true);
  const edge = await locateEdge(page);
  const frames = Number(await canvas.getAttribute('data-e2e-frames'));
  await page.mouse.move(edge.x, edge.y);
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-e2e-frames')))
    .toBeGreaterThan(frames + 2);
  expect(await page.evaluate(() => window.__highlightShaderWork)).toEqual({
    ...before,
    warmDraws: 0
  });
});

test('failed highlight shaders still report their compiler diagnostics', async ({
  page
}) => {
  await enableFullRender(page);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    const source = WebGL2RenderingContext.prototype.shaderSource;
    let injected = false;
    WebGL2RenderingContext.prototype.shaderSource = function (shader, code) {
      if (
        !injected &&
        this.canvas instanceof HTMLCanvasElement &&
        this.canvas.closest('.viewer-host') &&
        performance.getEntriesByName('oz:viewer.interactionShaders:begin')
          .length > 0
      ) {
        injected = true;
        code += '\n__oz_shader_diagnostics_failure__\n';
      }
      source.call(this, shader, code);
    };
  });
  await newProject(page, 'Shader failure diagnostics');
  await addBox(page);
  await expect.poll(() => errors.join('\n')).toContain('Shader Error');
  await expect
    .poll(() => errors.join('\n'))
    .toContain('__oz_shader_diagnostics_failure__');
  await expectBodyCount(page, 1);
});

test('the activity lane yields the prompt placeholder to guidance only while no pill is present', async ({
  page
}) => {
  await newProject(page, 'Prompt lane styling');
  await addBox(page);
  await page.keyboard.press('Escape');
  const input = page.locator('.command-bar-input').first();
  await input.blur();
  await expect(page.locator('.workspace-hint')).toBeVisible({
    timeout: 15_000
  });
  const color = () =>
    input.evaluate(
      (element) => getComputedStyle(element, '::placeholder').color
    );
  await expect.poll(color).toBe('rgba(0, 0, 0, 0)');
  await page.evaluate(() => {
    const pill = document.createElement('div');
    pill.className = 'activity-pill';
    document.querySelector('.activity-lane')!.append(pill);
  });
  try {
    await expect.poll(color).not.toBe('rgba(0, 0, 0, 0)');
    await expect(page.locator('.workspace-hint')).toBeHidden();
  } finally {
    await page
      .locator('.activity-lane > .activity-pill')
      .evaluate((element) => element.remove());
  }
  await expect.poll(color).toBe('rgba(0, 0, 0, 0)');
});

test('notice offsets stay local without inheriting through model rows', async ({
  page
}) => {
  await newProject(page, 'Notice offsets');
  await addBox(page);
  await page.keyboard.press('Escape');
  const states = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.viewer-area')!;
    const originals = [
      ...root.querySelectorAll<HTMLElement>('.workspace-toast')
    ].map((node) => ({ node, className: node.className }));
    for (const { node } of originals) node.classList.add('hidden');
    const status = document.createElement('div');
    status.className = 'workspace-toast hidden';
    const action = document.createElement('div');
    action.className = 'toast closing';
    const refusal = document.createElement('div');
    refusal.className = 'selection-refusal-lane';
    const activity = document.createElement('div');
    activity.className = 'activity-lane';
    const pill = document.createElement('div');
    pill.className = 'activity-pill';
    activity.append(pill);
    const command = document.createElement('div');
    command.className = 'in-place-command';
    // Read final offsets of these synthetic notices, without transition interpolation.
    for (const node of [action, refusal]) {
      node.style.transition = 'none';
      node.style.animation = 'none';
    }
    const read = () => ({
      action: parseFloat(getComputedStyle(action).bottom),
      refusal: parseFloat(getComputedStyle(refusal).bottom),
      row: getComputedStyle(root.querySelector('.body-row')!).getPropertyValue(
        '--lane-status'
      )
    });
    try {
      root.append(status, action, refusal);
      const base = read();
      status.className = 'workspace-toast running';
      const running = read();
      root.append(activity);
      const active = read();
      activity.remove();
      status.className = 'workspace-toast hidden';
      root.append(command);
      const commandHeight =
        parseFloat(
          getComputedStyle(command).getPropertyValue('--in-place-command-h')
        ) || 38;
      const inCommand = read();
      status.className = 'workspace-toast running';
      const commandAndStatus = read();
      command.remove();
      status.className = 'workspace-toast ready';
      action.className = 'toast';
      const settled = read();
      return {
        base,
        running,
        active,
        commandHeight,
        inCommand,
        commandAndStatus,
        settled
      };
    } finally {
      for (const node of [status, action, refusal, activity, command])
        node.remove();
      for (const { node, className } of originals) node.className = className;
    }
  });
  for (const key of ['action', 'refusal'] as const) {
    expect(states.running[key] - states.base[key]).toBeCloseTo(40, 0);
    expect(states.active[key] - states.base[key]).toBeCloseTo(70, 0);
    expect(states.inCommand[key] - states.base[key]).toBeCloseTo(
      states.commandHeight + 10,
      0
    );
    expect(states.commandAndStatus[key] - states.base[key]).toBeCloseTo(
      states.commandHeight + 50,
      0
    );
    expect(states.settled[key]).toBeCloseTo(states.base[key], 0);
  }
  for (const state of [
    states.base,
    states.running,
    states.active,
    states.inCommand,
    states.commandAndStatus,
    states.settled
  ])
    expect(state.row).toBe('');
});

test('orbiting without a handle skips chip panel layout', async ({ page }) => {
  await newProject(page, 'Viewer frame work');
  await addBox(page);
  await page.keyboard.press('Escape');
  const canvas = page.locator('.viewer-host canvas').first();
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /.+/);
  await page.evaluate(() => {
    const scope = window as typeof window & { __chipPanelScans?: number };
    scope.__chipPanelScans = 0;
    const query = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (
      this: Element,
      selectors: string
    ) {
      if (selectors.includes('.stage-right > *')) scope.__chipPanelScans! += 1;
      return query.call(this, selectors);
    };
  });
  const before = Number(await canvas.getAttribute('data-e2e-frames'));
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 120, box.y + box.height - 140);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + box.height - 240, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-e2e-frames')))
    .toBeGreaterThan(before + 3);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __chipPanelScans: number })
          .__chipPanelScans
    )
  ).toBe(0);
});

test('a stationary cube hover stays asleep after another frame is requested', async ({
  page
}) => {
  await newProject(page, 'Cube hover settles');
  await addBox(page);
  const canvas = page.locator('.viewer-host canvas').first();
  const face = page.locator('.orientation-cube .cube-face:visible').first();
  // The centroid is inside the actual facet, rather than a bounding box that
  // may cover another facet of the projected cube.
  const point = await face.evaluate((element) => {
    const polygon = element as SVGPolygonElement;
    const matrix = polygon.getScreenCTM()!;
    const points = Array.from(polygon.points);
    const projected = new DOMPoint(
      points.reduce((sum, p) => sum + p.x, 0) / points.length,
      points.reduce((sum, p) => sum + p.y, 0) / points.length
    ).matrixTransform(matrix);
    return { x: projected.x, y: projected.y };
  });
  await page.mouse.move(point.x, point.y);
  await face.dispatchEvent('pointerover');
  await page.waitForTimeout(500);
  // Repaint while the fill is already at its target. The previous fade
  // stepped away from 1 again and requested redundant fade frames.
  await canvas.evaluate((element) =>
    element.dispatchEvent(
      new CustomEvent('openzcad:e2e-pixel-ratio', {
        detail: { value: devicePixelRatio }
      })
    )
  );
  await page.waitForTimeout(700);
  const settled = await canvas.getAttribute('data-e2e-frames');
  await page.waitForTimeout(350);
  expect(await canvas.getAttribute('data-e2e-frames')).toBe(settled);
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

test('a normal-to-face glide does not replay when the bodies change later', async ({
  page
}) => {
  await newProject(page, 'Normal to face once');
  await addBox(page);
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          new Promise((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: { normal: { x: 0, y: 0, z: 1 }, resolve }
              })
            );
          })
      )
    )
    .not.toBeNull();
  const viewDirection = (pose: CameraState) => {
    const direction = pose.position.map(
      (value, axis) => value - pose.target[axis]!
    );
    const length = Math.hypot(...direction);
    return direction.map((value) => value / length);
  };
  const faceOn = (pose: CameraState) => Math.abs(viewDirection(pose)[2]!);
  // The pick hook resolves before React commits its selection. Let the
  // initial framing and picked-face state settle before the shortcut.
  await expect(
    page.getByRole('group', { name: 'Picked', exact: true })
  ).toBeVisible();
  await waitForStillViewport(page);
  await page.keyboard.press('Space');
  // The glide ends looking straight down the face normal.
  await expect
    .poll(async () => faceOn(await camera(canvas)), { timeout: 15_000 })
    .toBeGreaterThan(0.999);
  await page.waitForTimeout(300);

  // Turn away from the face, pressing on empty canvas (the armed face would
  // take the press as a push/pull).
  const box = (await canvas.boundingBox())!;
  const fromX = box.x + 120;
  const fromY = box.y + box.height - 140;
  await page.keyboard.down('Shift');
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + 30, fromY - 180, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  // Consecutive reads may see the same RAF while damping still runs.
  // Require a full quiet window before taking the reference pose.
  await waitForStillViewport(page);
  const turned = await camera(canvas);
  // Turned well away from looking straight down the face normal.
  expect(faceOn(turned)).toBeLessThan(0.99);

  // Hiding and showing the body hands the viewer new bodies, with the face
  // still in them: the camera must stay where the user turned it.
  await page.getByRole('button', { name: 'Hide body Box 1' }).click();
  await page.getByRole('button', { name: 'Show body Box 1' }).click();
  await expectBodyCount(page, 1);
  await waitForStillViewport(page);
  const after = await camera(canvas);
  // Not glided back to the face: still looking the way it was turned (a
  // re-frame may nudge the distance, not the direction).
  expect(faceOn(after)).toBeLessThan(0.99);
  const before = viewDirection(turned);
  const alignment = viewDirection(after).reduce(
    (sum, value, axis) => sum + value * before[axis]!,
    0
  );
  expect(alignment).toBeGreaterThan(0.9999);
});

test('the edge radius handle is not rebuilt when its keypad opens or a preview lands', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await newProject(page, 'Edge handle steady');
  await addBox(page);
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
  await expect(canvas).toHaveAttribute('data-e2e-edge-rig-builds', /\d+/);
  const builds = () =>
    canvas.evaluate((element) => Number(element.dataset.e2eEdgeRigBuilds));
  const armed = await builds();

  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Radius value' });
  await expect(keypad).toBeVisible();
  await page.waitForTimeout(300);
  expect(await builds()).toBe(armed);

  await keypad.getByRole('textbox').fill('2');
  await expect
    .poll(() =>
      canvas.evaluate((element) =>
        Number(element.dataset.e2ePreviewBlendCount ?? 0)
      )
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(await builds()).toBe(armed);
});

test('hiding a body takes its armed edge handle with it', async ({ page }) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await newProject(page, 'Edge handle hidden body');
  await addBox(page);
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
  await expect(canvas).toHaveAttribute(
    'data-e2e-chip-anchor-rig',
    'edge-radius'
  );
  await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();

  await page.getByRole('button', { name: 'Hide body Box 1' }).click();
  await expectBodyCount(page, 0);
  // No handle left floating where the hidden body was, to edit it unseen.
  await expect(page.getByTestId('direct-manipulation-value')).toBeHidden();
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /.+/);
});

test('the cylinder radius handle stays on screen while its release validates', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await holdValidation(page);
  await newProject(page, 'Cylinder handle steady');
  await createPrimitiveInPlace(page, 'cylinder');
  await expectBodyCount(page, 1);
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: { surface: 'wall' }
          })
        )
      );
      return canvas.getAttribute('data-e2e-chip-anchor-rig');
    })
    .toBe('cylinder-radius');
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixels: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  const x = bounds.x + handle.x;
  const y = bounds.y + handle.y;

  await canvas.evaluate((element) => {
    const log: { t: number; value: string | null }[] = [];
    window.__handleLog = log;
    new MutationObserver(() =>
      log.push({
        t: performance.now(),
        value: element.getAttribute('data-e2e-handle-x')
      })
    ).observe(element, {
      attributes: true,
      attributeFilter: ['data-e2e-handle-x']
    });
  });
  await page.evaluate(() => {
    window.__holdFinal!.hold = true;
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    x + handle.dx * handle.pixels * 2,
    y + handle.dy * handle.pixels * 2,
    { steps: 12 }
  );
  const released = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.__holdFinal!.held))
    .toBeGreaterThan(0);
  await page.waitForTimeout(500);
  // Held where it was let go for the whole validation.
  expect(
    await page.evaluate(
      (from) =>
        (window.__handleLog ?? []).filter(
          (entry) => entry.t >= from && !entry.value
        ).length,
      released
    )
  ).toBe(0);
  await page.evaluate(() => window.__holdFinal!.release());
});
