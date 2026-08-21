import { expect, test, type Page } from '@playwright/test';
import { seedDismissedWorkspaceTour } from './openzcad-fixtures';

// Measurement, not a pass/fail timing gate: GPU state and hardware dominate
// the absolute values. Run deliberately:
//   OZ_PERF=1 pnpm exec playwright test interaction-probe
test.skip(
  !process.env.OZ_PERF,
  'Interaction performance probe; set OZ_PERF=1 to run it.'
);

test.setTimeout(180_000);

async function stubApi(page: Page) {
  await seedDismissedWorkspaceTour(page);
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        environment: 'beta',
        time: new Date().toISOString()
      }
    })
  );
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: { projects: [] } })
  );
}

async function dragPath(
  page: Page,
  button: 'left' | 'right',
  center: { x: number; y: number },
  radius: { x: number; y: number },
  phase: number
) {
  const steps = 40;
  const point = (index: number) => {
    const angle = phase + (index / steps) * Math.PI * 2;
    return {
      x: center.x + Math.cos(angle) * radius.x,
      y: center.y + Math.sin(angle * 1.5) * radius.y
    };
  };

  const start = point(0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button });
  for (let index = 1; index <= steps; index += 1) {
    const next = point(index);
    await page.mouse.move(next.x, next.y);
    await page.waitForTimeout(18);
  }
  await page.mouse.up({ button });
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  );
  return sorted[index] ?? 0;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Frame marks emitted since `startedAt`, already filtered to complete ones. */
async function frameSamples(page: Page, startedAt: number) {
  return page.evaluate(
    ({ startedAt }) =>
      performance
        .getEntriesByName('oz:viewer.frame', 'mark')
        .filter((entry) => entry.startTime >= startedAt)
        .map(
          (entry) =>
            (entry as PerformanceMark).detail as {
              frameMs: number | null;
              drawCalls: number;
              triangles: number;
            }
        )
        .filter(
          (
            frame
          ): frame is {
            frameMs: number;
            drawCalls: number;
            triangles: number;
          } => Number.isFinite(frame.frameMs) && frame.frameMs !== null
        )
        .slice(1),
    { startedAt }
  );
}

/**
 * React commits since the counter was last zeroed. The viewport owns per-frame
 * values imperatively, so a refined gesture commits on its lifecycle edges and
 * nowhere in between — this is the acceptance signal for that property, not a
 * performance figure in itself.
 */
async function reactCommits(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as typeof window & { __ozReactCommits?: number })
        .__ozReactCommits ?? 0
  );
}

async function beginWindow(page: Page): Promise<number> {
  return page.evaluate(() => {
    performance.clearMarks('oz:viewer.frame');
    const scope = window as typeof window & {
      __ozReactCommits?: number;
      __ozDragApplies?: number;
    };
    scope.__ozReactCommits = 0;
    scope.__ozDragApplies = 0;
    return performance.now();
  });
}

/**
 * How many times the viewport ran its pointer-move work. A coalesced drag
 * runs it once per painted frame rather than once per raw pointer event.
 */
async function dragApplies(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as typeof window & { __ozDragApplies?: number })
        .__ozDragApplies ?? 0
  );
}

function reportFrames(
  label: string,
  extra: Record<string, unknown>,
  frames: { frameMs: number; drawCalls: number; triangles: number }[]
) {
  const round = (value: number) => Math.round(value * 100) / 100;
  const frameTimes = frames.map((frame) => frame.frameMs);
  console.log(
    `${label} ` +
      JSON.stringify(
        {
          ...extra,
          frames: frames.length,
          frameTimeMs: {
            p50: round(percentile(frameTimes, 0.5)),
            p95: round(percentile(frameTimes, 0.95)),
            max: round(Math.max(...frameTimes))
          },
          render: {
            meanDrawCalls: round(mean(frames.map((frame) => frame.drawCalls))),
            meanTriangles: round(mean(frames.map((frame) => frame.triangles)))
          }
        },
        null,
        2
      )
  );
}

async function openHeatSink(page: Page) {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Heat Sink/ }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled({
    timeout: 120_000
  });
  await page.waitForTimeout(500);
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('Viewer canvas is not laid out.');
  }
  return { canvas, bounds };
}

test('interaction probe', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Heat Sink/ }).click();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled({
    timeout: 120_000
  });
  await page.waitForTimeout(500);

  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('Viewer canvas is not laid out.');
  }
  const center = {
    x: bounds.x + bounds.width * 0.52,
    y: bounds.y + bounds.height * 0.5
  };

  const startedAt = await page.evaluate(() => {
    performance.clearMarks('oz:viewer.frame');
    return performance.now();
  });
  await page.keyboard.down('Shift');
  await dragPath(
    page,
    'left',
    center,
    { x: bounds.width * 0.16, y: bounds.height * 0.12 },
    0
  );
  await page.keyboard.up('Shift');
  await page.waitForTimeout(120);
  await dragPath(
    page,
    'right',
    center,
    { x: bounds.width * 0.12, y: bounds.height * 0.09 },
    Math.PI / 3
  );
  await page.waitForTimeout(300);

  const samples = await page.evaluate(
    ({ startedAt }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '.viewer-host canvas'
      );
      const gl = canvas?.getContext('webgl2');
      const rendererInfo = gl
        ? gl.getExtension('WEBGL_debug_renderer_info')
        : null;
      const renderer = gl
        ? String(
            gl.getParameter(
              rendererInfo?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER
            )
          )
        : 'unavailable';
      const frames = performance
        .getEntriesByName('oz:viewer.frame', 'mark')
        .filter((entry) => entry.startTime >= startedAt)
        .map((entry) => {
          const detail = (entry as PerformanceMark).detail as {
            frameMs: number | null;
            drawCalls: number;
            triangles: number;
          };
          return detail;
        })
        .filter(
          (
            frame
          ): frame is {
            frameMs: number;
            drawCalls: number;
            triangles: number;
          } =>
            Number.isFinite(frame.frameMs) &&
            frame.frameMs !== null &&
            Number.isFinite(frame.drawCalls) &&
            Number.isFinite(frame.triangles)
        )
        .slice(1);
      return {
        elapsedMs: performance.now() - startedAt,
        renderer,
        frames
      };
    },
    { startedAt }
  );

  expect(samples.frames.length).toBeGreaterThan(30);
  const frameTimes = samples.frames.map((frame) => frame.frameMs);
  const drawCalls = samples.frames.map((frame) => frame.drawCalls);
  const triangles = samples.frames.map((frame) => frame.triangles);
  const round = (value: number) => Math.round(value * 100) / 100;

  console.log(
    'INTERACTION_PERF ' +
      JSON.stringify(
        {
          demo: 'Heat Sink',
          elapsedMs: Math.round(samples.elapsedMs),
          renderer: samples.renderer,
          frames: samples.frames.length,
          frameTimeMs: {
            p50: round(percentile(frameTimes, 0.5)),
            p95: round(percentile(frameTimes, 0.95)),
            max: round(Math.max(...frameTimes))
          },
          render: {
            meanDrawCalls: round(mean(drawCalls)),
            meanTriangles: round(mean(triangles))
          }
        },
        null,
        2
      )
  );
});

test('cylinder radius proxy probe', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Cylinder Radius Proxy Probe');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('button', { name: 'Bodies 1' })).toBeVisible();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(
      async () =>
        canvas.evaluate((element) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: { surface: 'wall' }
            })
          );
          return element.dataset.e2eHandleX ?? null;
        }),
      { timeout: 120_000 }
    )
    .not.toBeNull();
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  expect(Object.values(handle).every(Number.isFinite)).toBe(true);
  const start = {
    x: bounds!.x + handle.x,
    y: bounds!.y + handle.y
  };

  await page.evaluate(() => {
    performance.clearMarks('oz:cylinder-radius.proxy-frame');
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let index = 1; index <= 80; index += 1) {
    const radialDelta = Math.sin((index / 80) * Math.PI * 4) * 5;
    await page.mouse.move(
      start.x + handle.dx * handle.pixelsPerUnit * radialDelta,
      start.y + handle.dy * handle.pixelsPerUnit * radialDelta
    );
    // Paces the drag so the proxy has frames to coalesce into. It also puts a
    // floor under `frameIntervalMs`, which is why that figure is not a
    // throughput signal — see the note where it is reported.
    await page.waitForTimeout(10);
  }

  const samples = await page.evaluate(() =>
    performance
      .getEntriesByName('oz:cylinder-radius.proxy-frame', 'mark')
      .map((entry) => ({
        at: entry.startTime,
        ...((entry as PerformanceMark).detail as {
          latencyMs: number;
          radius: number;
        })
      }))
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();

  expect(samples.length).toBeGreaterThan(20);
  expect(samples.every((sample) => Number.isFinite(sample.radius))).toBe(true);
  const latencies = samples.map((sample) => sample.latencyMs);
  const frameIntervals = samples
    .slice(1)
    .map((sample, index) => sample.at - samples[index]!.at);
  const round = (value: number) => Math.round(value * 100) / 100;
  console.log(
    'CYLINDER_RADIUS_PERF ' +
      JSON.stringify(
        {
          pointerMoves: 80,
          renderedProxyFrames: samples.length,
          inputToFrameMs: {
            p50: round(percentile(latencies, 0.5)),
            p95: round(percentile(latencies, 0.95)),
            max: round(Math.max(...latencies))
          },
          // Input-paced, not render throughput: the loop above sleeps
          // between synthetic moves, so this is bounded below by how fast the
          // harness delivers input. Dropping the sleep alone takes p95 from
          // ~183ms to ~58ms with nothing changed in the app. Read
          // `inputToFrameMs` for responsiveness; see the "what the drag probe
          // does not measure" section of docs/performance-baseline.md.
          frameIntervalMs: {
            p50: round(percentile(frameIntervals, 0.5)),
            p95: round(percentile(frameIntervals, 0.95)),
            max: round(Math.max(...frameIntervals))
          }
        },
        null,
        2
      )
  );
});

/**
 * Hover with no button held. This is the path the rAF coalescing was built
 * for, and the one a dense edge set punishes: every frame runs the picker
 * over the model and moves the highlight batches.
 */
test('hover sweep probe', async ({ page }) => {
  const { bounds } = await openHeatSink(page);

  const startedAt = await beginWindow(page);
  const steps = 120;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    await page.mouse.move(
      bounds.x + bounds.width * (0.25 + 0.5 * t),
      bounds.y + bounds.height * (0.5 + 0.22 * Math.sin(t * Math.PI * 6))
    );
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(200);

  const frames = await frameSamples(page, startedAt);
  const commits = await reactCommits(page);
  expect(frames.length).toBeGreaterThan(20);
  reportFrames(
    'HOVER_SWEEP_PERF',
    { demo: 'Heat Sink', pointerMoves: steps + 1, reactCommits: commits },
    frames
  );
});

/**
 * A move-gizmo drag. Unlike the camera gestures above, this one drives React
 * state today, so `reactCommits` is the number to watch here.
 */
test('move drag probe', async ({ page }) => {
  const { bounds } = await openHeatSink(page);

  await page.mouse.click(
    bounds.x + bounds.width * 0.52,
    bounds.y + bounds.height * 0.5
  );
  await page.waitForTimeout(300);
  const moveButton = page.getByRole('button', { name: /^Move/ });
  if (!(await moveButton.isEnabled().catch(() => false))) {
    test.skip(true, 'Move tool is unavailable for the demo selection.');
  }
  await moveButton.click();
  await page.waitForTimeout(400);

  const center = {
    x: bounds.x + bounds.width * 0.52,
    y: bounds.y + bounds.height * 0.5
  };
  const startedAt = await beginWindow(page);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  for (let index = 1; index <= 60; index += 1) {
    await page.mouse.move(
      center.x + index * 0.8,
      center.y + Math.sin(index / 8) * 6
    );
    await page.waitForTimeout(10);
  }
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const frames = await frameSamples(page, startedAt);
  const commits = await reactCommits(page);
  const applies = await dragApplies(page);
  reportFrames(
    'MOVE_DRAG_PERF',
    {
      demo: 'Heat Sink',
      pointerMoves: 60,
      reactCommits: commits,
      dragApplies: applies
    },
    frames
  );
  expect(frames.length).toBeGreaterThan(5);
});

/**
 * A push/pull drag on a planar face: the preview-publish path. Every published
 * preview currently swaps the whole body list, so this is where a scene
 * teardown shows up as both frame cost and React commits.
 *
 * The offset rig is reached by clicking the face and waiting for the handle to
 * publish its screen position, the same way the cylinder probe above does —
 * guessing at gizmo pixels is how these probes silently measure nothing.
 */
test('preview drag probe', async ({ page }) => {
  const { canvas, bounds } = await openHeatSink(page);

  await page.mouse.click(
    bounds.x + bounds.width * 0.52,
    bounds.y + bounds.height * 0.5
  );

  const handle = await (async () => {
    await expect
      .poll(
        async () =>
          canvas.evaluate((element) => element.dataset.e2eHandleX ?? null),
        {
          timeout: 30_000,
          message: 'clicking the demo should arm an offset handle'
        }
      )
      .not.toBeNull();
    return canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
  })();
  expect(Object.values(handle).every(Number.isFinite)).toBe(true);

  // The value chip is a DOM overlay anchored right on top of the handle, so a
  // synthetic press at the published handle point lands on the chip and never
  // reaches the canvas — the drag silently does nothing and the probe reports
  // an idle viewport. A person aims at the arrow shaft; walk along the drag
  // axis for the nearest point hit-testing to the canvas itself.
  const start = await (async () => {
    for (const step of [0, -12, -24, -36, 12, 24, 36, -48, 48]) {
      const candidate = {
        x: bounds.x + handle.x + handle.dx * step,
        y: bounds.y + handle.y + handle.dy * step
      };
      const onCanvas = await page.evaluate(
        (point) =>
          document.elementFromPoint(point.x, point.y)?.tagName === 'CANVAS',
        candidate
      );
      if (onCanvas) {
        return candidate;
      }
    }
    throw new Error(
      'No point along the offset handle hit-tests to the canvas.'
    );
  })();

  const startedAt = await beginWindow(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let index = 1; index <= 50; index += 1) {
    // Bounded in pixels rather than document units: the handle's
    // pixels-per-unit is whatever the current framing makes it, and scaling a
    // unit offset by it walks the pointer straight off the canvas, which ends
    // the drag and measures an idle viewport instead.
    const travel = Math.sin((index / 50) * Math.PI) * 60;
    await page.mouse.move(
      start.x + handle.dx * travel,
      start.y + handle.dy * travel
    );
    await page.waitForTimeout(14);
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(300);

  const frames = await frameSamples(page, startedAt);
  const commits = await reactCommits(page);
  const applies = await dragApplies(page);
  reportFrames(
    'PREVIEW_DRAG_PERF',
    {
      demo: 'Heat Sink',
      pointerMoves: 50,
      reactCommits: commits,
      dragApplies: applies
    },
    frames
  );
  expect(frames.length).toBeGreaterThan(5);
});

/**
 * A burst of pointer moves inside a single task, standing in for a high-rate
 * mouse. Driving this through the harness proves nothing: each CDP mouse move
 * round-trips and yields, so the browser paints between events and the drag
 * would run once per move no matter what the code does. Dispatched
 * synchronously, the whole burst lands before any frame can run, which is the
 * situation coalescing exists for — the drag's work includes a snap scan over
 * every edge and face centre of the other bodies.
 */
test('drag coalescing probe', async ({ page }) => {
  const { canvas, bounds } = await openHeatSink(page);

  await page.mouse.click(
    bounds.x + bounds.width * 0.52,
    bounds.y + bounds.height * 0.5
  );
  await page.waitForTimeout(300);
  const moveButton = page.getByRole('button', { name: /^Move/ });
  if (!(await moveButton.isEnabled().catch(() => false))) {
    test.skip(true, 'Move tool is unavailable for the demo selection.');
  }
  await moveButton.click();
  await page.waitForTimeout(400);

  // The synthetic moves have to carry the real gesture's pointer id, or the
  // drag branches ignore them.
  await canvas.evaluate((element) => {
    const scope = window as typeof window & { __ozProbePointerId?: number };
    element.addEventListener(
      'pointerdown',
      (event) => {
        scope.__ozProbePointerId = (event as PointerEvent).pointerId;
      },
      { once: true, capture: true }
    );
  });

  const center = {
    x: bounds.x + bounds.width * 0.52,
    y: bounds.y + bounds.height * 0.5
  };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.waitForTimeout(100);

  const startedAt = await beginWindow(page);
  const moves = 120;
  await canvas.evaluate(
    (element, { moves, center }) => {
      const scope = window as typeof window & { __ozProbePointerId?: number };
      const pointerId = scope.__ozProbePointerId ?? 1;
      for (let index = 1; index <= moves; index += 1) {
        element.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId,
            pointerType: 'mouse',
            buttons: 1,
            clientX: center.x + index * 0.5,
            clientY: center.y,
            bubbles: true,
            cancelable: true
          })
        );
      }
    },
    { moves, center }
  );

  // Let the frame that consumes the burst run before counting it.
  await page.waitForTimeout(80);
  const applies = await dragApplies(page);
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const frames = await frameSamples(page, startedAt);
  const commits = await reactCommits(page);
  console.log(
    'DRAG_COALESCING_PERF ' +
      JSON.stringify(
        {
          pointerMoves: moves,
          dragApplies: applies,
          reactCommits: commits,
          renderedFrames: frames.length
        },
        null,
        2
      )
  );
  // A whole burst inside one task collapses to the single frame that follows
  // it. Without coalescing this equals the pointer event count.
  expect(applies).toBeLessThanOrEqual(2);
});
