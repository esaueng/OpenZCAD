import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubApi } from './openzcad-fixtures';

interface Point3 {
  x: number;
  y: number;
  z: number;
}

interface FaceProbe {
  x: number;
  y: number;
  bodyId: string;
  topologyId: string;
  geometry: {
    surfaceType: string;
    featureType?: string;
    radius?: number;
    diameter?: number;
    axisStart?: Point3;
    axisEnd?: Point3;
  };
  pickList?: {
    x: number;
    y: number;
    labels: string[];
    topologyIds: string[];
    kinds: ('face' | 'edge')[];
  };
}

interface EdgeProbe {
  topologyId: string;
  curveType?: string;
  circleRadius?: number;
  pointCount: number;
  closureGap: number;
  closed: boolean;
}

interface BlendProbe {
  topologyId: string;
  blendRadius: number;
  producingFeatureId?: string;
  point: Point3;
  x?: number;
  y?: number;
}

interface ColorSample {
  pixels: number[];
}

interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  orthographicZoom: number;
  orthographicHalfHeight?: number;
}

interface InputState {
  camera: CameraState;
  controlsEnabled: boolean;
  controlState: number | null;
}

interface ChipAnchor {
  rig: string;
  screen: { x: number; y: number };
  world: Point3;
}

/**
 * Budget for the polls that wait on the viewport republishing topology after
 * an action.
 *
 * Each iteration is a round trip into the viewport's main thread, and the
 * geometry worker competes for that same thread. Instrumenting the two that
 * timed out showed the hook running exactly once and returning the right
 * answer, so what these wait on is transport, not readiness. CI already grants
 * every assertion 30 s; naming the same budget here keeps a heavily parallel
 * local run from failing while the product is behaving correctly.
 */
const REPUBLISH = { timeout: 30_000 } as const;

const REBUILDING =
  /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i;

async function probeFace(
  canvas: Locator,
  surface: 'bore' | 'annulus' | 'outer-wall',
  interaction: 'select' | 'hover' | 'inspect' | 'clear' = 'select',
  includePickList = false
): Promise<FaceProbe | null> {
  return canvas.evaluate(
    (element, request) =>
      new Promise<FaceProbe | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-visual-selection-probe', {
            detail: { ...request, resolve }
          })
        );
      }),
    { surface, interaction, includePickList }
  );
}

async function selectOuterCircle(canvas: Locator): Promise<EdgeProbe | null> {
  return canvas.evaluate(
    (element) =>
      new Promise<EdgeProbe | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-edge', {
            detail: {
              curve: 'circle',
              role: 'outer-circle',
              resolve
            }
          })
        );
      })
  );
}

async function readBlend(
  canvas: Locator,
  blendRadius: number,
  select = false
): Promise<BlendProbe | null> {
  return canvas.evaluate(
    (element, request) =>
      new Promise<BlendProbe | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-blend', {
            detail: { ...request, resolve }
          })
        );
      }),
    { blendRadius, select }
  );
}

async function readInputState(canvas: Locator): Promise<InputState> {
  return canvas.evaluate(
    (element) =>
      new Promise<InputState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-input-state', {
            detail: { resolve }
          })
        );
      })
  );
}

async function controlPointer(
  canvas: Locator,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: {
    pointerId: number;
    button: number;
    buttons: number;
    clientX: number;
    clientY: number;
    shiftKey: boolean;
  }
): Promise<InputState> {
  return canvas.evaluate(
    (element, request) =>
      new Promise<InputState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-control-pointer', {
            detail: { ...request, resolve }
          })
        );
      }),
    { type, init }
  );
}

async function settleRender(canvas: Locator) {
  await canvas.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

/**
 * Waits until the render loop stops moving the camera after an orbit.
 *
 * Sampling this from Node cost one round trip per sample and needed three
 * consecutive still ones, so the wait only ever finished if at least four
 * probes completed inside its budget. Each round trip runs to seconds when
 * the viewport's main thread is contended, which spent the budget on
 * transport rather than on the coast being measured.
 *
 * The loop belongs in the page. OrbitControls damps per rendered frame, so
 * consecutive frames — not wall-clock samples — are the unit that decides
 * when the coast is over, and the whole wait costs one round trip.
 */
async function waitForCameraToSettle(canvas: Locator) {
  const settled = await canvas.evaluate(
    (element, budgetMs) =>
      new Promise<boolean>((resolve) => {
        const readPosition = () => {
          let position: [number, number, number] | null = null;
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-input-state', {
              detail: {
                resolve: (state: {
                  camera: { position: [number, number, number] };
                }) => {
                  position = state.camera.position;
                }
              }
            })
          );
          return position;
        };
        const deadline = performance.now() + budgetMs;
        let previous: [number, number, number] | null = null;
        let stableFrames = 0;
        const step = () => {
          const current = readPosition();
          if (!current) {
            resolve(false);
            return;
          }
          if (
            previous &&
            Math.hypot(
              current[0] - previous[0],
              current[1] - previous[1],
              current[2] - previous[2]
            ) < 1e-4
          ) {
            stableFrames += 1;
          } else {
            stableFrames = 0;
          }
          previous = current;
          if (stableFrames >= 3) {
            resolve(true);
            return;
          }
          if (performance.now() > deadline) {
            resolve(false);
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    30_000
  );
  expect(settled).toBe(true);
}

async function sampleAround(
  page: Page,
  canvas: Locator,
  point: { x: number; y: number }
): Promise<ColorSample> {
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('Viewer canvas is not laid out.');
  }
  const size = 15;
  const screenshot = await page.screenshot({
    clip: {
      x: bounds.x + point.x - Math.floor(size / 2),
      y: bounds.y + point.y - Math.floor(size / 2),
      width: size,
      height: size
    }
  });
  return page.evaluate<ColorSample, string>(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const sample = document.createElement('canvas');
    sample.width = image.naturalWidth;
    sample.height = image.naturalHeight;
    const context = sample.getContext('2d');
    if (!context) {
      throw new Error('Could not inspect the viewport probe screenshot.');
    }
    context.drawImage(image, 0, 0);
    return {
      pixels: Array.from(
        context.getImageData(0, 0, sample.width, sample.height).data
      )
    };
  }, screenshot.toString('base64'));
}

function strongestCyanShift(highlight: ColorSample, base: ColorSample): number {
  let strongest = -Infinity;
  for (let offset = 0; offset < highlight.pixels.length; offset += 4) {
    const redShift = highlight.pixels[offset]! - base.pixels[offset]!;
    const greenShift = highlight.pixels[offset + 1]! - base.pixels[offset + 1]!;
    const blueShift = highlight.pixels[offset + 2]! - base.pixels[offset + 2]!;
    strongest = Math.max(strongest, blueShift - (redShift + greenShift) / 2);
  }
  return strongest;
}

function strongestCyanPixel(sample: ColorSample): number {
  let strongest = -Infinity;
  for (let offset = 0; offset < sample.pixels.length; offset += 4) {
    const red = sample.pixels[offset]!;
    const green = sample.pixels[offset + 1]!;
    const blue = sample.pixels[offset + 2]!;
    strongest = Math.max(strongest, blue - (red + green) / 2);
  }
  return strongest;
}

function readChipValue(text: string): number {
  const value = text.match(/-?\d+(?:\.\d+)?/)?.[0];
  if (!value) {
    throw new Error(`No numeric dimension in chip: ${text}`);
  }
  return Number(value);
}

async function readChipAnchor(canvas: Locator): Promise<ChipAnchor | null> {
  return canvas.evaluate((element) => {
    const values = {
      rig: element.dataset.e2eChipAnchorRig,
      x: Number(element.dataset.e2eChipAnchorX),
      y: Number(element.dataset.e2eChipAnchorY),
      worldX: Number(element.dataset.e2eChipAnchorWorldX),
      worldY: Number(element.dataset.e2eChipAnchorWorldY),
      worldZ: Number(element.dataset.e2eChipAnchorWorldZ)
    };
    if (
      !values.rig ||
      !Number.isFinite(values.x) ||
      !Number.isFinite(values.y) ||
      !Number.isFinite(values.worldX) ||
      !Number.isFinite(values.worldY) ||
      !Number.isFinite(values.worldZ)
    ) {
      return null;
    }
    return {
      rig: values.rig,
      screen: { x: values.x, y: values.y },
      world: { x: values.worldX, y: values.worldY, z: values.worldZ }
    };
  });
}

function subtract(
  left: [number, number, number],
  right: [number, number, number]
): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function dot(left: [number, number, number], right: [number, number, number]) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(
  left: [number, number, number],
  right: [number, number, number]
): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function normalized(value: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...value);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function projectExpectedAnchor(
  world: Point3,
  camera: CameraState,
  width: number,
  height: number
): { x: number; y: number } {
  const forward = normalized(subtract(camera.target, camera.position));
  const right = normalized(cross(forward, [0, 0, 1]));
  const up = normalized(cross(right, forward));
  const relative = subtract([world.x, world.y, world.z], camera.position);
  const depth = dot(relative, forward);
  const tanHalfFov = Math.tan((45 * Math.PI) / 360);
  const ndcX = dot(relative, right) / (depth * tanHalfFov * (width / height));
  const ndcY = dot(relative, up) / (depth * tanHalfFov);
  return {
    x: ((ndcX + 1) / 2) * width,
    y: ((1 - ndcY) / 2) * height
  };
}

async function expectAnchorMatchesProjection(
  canvas: Locator,
  chip: Locator,
  expectedWorld: Point3
): Promise<ChipAnchor> {
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('Viewer canvas is not laid out.');
  }
  const anchor = await readChipAnchor(canvas);
  expect(anchor).not.toBeNull();
  expect(anchor!.rig).toBe('edge-radius');
  expect(anchor!.world.x).toBeCloseTo(expectedWorld.x, 6);
  expect(anchor!.world.y).toBeCloseTo(expectedWorld.y, 6);
  expect(anchor!.world.z).toBeCloseTo(expectedWorld.z, 6);
  const expected = projectExpectedAnchor(
    expectedWorld,
    (await readInputState(canvas)).camera,
    bounds.width,
    bounds.height
  );
  expect(anchor!.screen.x).toBeCloseTo(expected.x, 1);
  expect(anchor!.screen.y).toBeCloseTo(expected.y, 1);
  const style = await chip.evaluate((element) => ({
    left: Number.parseFloat(element.style.left),
    top: Number.parseFloat(element.style.top)
  }));
  expect(style.left).toBeCloseTo(anchor!.screen.x, 3);
  expect(style.top).toBeCloseTo(anchor!.screen.y, 3);
  return anchor!;
}

test('accepts exact visual selection and direct editing on the seeded boss', async ({
  page
}, testInfo) => {
  // Measured, not guessed. This scenario is ten sections long and does about
  // 23 s of real work on an idle machine, most of it waiting on the kernel:
  // two geometry rebuilds, a drag that streams preview topology, and an orbit.
  // None of that is a race the spec can gate away — instrumenting the probes
  // that time out showed each one running exactly once and returning the right
  // answer, so what runs out is wall clock, not readiness.
  //
  // Under parallel CPU load the same run takes 2.9-4.0 minutes, because the
  // geometry worker is contended too. At 180 s a contended shard therefore
  // failed the whole scenario mid-orbit. 300 s covers the worst run measured
  // under load heavier than CI's, with room to spare.
  test.setTimeout(300_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Visual Selection Reference/ })
    .click();

  const canvas = page.locator('.viewer-host canvas');
  const status = page.getByRole('contentinfo');
  const chip = page.getByTestId('direct-manipulation-value');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(status).not.toContainText(REBUILDING, { timeout: 60_000 });

  // 1. One exact annular face owns preselection; persistent selection stays empty.
  const annulus = await probeFace(canvas, 'annulus', 'hover');
  expect(annulus).not.toBeNull();
  await expect(canvas).toHaveAttribute(
    'data-e2e-hovered-face',
    annulus!.topologyId
  );
  await expect(canvas).not.toHaveAttribute('data-e2e-selected-face', /.+/);
  await settleRender(canvas);
  await testInfo.attach('angle-a-top-annulus-hover', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });

  // 2. The boss wall resolves as one full analytic cylinder, not triangles.
  const outerWall = await probeFace(canvas, 'outer-wall');
  expect(outerWall?.geometry.surfaceType).toBe('cylinder');
  expect(outerWall?.geometry.radius).toBeCloseTo(15, 6);
  expect(outerWall?.geometry.diameter).toBeCloseTo(30, 6);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-face',
    outerWall!.topologyId
  );
  await expect(chip).toHaveText('Ø 30 mm');

  // 3. The selected bore keeps the full through-hole identity behind the wall.
  let bore = await probeFace(canvas, 'bore');
  expect(bore?.geometry.featureType).toBe('through-hole');
  expect(bore?.geometry.diameter).toBeCloseTo(20, 6);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-face',
    bore!.topologyId
  );
  await settleRender(canvas);
  bore = await probeFace(canvas, 'bore');
  expect(bore).not.toBeNull();
  await settleRender(canvas);
  const selectedBorePixels = await sampleAround(page, canvas, bore!);
  await probeFace(canvas, 'bore', 'clear');
  await expect(canvas).not.toHaveAttribute('data-e2e-selected-face', /.+/);
  await settleRender(canvas);
  const unselectedBorePixels = await sampleAround(page, canvas, bore!);
  expect(
    strongestCyanShift(selectedBorePixels, unselectedBorePixels)
  ).toBeGreaterThan(5);

  // 4. The real select-other stack distinguishes the adjacent bore and annulus.
  bore = await probeFace(canvas, 'bore');
  const disambiguation = await probeFace(canvas, 'bore', 'inspect', true);
  expect(disambiguation?.pickList).toBeDefined();
  expect(disambiguation!.pickList!.topologyIds).toContain(bore!.topologyId);
  expect(disambiguation!.pickList!.topologyIds).toContain(annulus!.topologyId);
  await page.mouse.click(
    disambiguation!.pickList!.x,
    disambiguation!.pickList!.y,
    { button: 'right' }
  );
  const pickList = page.getByRole('menu', { name: 'Select other' });
  await expect(pickList).toBeVisible();
  const pickRows = pickList.getByRole('menuitem');
  await expect(pickRows).toHaveCount(disambiguation!.pickList!.labels.length);
  await expect
    .poll(() =>
      pickRows.evaluateAll((rows) =>
        rows.map((row) => row.querySelector('span')?.textContent?.trim() ?? '')
      )
    )
    .toEqual(disambiguation!.pickList!.labels);
  await page.keyboard.press('Escape');

  // The reference opens with a real lower-rim fillet. Remove that downstream
  // history feature before the bore edit, then recreate a rim fillet below.
  expect((await readBlend(canvas, 2))?.blendRadius).toBeCloseTo(2, 6);
  await page.getByRole('button', { name: 'Delete Lower rim fillet' }).click();
  await expect(status).not.toContainText(REBUILDING, { timeout: 60_000 });
  await expect.poll(() => readBlend(canvas, 2), REPUBLISH).toBeNull();

  // 5. Dragging streams monotone diameter chips and exact preview topology.
  expect(await probeFace(canvas, 'bore')).not.toBeNull();
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  await expect(chip).toHaveText('Ø 20 mm');
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
  const handleStart = {
    x: bounds!.x + handle.x,
    y: bounds!.y + handle.y
  };
  await canvas.evaluate(
    (element, target) => {
      const dispatch = (
        type: 'pointerdown' | 'pointermove',
        clientX: number,
        clientY: number,
        shiftKey = false
      ) =>
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            pointerId: 41,
            isPrimary: true,
            button: 0,
            buttons: 1,
            clientX,
            clientY,
            shiftKey
          })
        );
      dispatch('pointerdown', target.x, target.y);
      dispatch(
        'pointermove',
        target.x - target.dx * target.pixelsPerUnit,
        target.y - target.dy * target.pixelsPerUnit,
        true
      );
    },
    { ...handle, ...handleStart }
  );
  // The bore, not the outer wall: an inward-facing cylindrical face is a hole,
  // and the command is named for it.
  await expect(
    page.getByRole('region', { name: 'Resize Hole operation' })
  ).toContainText('Dragging');
  // Keep the probe the poll accepted. Re-reading it is a second round trip
  // into a viewport that may already have moved on, and every round trip is
  // seconds of budget when the main thread is contended.
  let firstPreview: FaceProbe | null = null;
  await expect
    .poll(async () => {
      firstPreview = await probeFace(canvas, 'bore', 'inspect');
      return firstPreview?.geometry.diameter;
    }, REPUBLISH)
    .toBeLessThan(20);
  const firstPreviewDiameter = firstPreview!.geometry.diameter!;
  const firstDraggedValue = readChipValue(await chip.innerText());
  expect(firstDraggedValue).toBeLessThan(20);
  expect(firstPreviewDiameter).toBeCloseTo(firstDraggedValue, 3);
  await canvas.evaluate(
    (element, target) => {
      element.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerType: 'mouse',
          pointerId: 41,
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: target.x - target.dx * target.pixelsPerUnit * 1.3,
          clientY: target.y - target.dy * target.pixelsPerUnit * 1.3,
          shiftKey: true
        })
      );
    },
    { ...handle, ...handleStart }
  );
  let secondPreview: FaceProbe | null = null;
  await expect
    .poll(async () => {
      secondPreview = await probeFace(canvas, 'bore', 'inspect');
      return secondPreview?.geometry.diameter;
    }, REPUBLISH)
    .toBeLessThan(firstPreviewDiameter);
  const secondPreviewDiameter = secondPreview!.geometry.diameter!;
  const secondDraggedValue = readChipValue(await chip.innerText());
  expect(secondDraggedValue).toBeLessThan(firstDraggedValue);
  expect(secondPreviewDiameter).toBeCloseTo(secondDraggedValue, 3);
  await page.keyboard.press('Escape');
  await canvas.evaluate((element, target) => {
    element.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        pointerId: 41,
        isPrimary: true,
        button: 0,
        buttons: 0,
        clientX: target.x,
        clientY: target.y
      })
    );
  }, handleStart);
  await expect
    .poll(
      async () =>
        (await probeFace(canvas, 'bore', 'inspect'))?.geometry.diameter,
      REPUBLISH
    )
    .toBeCloseTo(20, 5);

  // 6. Exact diameter entry commits the typed value into FaceGeometry.
  expect(await probeFace(canvas, 'bore')).not.toBeNull();
  await expect(chip).toHaveText('Ø 20 mm');
  await chip.click();
  const diameterKeypad = page.getByRole('dialog', { name: 'Diameter value' });
  await diameterKeypad.getByRole('textbox').fill('Ø17.4');
  await diameterKeypad.getByRole('button', { name: 'Apply diameter' }).click();
  await expect(diameterKeypad).toBeHidden();
  await expect(status).not.toContainText(REBUILDING, { timeout: 60_000 });
  await expect
    .poll(
      async () =>
        (await probeFace(canvas, 'bore', 'inspect'))?.geometry.diameter,
      REPUBLISH
    )
    .toBeCloseTo(17.4, 6);

  // 7. The outer rim is one selected, closed, full analytic circle.
  const outerEdge = await selectOuterCircle(canvas);
  expect(outerEdge?.curveType).toBe('CIRCLE');
  expect(outerEdge?.circleRadius).toBeCloseTo(15, 6);
  expect(outerEdge?.closed).toBe(true);
  expect(outerEdge?.closureGap).toBeLessThanOrEqual(1e-6);
  expect(outerEdge?.pointCount).toBeGreaterThan(8);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-edges',
    outerEdge!.topologyId
  );
  await expect(
    page.getByRole('region', { name: 'Fillet operation' })
  ).toBeVisible();

  // 8. Fillet creation publishes a new exact blend and cyan preview film.
  await expect(chip).toHaveText('R 0 mm');
  await chip.click();
  const filletKeypad = page.getByRole('dialog', { name: 'Radius value' });
  await filletKeypad.getByRole('textbox').fill('1.5');
  await expect
    .poll(
      () =>
        canvas.evaluate((element) =>
          Number(element.dataset.e2ePreviewBlendCount ?? 0)
        ),
      REPUBLISH
    )
    .toBeGreaterThan(0);
  let polledRimBlend: BlendProbe | null = null;
  await expect
    .poll(async () => {
      polledRimBlend = await readBlend(canvas, 1.5);
      return polledRimBlend;
    }, REPUBLISH)
    .not.toBeNull();
  const previewRimBlend = polledRimBlend!;
  expect(previewRimBlend?.x).toBeDefined();
  expect(previewRimBlend?.y).toBeDefined();
  await settleRender(canvas);
  const previewBlendPixels = await sampleAround(page, canvas, {
    x: previewRimBlend.x!,
    y: previewRimBlend.y!
  });
  await testInfo.attach('angle-a-rim-fillet-preview', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  await filletKeypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).not.toContainText(REBUILDING, { timeout: 60_000 });
  await expect
    .poll(async () => (await readBlend(canvas, 1.5))?.blendRadius, REPUBLISH)
    .toBeCloseTo(1.5, 6);
  expect(strongestCyanPixel(previewBlendPixels)).toBeGreaterThan(40);

  // 9. Selecting the committed blend resolves the whole face and edit radius.
  const rimBlend = await readBlend(canvas, 1.5, true);
  expect(rimBlend?.blendRadius).toBeCloseTo(1.5, 6);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-face',
    rimBlend!.topologyId
  );
  const selectionReadout = page.locator('.selection-chip');
  await expect(selectionReadout).toContainText('Blend face R1.5');

  // 10. A second oblique angle keeps the rim selection and chip world anchor.
  const trackingEdge = await selectOuterCircle(canvas);
  expect(trackingEdge).not.toBeNull();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-edges',
    trackingEdge!.topologyId
  );
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('R 0 mm');
  let polledAnchor: ChipAnchor | null = null;
  await expect
    .poll(async () => {
      polledAnchor = await readChipAnchor(canvas);
      return polledAnchor;
    }, REPUBLISH)
    .not.toBeNull();
  const initialAnchor: ChipAnchor | null = polledAnchor;
  expect(initialAnchor).not.toBeNull();
  const beforeOrbit = await expectAnchorMatchesProjection(
    canvas,
    chip,
    initialAnchor!.world
  );
  const orbitBounds = await canvas.boundingBox();
  expect(orbitBounds).not.toBeNull();
  const orbitStart = {
    x: orbitBounds!.x + orbitBounds!.width * 0.28,
    y: orbitBounds!.y + orbitBounds!.height * 0.24
  };
  const cameraBefore = (await readInputState(canvas)).camera.position;
  const pointer = {
    pointerId: 77,
    button: 0,
    buttons: 1,
    clientX: orbitStart.x,
    clientY: orbitStart.y,
    shiftKey: true
  };
  await controlPointer(canvas, 'pointerdown', pointer);
  await controlPointer(canvas, 'pointermove', {
    ...pointer,
    clientX: orbitStart.x + orbitBounds!.width * 0.14,
    clientY: orbitStart.y - orbitBounds!.height * 0.08
  });
  await controlPointer(canvas, 'pointerup', {
    ...pointer,
    buttons: 0,
    clientX: orbitStart.x + orbitBounds!.width * 0.14,
    clientY: orbitStart.y - orbitBounds!.height * 0.08
  });
  await waitForCameraToSettle(canvas);
  const cameraAfter = (await readInputState(canvas)).camera.position;
  expect(
    Math.hypot(
      cameraAfter[0] - cameraBefore[0],
      cameraAfter[1] - cameraBefore[1],
      cameraAfter[2] - cameraBefore[2]
    )
  ).toBeGreaterThan(1);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-edges',
    trackingEdge!.topologyId
  );
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('R 0 mm');
  const afterOrbit = await expectAnchorMatchesProjection(
    canvas,
    chip,
    initialAnchor!.world
  );
  expect(
    Math.hypot(
      afterOrbit.screen.x - beforeOrbit.screen.x,
      afterOrbit.screen.y - beforeOrbit.screen.y
    )
  ).toBeGreaterThan(5);
  await testInfo.attach('angle-b-selected-rim-edge', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });

  expect(consoleErrors).toEqual([]);
});
