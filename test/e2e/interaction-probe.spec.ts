import { expect, test, type Page } from '@playwright/test';

// Measurement, not a pass/fail timing gate: GPU state and hardware dominate
// the absolute values. Run deliberately:
//   OZ_PERF=1 pnpm exec playwright test interaction-probe
test.skip(
  !process.env.OZ_PERF,
  'Interaction performance probe; set OZ_PERF=1 to run it.'
);

test.setTimeout(180_000);

async function stubApi(page: Page) {
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
