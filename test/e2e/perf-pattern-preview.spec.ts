import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type {
  GeometryWorkerRequest,
  GeometryWorkerResult
} from '../../apps/web/src/worker/geometryWorker';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { test, expect, stubApi, MODEL_ONLY } from './openzcad-fixtures';
import { largePatternBar } from '../support/large-pattern-bar';
import { hostSnapshot, perfBrowserArgs } from '../../scripts/perf-host.mjs';

/**
 * Large grid-pattern preview in the browser (ROADMAP Active 1; production QA
 * 2026-11-14 finding #16: a 10 × 10 grid on a ×50 bar took 72.6 s to
 * preview). Measurement, not a CI check: run it through
 * `scripts/measure-active1-baselines.mjs`, or directly on a quiet machine:
 *
 *   OZ_PERF=1 OZ_PERF_ANGLE=vulkan pnpm exec playwright test \
 *     perf-pattern-preview --workers=1
 *
 * It opens the ×50 bar (`test/support/large-pattern-bar.ts`), starts Grid
 * pattern (which previews a 3 × 3 grid on the only body), then edits the
 * counts to 10 × 3 and 10 × 10 as a user would. Each step is timed from the
 * input to the card's Done turning enabled again, which happens when the
 * frame for that request has been built and accepted. Appends one JSON line
 * to OZ_PERF_OUT (default perf-results/perf-pattern-preview-v2.jsonl).
 */
const linearCopies = process.env.OZ_PERF_LINEAR_COPIES;
if (
  linearCopies !== undefined &&
  linearCopies !== '13' &&
  linearCopies !== '25'
)
  throw new Error('OZ_PERF_LINEAR_COPIES must be 13 or 25.');

test.skip(!process.env.OZ_PERF, 'Performance probe; set OZ_PERF=1 to run it.');
test.use({
  launchOptions: { args: perfBrowserArgs() },
  // A click on a missing control fails fast instead of at the test timeout.
  actionTimeout: 30_000
});

interface StageLog {
  t: number;
  requestId?: string;
  stage: string;
  name: string;
  durationMs: number;
}

/** Serves `document` as the project the start screen's Create returns. */
async function openDocument(page: Page, document: ProjectDocument) {
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            project: {
              projectId: document.projectId,
              name: document.name,
              revisionCount: 1,
              updatedAt: new Date().toISOString()
            },
            document
          }
        })
      : route.fulfill({ json: { projects: [] } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
}

/** Capture the DOM event that starts this build and the first accepted frame.
 * The count keypad previews on input. Enter can arrive after the worker starts.
 */
async function armPreviewClock(control: Locator, event: 'click' | 'input') {
  await control.evaluate((element, eventName) => {
    performance.clearMarks('pattern-input');
    performance.clearMarks('pattern-enabled');
    performance.clearMarks('pattern-started');
    performance.clearMarks('pattern-stage');
    element.addEventListener(
      eventName,
      () => {
        performance.mark('pattern-input');
        const doneButton = () => {
          const card = document.querySelector(
            '[role="group"][aria-label="Grid pattern command"], [role="group"][aria-label="Linear pattern command"]'
          );
          return [...(card?.querySelectorAll('button') ?? [])].find((button) =>
            /Done/.test(button.textContent ?? '')
          );
        };
        // An old count can still be enabled during the input event. Its
        // replacement first becomes pending, then becomes available to commit.
        let pending = doneButton()?.disabled ?? true;
        const observer = new MutationObserver(() => {
          const done = doneButton();
          if (!done || done.disabled) pending = true;
          else if (pending) {
            performance.mark('pattern-enabled');
            observer.disconnect();
          }
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['disabled']
        });
      },
      { capture: true, once: true }
    );
  }, event);
}

async function previewTiming(page: Page, timeout: number) {
  await page.waitForFunction(
    () => performance.getEntriesByName('pattern-started').length > 0,
    undefined,
    { timeout: Math.min(timeout, 10_000) }
  );
  const ready = await page.waitForFunction(
    () => {
      const start = performance.getEntriesByName('pattern-input', 'mark')[0];
      const end = performance.getEntriesByName('pattern-enabled', 'mark')[0];
      if (!start || !end) return false;
      const requests = performance
        .getEntriesByName('pattern-started', 'mark')
        .filter(
          (e) => e.startTime >= start.startTime && e.startTime <= end.startTime
        );
      if (requests.length !== 1)
        throw new Error(
          'Expected exactly one checked pattern preview for this input.'
        );
      const id = (requests[0] as PerformanceMark).detail as string;
      const stages = performance
        .getEntriesByName('pattern-stage', 'mark')
        .filter(
          (e) => e.startTime >= start.startTime && e.startTime <= end.startTime
        )
        .map((e) => ({
          ...((e as PerformanceMark).detail as Omit<StageLog, 't'>),
          t: performance.timeOrigin + e.startTime
        }))
        .filter((stage) => stage.requestId === id);
      return {
        inputAt: start.startTime,
        enabledAt: end.startTime,
        previewMs: end.startTime - start.startTime,
        stages
      };
    },
    undefined,
    { timeout }
  );
  return (await ready.jsonValue()) as {
    inputAt: number;
    enabledAt: number;
    previewMs: number;
    stages: StageLog[];
  };
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  await page
    .screenshot({ path: testInfo.outputPath('stalled.png') })
    .catch(() => undefined);
});

const scenarioName = linearCopies
  ? `overlapping linear pattern preview with ${linearCopies} cylinders`
  : 'large grid pattern preview on the ×50 bar';
test(scenarioName, async ({ page, browser }, testInfo) => {
  test.setTimeout(1_200_000);
  const hostBefore = hostSnapshot();
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    const observed = new WeakSet<Worker>();
    Worker.prototype.postMessage = function (message: unknown, options?) {
      const request = message as GeometryWorkerRequest | null;
      if (!observed.has(this)) {
        observed.add(this);
        this.addEventListener(
          'message',
          ({ data }: MessageEvent<GeometryWorkerResult>) => {
            if (data?.type === 'state' && data.requestId && data.progress)
              performance.mark('pattern-stage', {
                detail: {
                  projectId: data.projectId,
                  version: data.version,
                  requestId: data.requestId,
                  ...data.progress
                }
              });
          }
        );
      }
      if (request?.type === 'sync' && request.requestId)
        performance.mark('pattern-started', { detail: request.requestId });
      post.call(this, message, options as StructuredSerializeOptions);
    };
  });
  const runtimeErrors: string[] = [];
  const timeout = Number(process.env.OZ_PERF_PATTERN_TIMEOUT_MS ?? 600_000);
  page.on('pageerror', (error) => runtimeErrors.push(error.message));

  await stubApi(page, { panelLayout: MODEL_ONLY });
  const project = linearCopies
    ? addPrimitiveFeature(
        createProjectDocument('Spacing preview', toUserId('user_e2e')),
        {
          name: 'Stock',
          primitiveKind: 'cylinder',
          dimensions: { radius: 5, height: 10 }
        }
      )
    : largePatternBar('Pattern preview perf').document;
  const opened = Date.now();
  await openDocument(page, project);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 300_000
  });
  const openToBarMs = Date.now() - opened;
  console.log(`[perf-pattern-preview] bar built in ${openToBarMs} ms`);
  // A project with bodies opens in View mode; modelling needs Build.
  const build = page.getByRole('button', { name: 'Build', exact: true });
  await expect(build).toBeEnabled({ timeout });
  await build.click();
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  const tool = page.getByRole('button', {
    name: linearCopies ? /^Linear pattern/ : /^Grid pattern/
  });
  const steps = [];
  await armPreviewClock(tool, 'click');
  await tool.click();
  steps.push({
    grid: linearCopies ? 'initial' : '3x3',
    ...(await previewTiming(page, timeout))
  });
  if ((await moreTools.getAttribute('aria-expanded')) === 'true')
    await moreTools.click();

  const edits = linearCopies
    ? ([
        ['spacing', '6', '6'],
        ['count', '11', '11'],
        ['count', '12', '12'],
        ['count', linearCopies, linearCopies],
        ...['7', '6.25', '6.5', '6.75', '7.25'].map(
          (spacing) => ['spacing', spacing, spacing] as const
        )
      ] as const)
    : ([
        ['count', '10', '10x3'],
        ['count2', '10', '10x10']
      ] as const);
  for (const [valueId, value, grid] of edits) {
    await page.getByTestId(`command-handle-${valueId}`).click();
    const input = page.locator('.numeric-keypad input');
    await expect(input).toBeVisible();
    await armPreviewClock(input, 'input');
    await input.fill(value);
    await input.press('Enter');
    steps.push({
      grid,
      ...(await previewTiming(page, timeout))
    });
  }
  const finalValues = linearCopies
    ? ([
        ['count', linearCopies],
        ['spacing', '7.25']
      ] as const)
    : ([
        ['count', '10'],
        ['count2', '10']
      ] as const);
  for (const [valueId, value] of finalValues)
    await expect(page.getByTestId(`command-handle-${valueId}`)).toContainText(
      value
    );

  const webglRenderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer: unknown = debug
      ? gl?.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof renderer === 'string' ? renderer : null;
  });
  const sample = {
    probe: linearCopies ? 'overlapping-linear-spacing' : 'perf-pattern-preview',
    ...(linearCopies ? { copies: Number(linearCopies) } : {}),
    timingVersion: 2,
    recordedAt: new Date().toISOString(),
    repeat: testInfo.repeatEachIndex,
    browserVersion: browser.version(),
    angle: process.env.OZ_PERF_ANGLE ?? null,
    webglRenderer,
    openToBarMs,
    steps,
    runtimeErrors,
    host: { before: hostBefore, after: hostSnapshot() }
  };
  const out = resolve(
    process.env.OZ_PERF_OUT ??
      (linearCopies
        ? `perf-results/perf-linear-spacing-${linearCopies}.jsonl`
        : 'perf-results/perf-pattern-preview-v2.jsonl')
  );
  mkdirSync(dirname(out), { recursive: true });
  appendFileSync(out, `${JSON.stringify(sample)}\n`);
  console.log(
    `[perf-pattern-preview] ${webglRenderer}; bar ${openToBarMs} ms; ` +
      steps
        .map((step) => `${step.grid} ${step.previewMs.toFixed(0)} ms`)
        .join('; ')
  );
  expect(runtimeErrors).toEqual([]);
});
