import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { ProjectDocument } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  pickObjectsBody
} from './openzcad-fixtures';
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
 * pattern, picks the bar (the card's default 3 × 3 preview), then taps the
 * counts to 10 × 3 and 10 × 10 as a user would. Each step is timed from the
 * input to the card's Done turning enabled again, which happens when the
 * frame for that request has been built and accepted. Appends one JSON line
 * to OZ_PERF_OUT (default perf-results/perf-pattern-preview.jsonl).
 */
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

/** Resolves with the page clock when `done` is enabled again. */
function doneEnabledAt(page: Page, timeout: number): Promise<number> {
  return page
    .waitForFunction(
      () => {
        const bar = document.querySelector(
          '[role="group"][aria-label="Grid pattern command"]'
        );
        const done = [...(bar?.querySelectorAll('button') ?? [])].find(
          (button) => /Done/.test(button.textContent ?? '')
        );
        return done && !done.disabled ? performance.now() : false;
      },
      undefined,
      { polling: 'raf', timeout }
    )
    .then((handle) => handle.jsonValue() as Promise<number>);
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  await page
    .screenshot({ path: testInfo.outputPath('stalled.png') })
    .catch(() => undefined);
});

test('large grid pattern preview on the ×50 bar', async ({
  page,
  browser
}, testInfo) => {
  test.setTimeout(1_200_000);
  const hostBefore = hostSnapshot();
  const stages: StageLog[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (!text.startsWith('[geometry rebuild] ')) return;
    try {
      stages.push({
        t: Date.now(),
        ...(JSON.parse(text.slice('[geometry rebuild] '.length)) as Omit<
          StageLog,
          't'
        >)
      });
    } catch {
      // Not a stage record.
    }
  });
  const runtimeErrors: string[] = [];
  const timeout = Number(process.env.OZ_PERF_PATTERN_TIMEOUT_MS ?? 600_000);
  page.on('pageerror', (error) => runtimeErrors.push(error.message));

  await stubApi(page, { panelLayout: MODEL_ONLY });
  const { document: project } = largePatternBar('Pattern preview perf');
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
  await page.getByRole('button', { name: /^Grid pattern/ }).click();
  const bar = page.getByRole('group', { name: 'Grid pattern command' });
  await expect(bar).toBeVisible();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  const done = bar.getByRole('button', { name: /Done/ });

  const steps: {
    grid: string;
    inputAt: number;
    enabledAt: number;
    previewMs: number;
    stages: StageLog[];
  }[] = [];
  // The default 3 × 3 frame starts when the bar is picked.
  let mark = stages.length;
  let inputAt = await page.evaluate(() => performance.now());
  await pickObjectsBody(page, 'Block');
  console.log('[perf-pattern-preview] bar picked; waiting for the 3x3 frame');
  let enabledAt = await doneEnabledAt(page, timeout);
  steps.push({
    grid: '3x3',
    inputAt,
    enabledAt,
    previewMs: enabledAt - inputAt,
    stages: stages.slice(mark)
  });

  for (const [valueId, grid] of [
    ['count', '10x3'],
    ['count2', '10x10']
  ] as const) {
    await page.getByTestId(`command-handle-${valueId}`).click();
    const keypad = page.locator('.numeric-keypad');
    await expect(keypad).toBeVisible();
    await keypad.locator('input').fill('10');
    mark = stages.length;
    inputAt = await page.evaluate(() => performance.now());
    await keypad.locator('input').press('Enter');
    // A changed request disables Done until its own frame is accepted.
    await expect(done).toBeDisabled({ timeout: 10_000 });
    console.log(`[perf-pattern-preview] waiting for the ${grid} frame`);
    enabledAt = await doneEnabledAt(page, timeout);
    steps.push({
      grid,
      inputAt,
      enabledAt,
      previewMs: enabledAt - inputAt,
      stages: stages.slice(mark)
    });
  }
  // The last frame accepted is the 10 x 10 request.
  for (const valueId of ['count', 'count2'])
    await expect(page.getByTestId(`command-handle-${valueId}`)).toContainText(
      '10'
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
    probe: 'perf-pattern-preview',
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
    process.env.OZ_PERF_OUT ?? 'perf-results/perf-pattern-preview.jsonl'
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
