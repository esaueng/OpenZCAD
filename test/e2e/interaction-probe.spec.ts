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
  await dragPath(
    page,
    'left',
    center,
    { x: bounds.width * 0.16, y: bounds.height * 0.12 },
    0
  );
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
