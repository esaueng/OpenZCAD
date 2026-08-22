import { test, expect, type Page } from '@playwright/test';
import { seedDismissedWorkspaceTour } from './openzcad-fixtures';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

// Measurement, not a pass/fail check: timings vary far too much between
// machines and GPU states to gate CI on. Run deliberately:
//   OZ_PERF=1 pnpm exec playwright test perf-probe
test.skip(!process.env.OZ_PERF, 'Performance probe; set OZ_PERF=1 to run it.');

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
  await page.route('**/api/projects', (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as {
        name: string;
        units?: string;
      };
      const document = createProjectDocument(
        payload.name,
        toUserId('user_e2e'),
        (payload.units as 'mm' | undefined) ?? 'mm'
      );
      return route.fulfill({
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
      });
    }
    return route.fulfill({ json: { projects: [] } });
  });
  await page.route('**/api/projects/*/revisions', (route) => {
    // GET lists save states when a project opens; only an explicit save POSTs
    // a document. Reading post data off the GET throws inside the handler and
    // strands the page, so the verb decides first.
    if (route.request().method() !== 'POST') {
      return route.fulfill({ json: { revisions: [], maxRevisions: 50 } });
    }
    const payload = route.request().postDataJSON() as { document: unknown };
    return route.fulfill({ json: payload.document });
  });
}

test('perf probe', async ({ page }) => {
  const runtimeErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('requestfailed', (request) =>
    failedRequests.push(
      `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`
    )
  );
  await stubApi(page);

  await page.addInitScript(() => {
    (window as unknown as { __long: unknown[] }).__long = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        (window as unknown as { __long: unknown[] }).__long.push({
          at: Math.round(entry.startTime),
          ms: Math.round(entry.duration)
        });
      }
    }).observe({ entryTypes: ['longtask'] });
  });

  const t0 = Date.now();
  await page.goto('/');
  await expect(page.getByLabel('Project name')).toBeVisible();
  const shellVisible = Date.now() - t0;

  const nav = await page.evaluate(() => {
    const entry = performance.getEntriesByType(
      'navigation'
    )[0] as PerformanceNavigationTiming;
    const paints = performance.getEntriesByType('paint');
    const resources = performance
      .getEntriesByType('resource')
      .map((raw) => {
        const item = raw as PerformanceResourceTiming;
        return {
          name: item.name.replace(/^https?:\/\/[^/]+/, ''),
          ms: Math.round(item.duration),
          kb: Math.round((item.transferSize ?? 0) / 1024),
          start: Math.round(item.startTime)
        };
      })
      .filter((item) => item.ms > 5 || item.kb > 20)
      .sort((a, b) => b.ms - a.ms);
    return {
      domContentLoaded: Math.round(entry.domContentLoadedEventEnd),
      loadEvent: Math.round(entry.loadEventEnd),
      fcp: Math.round(
        paints.find((p) => p.name === 'first-contentful-paint')?.startTime ?? -1
      ),
      resources
    };
  });

  // Cold project creation: first one in this browser context.
  const clickAt = await page.evaluate(() => Math.round(performance.now()));
  const c0 = Date.now();
  await page.getByLabel('Project name').fill('Perf Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
  const coldCreate = Date.now() - c0;

  // First exact geometry operation: this is where the kernel actually boots.
  const b0 = Date.now();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  const firstBox = Date.now() - b0;

  // Second operation: kernel is warm now.
  const b1 = Date.now();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await page.waitForTimeout(50);
  const secondBox = Date.now() - b1;

  const afterGeometry = await page.evaluate(() => {
    // No size filter: the question is whether the WASM kernels load at all.
    const resources = performance
      .getEntriesByType('resource')
      .map((raw) => {
        const item = raw as PerformanceResourceTiming;
        return {
          name: item.name.replace(/^https?:\/\/[^/]+/, ''),
          ms: Math.round(item.duration),
          kb: Math.round((item.transferSize ?? 0) / 1024),
          decodedKb: Math.round((item.decodedBodySize ?? 0) / 1024)
        };
      })
      .sort((a, b) => b.decodedKb - a.decodedKb);
    return {
      resources: resources.filter((item) => item.decodedKb > 50),
      long: (window as unknown as { __long: unknown[] }).__long,
      phases: performance
        .getEntriesByType('measure')
        .filter((entry) => entry.name.startsWith('oz:') && entry.duration >= 1)
        .map((entry) => ({
          name: entry.name,
          at: Math.round(entry.startTime),
          ms: Math.round(entry.duration)
        }))
        .sort((a, b) => b.ms - a.ms)
    };
  });

  // Reload with the document already in local storage (P-01 shape).
  const r0 = Date.now();
  await page.reload();
  const restored = await page
    .getByRole('button', { name: /^Box \(B\)/ })
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  await expect(page.locator('body')).toBeVisible();
  const reload = Date.now() - r0;

  const thresholds = { pageLoadMs: 3_000, interactionMs: 1_000 };
  const violations = [
    shellVisible > thresholds.pageLoadMs
      ? { phase: 'launcher', ms: shellVisible, budget: thresholds.pageLoadMs }
      : null,
    coldCreate > thresholds.interactionMs
      ? {
          phase: 'cold project creation',
          ms: coldCreate,
          budget: thresholds.interactionMs
        }
      : null,
    firstBox > thresholds.interactionMs
      ? {
          phase: 'first exact operation',
          ms: firstBox,
          budget: thresholds.interactionMs
        }
      : null,
    secondBox > thresholds.interactionMs
      ? {
          phase: 'warm exact operation',
          ms: secondBox,
          budget: thresholds.interactionMs
        }
      : null,
    reload > thresholds.pageLoadMs
      ? { phase: 'workspace reload', ms: reload, budget: thresholds.pageLoadMs }
      : null
  ].filter(Boolean);

  console.log(
    'PERF ' +
      JSON.stringify(
        {
          shellVisible,
          nav,
          clickAt,
          coldCreate,
          firstBox,
          secondBox,
          afterGeometry,
          reload,
          restoredIntoWorkspace: restored,
          thresholds,
          violations,
          runtimeErrors,
          failedRequests
        },
        null,
        2
      )
  );
  expect(runtimeErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
