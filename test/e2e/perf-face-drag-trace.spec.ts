import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  expectBodyCount,
  stubApi,
  blendEdgesInPlace
} from './openzcad-fixtures';
import { createNativeHolderStages } from '../fixtures/hammer-holder/native-document';
import type { FaceDragTraceEvent } from '../../apps/web/src/lib/faceDragTrace';
import {
  summarizeFaceDragTrace,
  type FaceDragTraceSummary
} from '../support/faceDragTraceSummary';

/**
 * Face-offset drag latency probe: pointer input to the WebGL frame that shows
 * the exact preview geometry, measured stage by stage. Measurement, not a CI
 * gate. Run deliberately:
 *
 *   OZ_PERF=1 pnpm exec playwright test perf-face-drag-trace --workers=1
 *
 * Each case streams real-time pointer moves (one per 16 ms) along the offset
 * handle, out and back, then releases. Every case appends one JSON line to
 * OZ_PERF_OUT (default perf-results/perf-face-drag-trace.jsonl) holding the
 * summary from `test/support/faceDragTraceSummary.ts` and the raw trace.
 *
 * The imported hammer-holder case needs a STEP file outside this repository,
 * such as Remus `crates/io/tests/data/shapr3d_hammer_holder.step`:
 *
 *   OZ_FACE_DRAG_STEP=/path/to/shapr3d_hammer_holder.step
 *   OZ_FACE_DRAG_FILLET_STEP=/path/to/openzcad_e_analytic_fillet_plate.step
 */
test.skip(!process.env.OZ_PERF, 'Performance probe; set OZ_PERF=1 to run it.');
// On hybrid-graphics laptops Chromium renders on the integrated GPU by
// default. OZ_FACE_DRAG_HIGH_PERF_GPU=1 asks for the discrete one instead;
// each JSON line records the WebGL renderer either way.
// OZ_FACE_DRAG_VIDEO=1 records each case as a video in its test-results.
if (process.env.OZ_FACE_DRAG_VIDEO === '1')
  test.use({ video: { mode: 'on', size: { width: 1440, height: 1000 } } });
if (process.env.OZ_FACE_DRAG_HIGH_PERF_GPU === '1')
  test.use({ launchOptions: { args: ['--force_high_performance_gpu'] } });

const OUT =
  process.env.OZ_PERF_OUT ?? 'perf-results/perf-face-drag-trace.jsonl';
const MOVE_INTERVAL_MS = 16;
const MOVES = Number(process.env.OZ_FACE_DRAG_MOVES ?? 120);
/** `x,y,z` overrides the dragged face normal of every case. */
const NORMAL_OVERRIDE = process.env.OZ_FACE_DRAG_NORMAL?.split(',').map(Number);
const REACH_SCALE = Number(process.env.OZ_FACE_DRAG_REACH_SCALE ?? 1);

interface Handle {
  x: number;
  y: number;
  dx: number;
  dy: number;
  pixelsPerUnit: number;
}

async function openDocument(page: Page, document: ProjectDocument) {
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'face-drag.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: []
      })
    )
  });
  await expectBodyCount(page, 1);
}

async function startPage(page: Page, create = true) {
  await stubApi(page);
  await page.addInitScript(() => {
    const scope = window as typeof window & {
      __ozFaceDragTrace?: unknown[];
      __ozLongTasks?: { t: number; ms: number }[];
    };
    // Tracing starts when the probe swaps in an array; null keeps it off
    // while the model loads.
    scope.__ozLongTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          scope.__ozLongTasks!.push({
            t: entry.startTime,
            ms: entry.duration
          });
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      // Long-task timing is Chromium-only.
    }
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  if (!create) return;
  await page.getByLabel('Project name').fill('Face drag trace');
  await page.getByRole('button', { name: 'Create project' }).click();
}

async function armPlanarFace(
  page: Page,
  normal: { x: number; y: number; z: number }
): Promise<{ canvas: Locator; handle: Handle }> {
  if (NORMAL_OVERRIDE?.length === 3)
    normal = {
      x: NORMAL_OVERRIDE[0]!,
      y: NORMAL_OVERRIDE[1]!,
      z: NORMAL_OVERRIDE[2]!
    };
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(
      async () => {
        await canvas.evaluate((element, normal) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-planar-face', {
              detail: { normal }
            })
          );
        }, normal);
        return canvas.getAttribute('data-e2e-handle-x');
      },
      { timeout: 120_000 }
    )
    .not.toBeNull();
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
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  expect(Object.values(handle).every(Number.isFinite)).toBe(true);
  return { canvas, handle };
}

/**
 * Streams `MOVES` pointer moves in real time: out to `reach` and back to a
 * third of it, so the drag reverses as a hand does. Returns the trace.
 */
async function traceDrag(
  page: Page,
  canvas: Locator,
  handle: Handle,
  reach: number
) {
  reach *= REACH_SCALE;
  const box = (await canvas.boundingBox())!;
  const start = { x: box.x + handle.x, y: box.y + handle.y };
  await canvas.evaluate((element) =>
    element.addEventListener(
      'pointerdown',
      (event) => {
        element.dataset.traceDragPointerId = String(
          (event as PointerEvent).pointerId
        );
      },
      { once: true }
    )
  );
  await page.mouse.move(start.x, start.y);
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __ozFaceDragTrace?: unknown[];
      __ozReactCommits?: number;
    };
    scope.__ozFaceDragTrace = [];
    scope.__ozReactCommits = 0;
  });
  // OZ_FACE_DRAG_PROFILE=<dir> saves a main-thread CPU profile per case.
  const profiler = process.env.OZ_FACE_DRAG_PROFILE
    ? await page.context().newCDPSession(page)
    : undefined;
  // OZ_FACE_DRAG_TIMELINE=<dir> saves a Chrome timeline trace per case.
  const timeline = process.env.OZ_FACE_DRAG_TIMELINE
    ? await page.context().newCDPSession(page)
    : undefined;
  const timelineEvents: unknown[] = [];
  if (timeline) {
    timeline.on('Tracing.dataCollected', ({ value }) =>
      timelineEvents.push(...value)
    );
    await timeline.send('Tracing.start', {
      categories:
        'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing',
      transferMode: 'ReportEvents'
    });
  }
  if (profiler) {
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.setSamplingInterval', { interval: 200 });
    await profiler.send('Profiler.start');
  }
  await page.mouse.down();
  await canvas.evaluate(
    async (element, { start, handle, reach, moves, interval }) => {
      const pointerId = Number(element.dataset.traceDragPointerId);
      const turn = Math.round(moves * 0.6);
      for (let index = 1; index <= moves; index += 1) {
        const distance =
          index <= turn
            ? (reach * index) / turn
            : reach - ((reach * 2) / 3) * ((index - turn) / (moves - turn));
        element.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            isPrimary: true,
            pointerId,
            buttons: 1,
            shiftKey: true,
            clientX: start.x + handle.dx * handle.pixelsPerUnit * distance,
            clientY: start.y + handle.dy * handle.pixelsPerUnit * distance
          })
        );
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    },
    { start, handle, reach, moves: MOVES, interval: MOVE_INTERVAL_MS }
  );
  // Let the last requested value reach the screen before releasing.
  await page.waitForFunction(
    () => {
      const trace = (
        window as typeof window & { __ozFaceDragTrace: FaceDragTraceEvent[] }
      ).__ozFaceDragTrace;
      const last = [...trace].reverse().find((e) => e.kind === 'pointer');
      const published = trace.filter(
        (e) => e.kind === 'publish' || e.kind === 'refusal'
      );
      const lastSettled = published.at(-1);
      // A recognized profile drags a client-side proxy and requests no exact
      // preview until release.
      if (
        last !== undefined &&
        !trace.some((e) => e.kind === 'request') &&
        performance.now() - last.t > 500
      )
        return true;
      return (
        last !== undefined &&
        lastSettled !== undefined &&
        lastSettled.value === last.value &&
        trace.some((e) => e.kind === 'frame' && e.t > lastSettled.t)
      );
    },
    undefined,
    { timeout: 120_000 }
  );
  const fileName = test.info().title.replace(/\W+/g, '-');
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop');
    mkdirSync(process.env.OZ_FACE_DRAG_PROFILE!, { recursive: true });
    writeFileSync(
      `${process.env.OZ_FACE_DRAG_PROFILE}/${fileName}.cpuprofile`,
      JSON.stringify(profile)
    );
  }
  if (timeline) {
    const done = new Promise((resolve) =>
      timeline.once('Tracing.tracingComplete', resolve)
    );
    await timeline.send('Tracing.end');
    await done;
    mkdirSync(process.env.OZ_FACE_DRAG_TIMELINE!, { recursive: true });
    writeFileSync(
      `${process.env.OZ_FACE_DRAG_TIMELINE}/${fileName}.json`,
      JSON.stringify({ traceEvents: timelineEvents })
    );
  }
  const releaseAt = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await expect(
    page.getByText('Checking geometry…', { exact: true })
  ).toHaveCount(0, { timeout: 120_000 });
  return page.evaluate((releaseAt) => {
    const scope = window as typeof window & {
      __ozFaceDragTrace: FaceDragTraceEvent[];
      __ozLongTasks: { t: number; ms: number }[];
      __ozReactCommits?: number;
    };
    const trace = scope.__ozFaceDragTrace;
    scope.__ozFaceDragTrace = undefined as never;
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      gpu: info ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null,
      devicePixelRatio: window.devicePixelRatio,
      trace,
      releaseAt,
      releasedAt: performance.now(),
      reactCommits: scope.__ozReactCommits ?? null,
      longTasks: scope.__ozLongTasks.filter(
        (task) => task.t >= (trace[0]?.t ?? 0)
      )
    };
  }, releaseAt);
}

function record(
  label: string,
  model: Record<string, unknown>,
  result: Awaited<ReturnType<typeof traceDrag>>
): FaceDragTraceSummary {
  const summary = summarizeFaceDragTrace(result.trace, {
    releaseAt: result.releaseAt
  });
  const line = {
    label,
    model,
    at: new Date().toISOString(),
    userAgent: process.env.OZ_PERF_HOST ?? null,
    summary,
    reactCommits: result.reactCommits,
    gpu: result.gpu,
    devicePixelRatio: result.devicePixelRatio,
    longTasks: {
      count: result.longTasks.length,
      totalMs: result.longTasks.reduce((sum, task) => sum + task.ms, 0),
      maxMs: Math.max(0, ...result.longTasks.map((task) => task.ms))
    },
    trace: result.trace
  };
  mkdirSync(dirname(OUT), { recursive: true });
  appendFileSync(OUT, `${JSON.stringify(line)}\n`);
  console.log(`[face-drag-trace] ${label} ${JSON.stringify(summary, null, 1)}`);
  return summary;
}

test.setTimeout(Number(process.env.OZ_FACE_DRAG_TIMEOUT_MS ?? 600_000));

test('traces a chamfered cylinder top-cap drag', async ({ page }) => {
  await startPage(page);
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await blendEdgesInPlace(page, {
    tool: 'Chamfer',
    allEdges: 2,
    size: '1'
  });
  await expectBodyCount(page, 1);
  const { canvas, handle } = await armPlanarFace(page, { x: 0, y: 0, z: 1 });
  const summary = record(
    'chamfered cylinder top cap',
    { features: 2, faces: 5 },
    await traceDrag(page, canvas, handle, 12)
  );
  expect(summary.presentedFrames).toBeGreaterThan(0);
});

test('traces a rounded box top-face drag', async ({ page }) => {
  await startPage(page);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Width (X)').fill('40');
  await inspector.getByLabel('Depth (Y)').fill('24');
  await inspector.getByLabel('Height (Z)').fill('10');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await blendEdgesInPlace(page, {
    tool: 'Fillet',
    allEdges: 12,
    size: '1.5'
  });
  await expectBodyCount(page, 1);
  const { canvas, handle } = await armPlanarFace(page, { x: 0, y: 0, z: 1 });
  // A box cap keeps its primitive-height proxy, so this case measures the
  // proxy frame rate rather than exact previews.
  const summary = record(
    'rounded box top face (primitive proxy)',
    { features: 2, faces: 26 },
    await traceDrag(page, canvas, handle, 12)
  );
  expect(summary.pointerEvents).toBeGreaterThan(0);
});

test('traces a native hammer-holder arm drag', async ({ page }) => {
  await startPage(page, false);
  const { secondArm } = createNativeHolderStages();
  await openDocument(page, secondArm.document);
  // +Z picks the first upward planar face. The arms' ±X faces currently
  // refuse every offset in the kernel, so they cannot show a live preview.
  const { canvas, handle } = await armPlanarFace(page, { x: 0, y: 0, z: 1 });
  const summary = record(
    'native holder +Z face (plate, cut, two arms)',
    { features: secondArm.document.featureOrder.length },
    await traceDrag(page, canvas, handle, 6)
  );
  expect(summary.presentedFrames).toBeGreaterThan(0);
});

test('traces an imported filleted plate face drag', async ({ page }) => {
  const stepPath = process.env.OZ_FACE_DRAG_FILLET_STEP;
  test.skip(!stepPath, 'Set OZ_FACE_DRAG_FILLET_STEP to a filleted STEP.');
  await startPage(page, false);
  const document = importStepBody(
    createProjectDocument('Imported fillet drag', toUserId('user_test')),
    {
      name: 'plate',
      sourceName: 'plate.step',
      artifactId: 'artifact_plate',
      stepText: readFileSync(stepPath!, 'utf8')
    }
  ).document;
  await openDocument(page, document);
  const { canvas, handle } = await armPlanarFace(page, { x: 0, y: 0, z: 1 });
  const summary = record(
    'imported filleted plate +Z face',
    { features: document.featureOrder.length },
    await traceDrag(page, canvas, handle, 3)
  );
  expect(summary.presentedFrames).toBeGreaterThan(0);
});

test('traces an imported hammer-holder face drag', async ({ page }) => {
  const stepPath = process.env.OZ_FACE_DRAG_STEP;
  test.skip(!stepPath, 'Set OZ_FACE_DRAG_STEP to an imported holder STEP.');
  await startPage(page, false);
  const document = importStepBody(
    createProjectDocument('Imported holder drag', toUserId('user_test')),
    {
      name: 'holder',
      sourceName: 'holder.step',
      artifactId: 'artifact_holder',
      stepText: readFileSync(stepPath!, 'utf8')
    }
  ).document;
  await openDocument(page, document);
  const { canvas, handle } = await armPlanarFace(page, { x: 1, y: 0, z: 0 });
  const summary = record(
    'imported hammer holder +X face (160 faces, 42 NURBS)',
    { features: document.featureOrder.length, faces: 160 },
    await traceDrag(page, canvas, handle, -4)
  );
  expect(summary.presentedFrames).toBeGreaterThan(0);
});
