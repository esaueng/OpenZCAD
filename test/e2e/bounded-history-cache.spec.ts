import { appendFileSync, readFileSync } from 'node:fs';
import {
  addPrimitiveFeature,
  createProjectDocument,
  importStepBody,
  setParameter
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { expect, test, stubApi, expectBodyCount } from './openzcad-fixtures';

declare global {
  interface Window {
    __historyProbe: {
      ready: number[];
      frames: { t: number; bounds: string }[];
    };
  }
}

test('edits a 33-feature history, refuses invalid geometry, undoes, redoes and exports', async ({
  page,
  browser
}, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const httpErrors: { url: string; status: number }[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400)
      httpErrors.push({ url: response.url(), status: response.status() });
  });
  const stages: {
    stage: string;
    name: string;
    index?: number;
    durationMs?: number;
  }[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
    if (message.text().startsWith('[geometry rebuild] '))
      stages.push(
        JSON.parse(message.text().slice(19)) as (typeof stages)[number]
      );
  });
  await stubApi(page);
  await page.addInitScript(() => {
    window.__historyProbe = { ready: [], frames: [] };
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener('message', (event: MessageEvent) => {
          const state = event.data as {
            type?: string;
            phase?: string;
            requestId?: string;
            stale?: boolean;
          };
          if (
            state.type === 'state' &&
            state.phase === 'ready' &&
            !state.requestId &&
            !state.stale
          )
            window.__historyProbe.ready.push(performance.now());
        });
      }
    };
  });
  let document = createProjectDocument(
    'Bounded history browser',
    toUserId('local')
  );
  if (process.env.HISTORY_TOWEL_STEP)
    document = importStepBody(document, {
      name: 'Towel',
      artifactId: 'towel',
      sourceName: 'towel.step',
      stepText: readFileSync(process.env.HISTORY_TOWEL_STEP, 'utf8')
    }).document;
  document = setParameter(document, { name: 'box_width', expression: '10' });
  for (let i = document.featureOrder.length; i < 33; i++)
    document = addPrimitiveFeature(document, {
      name: `Box${i}`,
      primitiveKind: 'box',
      dimensions: { width: i === 32 ? 'box_width' : 10, height: 10, depth: 10 }
    });
  await page.goto('/');
  await expect(page).toHaveTitle(/OpenZCAD/);
  await page.getByLabel('Project name').fill('History verification');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('History verification');
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  const loadStart = Date.now();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'history.openzcad',
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
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Bounded history browser');
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 180_000
  });
  const canvas = page.locator('.viewer-host canvas');
  const bounds = () =>
    canvas.evaluate(
      (el) =>
        new Promise<string>((resolve) => {
          el.dispatchEvent(
            new CustomEvent('openzcad:e2e-render-policy', {
              detail: {
                resolve: (state: { bodyFaces: { bounds: unknown }[] }) =>
                  resolve(JSON.stringify(state.bodyFaces.map((x) => x.bounds)))
              }
            })
          );
        })
    );
  // Wait for exact geometry to reach the renderer before calling edits warm.
  // This document has no projection-producing patterns or preview meshes.
  await expect.poll(bounds, { timeout: 180_000 }).not.toBe('[]');
  await expectBodyCount(page, 33);
  const originalBounds = await bounds();
  const coldMs = Date.now() - loadStart;
  await canvas.evaluate((el) => {
    el.addEventListener('openzcad:e2e-camera-frame', () => {
      el.dispatchEvent(
        new CustomEvent('openzcad:e2e-render-policy', {
          detail: {
            resolve: (state: { bodyFaces: { bounds: unknown }[] }) => {
              window.__historyProbe.frames.push({
                t: performance.now(),
                bounds: JSON.stringify(state.bodyFaces.map((x) => x.bounds))
              });
            }
          }
        })
      );
    });
  });
  await page.getByRole('button', { name: 'Tweak', exact: true }).click();
  const field = page.getByLabel('Expression for box_width');
  const samples: {
    value: number;
    ms: number;
    features: string[];
    stages: unknown[];
  }[] = [];
  for (const value of [11, 12, 13]) {
    const previous = await bounds();
    const stageStart = stages.length;
    await field.fill(String(value));
    const start = await page.evaluate(() => {
      window.__historyProbe = { ready: [], frames: [] };
      return performance.now();
    });
    await field.press('Enter');
    await expect(page.getByRole('contentinfo')).toContainText(
      'Parameter box_width updated.',
      { timeout: 120_000 }
    );
    await expect.poll(bounds).not.toBe(previous);
    const presentedAt = () =>
      page.evaluate((previousBounds) => {
        const { ready, frames } = window.__historyProbe;
        const exactAt = ready[0];
        return exactAt === undefined
          ? 0
          : (frames.find(
              (frame) => frame.t >= exactAt && frame.bounds !== previousBounds
            )?.t ?? 0);
      }, previous);
    await expect.poll(presentedAt).toBeGreaterThan(0);
    const current = stages.slice(stageStart);
    const features = current
      .filter((x) => x.stage === 'feature')
      .map((x) => x.name);
    // The worker's real preflight must replay the changed suffix, never the import.
    expect(features).toContain('Box32');
    expect(features.every((name) => name === 'Box32')).toBe(true);
    samples.push({
      value,
      ms: (await presentedAt()) - start,
      features,
      stages: current
    });
  }
  const changedBounds = await bounds();
  expect(changedBounds).not.toBe(originalBounds);
  await field.fill('-1');
  await field.press('Enter');
  await expect(page.getByRole('alert')).toContainText('No change applied', {
    timeout: 120_000
  });
  await expect(field).toHaveValue('13');
  expect(await bounds()).toBe(changedBounds);
  await page.getByRole('button', { name: 'Build', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('12');
  await expect.poll(bounds).not.toBe(changedBounds);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(field).toHaveValue('13');
  await expect.poll(bounds).toBe(changedBounds);
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const downloaded = page.waitForEvent('download');
  await menu.getByRole('button', { name: /STEP/ }).click();
  const stream = await (await downloaded).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const step = Buffer.concat(chunks).toString('utf8');
  expect(step).toContain('ISO-10303-21;');
  expect(step.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(33);
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
  expect(errors).toEqual([]);
  // A local archive upload can fail after a successful STEP download; record it.
  const result = {
    mode: 'bounded',
    coldMs,
    samples,
    errors,
    consoleErrors,
    httpErrors,
    browser: browser.version(),
    viewport: page.viewportSize(),
    url: page.url(),
    title: await page.title()
  };
  if (process.env.HISTORY_BROWSER_OUT)
    appendFileSync(
      process.env.HISTORY_BROWSER_OUT,
      JSON.stringify(result) + '\n'
    );
  await page.screenshot({ path: testInfo.outputPath('history-cache.png') });
});
