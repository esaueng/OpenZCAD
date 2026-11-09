import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { FRAME_TIMING_SCENES } from '../fixtures/frame-timing-scenes';
import type { LookdevScene } from '../fixtures/lookdev-scenes';
import {
  droppedFrames,
  stats,
  writeRunSummary
} from '../../scripts/frame-timing-report.mjs';
import {
  enableFullRender,
  expect,
  expectBodyCount,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/*
  Viewport frame timing on an iPad-class proxy (U10 follow-up). A
  measurement, never a pass/fail budget: it fails only when the page errors
  or the orbit never moved the camera.

  No iPad or iOS simulator is available to agents, so this is the closest
  stand-in desktop Chromium gives: an iPad Pro-sized touch viewport (1366 ×
  1024, device pixel ratio 2, coarse pointer — so the viewer applies its
  touch render budget), CDP CPU throttling of the page's main thread, and a
  one-finger orbit sent through Chromium's touch input domain. It does not
  model Safari's engine, an iPad GPU, thermal throttling or the 120 Hz
  ProMotion refresh. See docs/browser-test-suites.md for how to run it and
  how to read the same numbers off a real iPad.

    VITE_E2E=1 OZ_PERF=1 pnpm --filter @openzcad/web build
    pnpm --filter @openzcad/web preview --host 127.0.0.1 --port 24651
    OZ_PERF=1 OZ_PERF_LABEL=main PLAYWRIGHT_PORT=24651 \
      pnpm exec playwright test test/e2e/perf-frame-timing.spec.ts --workers=1

  Results land in `artifacts/perf/<label>` (git-ignored; OZ_PERF_DIR writes
  elsewhere): one JSON file per scene and rate, plus summary.{json,md}.
  `node scripts/frame-timing-report.mjs --compare before=<dirs> after=<dirs>`
  tabulates two builds over repeated runs.

  Knobs: OZ_PERF_THROTTLE (comma-separated CPU slow-down rates, default
  1,4,6), OZ_PERF_SECONDS (orbit length, default 6), OZ_PERF_SCENES (scene
  ids), OZ_PERF_PORTRAIT=1 (1024 × 1366), OZ_PERF_GPU_TIMER=0 (skip GPU timer
  queries), OZ_PERF_DISPLAY=Shaded (orbit in another display mode, named as
  the toolbar does; Shaded draws no edges or outlines), OZ_PERF_WARMUP=1 (a
  short orbit first, so a device already dropping frames navigates at the
  touch budget's lowered pixel ratio, as it would from its second gesture).
*/
test.skip(!process.env.OZ_PERF, 'Frame-timing probe; set OZ_PERF=1 to run it.');
// Tests share the machine's CPU and GPU: one at a time, in order, without
// letting one failure skip the rest.
test.describe.configure({ mode: 'default' });

const OUT_DIR = resolve(
  process.env.OZ_PERF_DIR ??
    join('artifacts', 'perf', process.env.OZ_PERF_LABEL ?? 'current')
);
const RATES = (process.env.OZ_PERF_THROTTLE ?? '1,4,6')
  .split(',')
  .map(Number)
  .filter((rate) => Number.isFinite(rate) && rate >= 1);
const ORBIT_SECONDS = Number(process.env.OZ_PERF_SECONDS ?? 6);
const SCENE_FILTER = process.env.OZ_PERF_SCENES?.split(',');
const VIEWPORT =
  process.env.OZ_PERF_PORTRAIT === '1'
    ? { width: 1024, height: 1366 }
    : { width: 1366, height: 1024 };
const GPU_TIMER = process.env.OZ_PERF_GPU_TIMER !== '0';
const DISPLAY = process.env.OZ_PERF_DISPLAY;
const WARMUP = process.env.OZ_PERF_WARMUP === '1';

test.use({
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  // Headless Chromium otherwise draws WebGL on the CPU (SwiftShader), which
  // says nothing about a GPU. These put it on the machine's GPU through
  // ANGLE's D3D11 backend (Windows; elsewhere ANGLE ignores the D3D choice)
  // and expose GPU timer queries. OZ_PERF_SOFTWARE_GL=1 keeps SwiftShader.
  launchOptions: {
    args:
      process.env.OZ_PERF_SOFTWARE_GL === '1'
        ? []
        : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu']
  }
});
test.setTimeout(300_000);

interface FrameMark {
  frameMs: number | null;
  continuous: boolean;
  cpuMs: number;
  renderMs: number;
  overlayMs: number;
  drawCalls: number;
  triangles: number;
}

interface ProbeWindow {
  __ozFrameProbe?: {
    /** requestAnimationFrame timestamps, recorded while `recording`. */
    raf: number[];
    /** Canvas backing-store widths seen while recording. */
    canvasWidths: number[];
    /** GPU milliseconds per animation frame (summed timer queries). */
    gpu: number[];
    recording: boolean;
    timerQuery: boolean;
    frame: number;
  };
}

/**
 * Installed before the app loads: a requestAnimationFrame recorder, and
 * (when the extension exists) GPU timer queries around each synchronous
 * burst of viewer draw calls. A query opens at the first draw or clear of a
 * task and closes in a microtask, so it spans the whole viewer render a
 * requestAnimationFrame callback issues, view cube included.
 */
function installProbe(gpuTimer: boolean) {
  const probe = {
    raf: [] as number[],
    canvasWidths: [] as number[],
    gpu: [] as number[],
    recording: false,
    timerQuery: false,
    frame: 0
  };
  (window as ProbeWindow).__ozFrameProbe = probe;
  interface ContextState {
    viewer: boolean;
    ext: {
      TIME_ELAPSED_EXT: number;
      GPU_DISJOINT_EXT: number;
    } | null;
    open: boolean;
    pending: { query: WebGLQuery; frame: number }[];
    byFrame: Map<number, number>;
  }
  const states = new WeakMap<WebGL2RenderingContext, ContextState>();
  let viewerGl: WebGL2RenderingContext | null = null;
  const stateOf = (gl: WebGL2RenderingContext) => {
    let state = states.get(gl);
    if (!state) {
      const canvas = gl.canvas;
      const viewer =
        canvas instanceof HTMLCanvasElement &&
        canvas.closest('.viewer-host') !== null;
      state = {
        viewer,
        ext:
          viewer && gpuTimer
            ? (gl.getExtension(
                'EXT_disjoint_timer_query_webgl2'
              ) as ContextState['ext'])
            : null,
        open: false,
        pending: [],
        byFrame: new Map()
      };
      // A canvas not yet attached to the viewer host is decided on a later
      // call instead of being written off.
      if (canvas instanceof HTMLCanvasElement && !canvas.isConnected)
        return state;
      states.set(gl, state);
      if (viewer) {
        viewerGl = gl;
        probe.timerQuery = state.ext !== null;
      }
    }
    return state;
  };
  const prototype = WebGL2RenderingContext.prototype;
  for (const name of [
    'clear',
    'drawArrays',
    'drawElements',
    'drawArraysInstanced',
    'drawElementsInstanced',
    'drawRangeElements'
  ] as const) {
    const original = prototype[name] as (...args: unknown[]) => unknown;
    Object.defineProperty(prototype, name, {
      configurable: true,
      writable: true,
      value: function (this: WebGL2RenderingContext, ...args: unknown[]) {
        const state = stateOf(this);
        if (state.ext && probe.recording && !state.open) {
          const query = this.createQuery();
          if (query) {
            this.beginQuery(state.ext.TIME_ELAPSED_EXT, query);
            state.open = true;
            const frame = probe.frame;
            queueMicrotask(() => {
              this.endQuery(state.ext!.TIME_ELAPSED_EXT);
              state.open = false;
              state.pending.push({ query, frame });
            });
          }
        }
        return Reflect.apply(original, this, args);
      }
    });
  }
  const poll = () => {
    const gl = viewerGl;
    const state = gl ? states.get(gl) : undefined;
    if (!gl || !state?.ext) return;
    if (gl.getParameter(state.ext.GPU_DISJOINT_EXT)) {
      // A disjoint event invalidates every query in flight.
      for (const { query } of state.pending) gl.deleteQuery(query);
      state.pending = [];
      return;
    }
    while (state.pending.length > 0) {
      const { query, frame } = state.pending[0]!;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      gl.deleteQuery(query);
      state.pending.shift();
      state.byFrame.set(frame, (state.byFrame.get(frame) ?? 0) + ns / 1e6);
    }
    // Frames whose every query has resolved move to the probe.
    const oldestPending = state.pending[0]?.frame ?? Infinity;
    for (const [frame, ms] of state.byFrame) {
      if (frame >= oldestPending) continue;
      probe.gpu.push(ms);
      state.byFrame.delete(frame);
    }
  };
  const tick = (at: number) => {
    probe.frame += 1;
    if (probe.recording) {
      probe.raf.push(at);
      const canvas = document.querySelector<HTMLCanvasElement>(
        '.viewer-host canvas'
      );
      if (canvas) probe.canvasWidths.push(canvas.width);
    }
    poll();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function backupOf(scene: LookdevScene) {
  const adapter = await createExactKernelAdapter();
  try {
    return Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: await scene.build(adapter),
        files: []
      })
    );
  } finally {
    adapter.dispose();
  }
}

type Point = [number, number];

async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  points: Point[]
) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], id) => ({ x, y, id }))
  });
}

/**
 * One finger, put down on empty stage (a one-finger drag there orbits), then
 * moved along a slow figure for `seconds`: the part tumbles through a wide
 * range of views, so curved faces turn through their outlines continuously.
 */
async function orbit(page: Page, cdp: CDPSession, seconds: number) {
  const start = await emptyStagePoint(page);
  await touch(cdp, 'touchStart', [start]);
  const began = Date.now();
  let moves = 0;
  while (Date.now() - began < seconds * 1000) {
    const t = (Date.now() - began) / 1000;
    await touch(cdp, 'touchMove', [
      [
        start[0] + 260 * Math.sin((2 * Math.PI * t) / 4),
        start[1] + 120 * Math.sin((2 * Math.PI * t) / 2.6)
      ]
    ]);
    moves += 1;
  }
  await touch(cdp, 'touchEnd', []);
  return moves;
}

/**
 * A point where the canvas itself is on top (no panel, toolbar or hint) and
 * the part is not: the stage's upper corners first, with the fitted part
 * centred between them.
 */
async function emptyStagePoint(page: Page): Promise<Point> {
  const canvas = page.locator('.viewer-host canvas').first();
  const box = (await canvas.boundingBox())!;
  const candidates: Point[] = [
    [0.72, 0.1],
    [0.3, 0.1],
    [0.72, 0.9],
    [0.5, 0.06],
    [0.85, 0.5]
  ].map(([x, y]) => [box.x + box.width * x!, box.y + box.height * y!]);
  const hits = await page.evaluate(
    (points) =>
      points.map(
        ([x, y]) =>
          document.elementFromPoint(x, y) ===
          document.querySelector('.viewer-host canvas')
      ),
    candidates
  );
  const index = hits.indexOf(true);
  if (index < 0) throw new Error('No open stage to start an orbit on.');
  return candidates[index]!;
}

/** Cycles the display mode (W) until the toolbar names `mode`. */
async function setDisplayMode(page: Page, mode: string) {
  const button = page.getByRole('button', { name: /^Display mode \(W\)/ });
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  for (let press = 0; press < 8; press += 1) {
    if ((await button.getAttribute('aria-label'))?.endsWith(`now: ${mode}`))
      return;
    const before = await button.getAttribute('aria-label');
    await page.keyboard.press('w');
    await expect(button).not.toHaveAttribute('aria-label', before ?? '');
  }
  throw new Error(`Display mode "${mode}" never came up.`);
}

const readCamera = (page: Page) =>
  page
    .locator('.viewer-host canvas')
    .first()
    .evaluate(
      (element) =>
        new Promise<number[]>((resolve) =>
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-input-state', {
              detail: {
                resolve: (state: { camera: { position: number[] } }) =>
                  resolve(state.camera.position)
              }
            })
          )
        )
    );

const scenes = FRAME_TIMING_SCENES.filter(
  (scene) => !SCENE_FILTER || SCENE_FILTER.includes(scene.id)
);

for (const scene of scenes) {
  for (const rate of RATES) {
    test(`frame timing: ${scene.title}, CPU ×${rate}`, async ({
      page,
      browserName
    }) => {
      test.skip(
        browserName !== 'chromium',
        'CPU throttling needs Chromium CDP.'
      );
      const backup = await backupOf(scene);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await enableFullRender(page);
      await stubApi(page, { panelLayout: null });
      await page.addInitScript(installProbe, GPU_TIMER);
      await page.goto('/');
      const cdp = await page.context().newCDPSession(page);
      const browser = (await cdp.send('Browser.getVersion')).product;
      // Throttle before the import, so the body install and the silhouette
      // build are timed at the same rate as the orbit.
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      const importStarted = await page.evaluate(() => {
        performance.clearMeasures('oz:viewer.bodies');
        performance.clearMarks('oz:viewer.silhouettes');
        return performance.now();
      });
      await page
        .getByRole('button', { name: 'Import project', exact: true })
        .click();
      await page.getByLabel('Import project backup').setInputFiles({
        name: `${scene.id}.openzcad`,
        mimeType: 'application/json',
        buffer: backup
      });
      await expect(
        page.getByRole('group', { name: 'Workspace status' })
      ).toBeVisible({ timeout: 120_000 });
      await expect(async () => expectBodyCount(page, 1)).toPass({
        timeout: 120_000
      });
      await waitForStillViewport(page);
      if (DISPLAY) {
        await setDisplayMode(page, DISPLAY);
        await waitForStillViewport(page);
      }
      const load = await page.evaluate((started) => {
        const bodies = performance
          .getEntriesByName('oz:viewer.bodies')
          .map((entry) => entry.duration);
        const frames = performance
          .getEntriesByName('oz:viewer.frame')
          .map((entry) => ({
            at: entry.startTime,
            triangles: ((entry as PerformanceMark).detail as FrameMark)
              .triangles
          }));
        const peak = Math.max(0, ...frames.map((frame) => frame.triangles));
        const firstFull = frames.find(
          (frame) => frame.at > started && frame.triangles >= peak * 0.9
        );
        return {
          bodiesMs: bodies.length ? Math.max(...bodies) : null,
          bodyInstalls: bodies.length,
          importToFirstFrameMs: firstFull ? firstFull.at - started : null,
          // Only a build that marks its outline-candidate build has these;
          // otherwise that cost is inside `bodiesMs`.
          silhouettes: performance
            .getEntriesByName('oz:viewer.silhouettes')
            .map(
              (entry) =>
                (entry as PerformanceMark).detail as {
                  ms: number;
                  triangles: number;
                  candidates: number;
                }
            )
        };
      }, importStarted);
      const environment = {
        browser,
        gpu: await page
          .locator('.viewer-host canvas')
          .first()
          .evaluate((element) => {
            const gl = (element as HTMLCanvasElement).getContext('webgl2')!;
            const info = gl.getExtension('WEBGL_debug_renderer_info');
            return String(
              gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
            );
          }),
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        timerQuery: await page.evaluate(
          () => (window as ProbeWindow).__ozFrameProbe?.timerQuery ?? false
        )
      };

      const idle = await page.evaluate(async () => {
        const probe = (window as ProbeWindow).__ozFrameProbe!;
        probe.raf = [];
        probe.recording = true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        probe.recording = false;
        return probe.raf.slice(1).map((at, i) => at - probe.raf[i]!);
      });

      if (WARMUP) {
        await orbit(page, cdp, 1.5);
        await waitForStillViewport(page);
      }
      const before = await readCamera(page);
      await page.evaluate(() => {
        const probe = (window as ProbeWindow).__ozFrameProbe!;
        performance.clearMarks('oz:viewer.frame');
        probe.raf = [];
        probe.canvasWidths = [];
        probe.gpu = [];
        probe.recording = true;
      });
      const moves = await orbit(page, cdp, ORBIT_SECONDS);
      const sample = await page.evaluate(async () => {
        const probe = (window as ProbeWindow).__ozFrameProbe!;
        probe.recording = false;
        // Let the last GPU queries resolve.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          raf: probe.raf,
          canvasWidths: probe.canvasWidths,
          gpu: probe.gpu,
          frames: performance
            .getEntriesByName('oz:viewer.frame')
            .map((entry) => (entry as PerformanceMark).detail as FrameMark)
        };
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const after = await readCamera(page);
      mkdirSync(OUT_DIR, { recursive: true });
      await page.screenshot({
        path: join(OUT_DIR, `${scene.id}--x${rate}.png`)
      });

      const intervals = sample.raf.slice(1).map((at, i) => at - sample.raf[i]!);
      const continuous = sample.frames.filter((frame) => frame.continuous);
      const result = {
        kind: 'frame-timing',
        scene: scene.id,
        title: scene.title,
        throttle: rate,
        display: DISPLAY ?? 'default',
        warmup: WARMUP,
        // An orbit the viewer never drew (the finger landed on the part or
        // a panel) measures nothing; summaries leave it out.
        valid: errors.length === 0 && sample.frames.length > 10,
        environment,
        load,
        idle: stats(idle),
        orbit: {
          seconds: ORBIT_SECONDS,
          touchMoves: moves,
          frame: stats(intervals),
          dropped: droppedFrames(intervals),
          viewerFrames: sample.frames.length,
          viewerFps: sample.frames.length / Math.max(ORBIT_SECONDS, 1e-3),
          viewerInterval: stats(
            continuous.flatMap((frame) =>
              frame.frameMs === null ? [] : [frame.frameMs]
            )
          ),
          viewerCpu: stats(sample.frames.map((frame) => frame.cpuMs)),
          viewerRender: stats(sample.frames.map((frame) => frame.renderMs)),
          gpu: sample.gpu.length ? stats(sample.gpu) : null,
          triangles: Math.max(0, ...sample.frames.map((f) => f.triangles)),
          drawCalls: Math.max(0, ...sample.frames.map((f) => f.drawCalls)),
          canvasWidth: {
            min: Math.min(...sample.canvasWidths),
            max: Math.max(...sample.canvasWidths)
          },
          samples: {
            intervals,
            gpu: sample.gpu,
            cpu: sample.frames.map((frame) => frame.cpuMs)
          }
        },
        errors
      };
      writeFileSync(
        join(OUT_DIR, `${scene.id}--x${rate}.json`),
        `${JSON.stringify(result, null, 2)}\n`
      );
      writeRunSummary(OUT_DIR);

      expect(errors).toEqual([]);
      expect(
        Math.hypot(...after.map((value, axis) => value - before[axis]!))
      ).toBeGreaterThan(0.1);
      expect(sample.frames.length).toBeGreaterThan(10);
    });
  }
}
