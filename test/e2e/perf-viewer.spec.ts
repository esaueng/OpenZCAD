import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  createPrimitiveInPlace,
  expectBodyCount
} from './openzcad-fixtures';

// Deliberate measurement, never an absolute FPS gate. Keep profiles and model
// captures in an explicitly chosen directory outside the source checkout.
const output = process.env.OZ_VIEWER_PERF_OUT;
test.skip(
  !process.env.OZ_PERF || !output,
  'Set OZ_PERF=1 and OZ_VIEWER_PERF_OUT to an evidence directory.'
);
if (process.env.OZ_VIEWER_CHANNEL)
  test.use({ channel: process.env.OZ_VIEWER_CHANNEL });
test.use({ viewport: { width: 1600, height: 1000 } });

function stats(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    null;
  return {
    count: sorted.length,
    median: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? null,
    mean: sorted.length
      ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
      : null
  };
}

test('profiles idle, hover, orbit, zoom and diagnostics on the real viewer', async ({
  page,
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'CPU profiles require Chromium CDP.');
  test.setTimeout(180_000);
  const folder = output!;
  mkdirSync(folder, { recursive: true });
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await stubApi(page);
  const count = process.env.OZ_VIEWER_BODIES === '32' ? 32 : 2;
  if (count === 32) {
    await page.route('**/api/projects', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      let document = createProjectDocument(
        'Viewer cylinder array',
        toUserId('user_e2e')
      );
      for (let index = 0; index < count; index++) {
        document = addPrimitiveFeature(document, {
          name: `Cylinder ${index + 1}`,
          primitiveKind: 'cylinder',
          dimensions: { radius: 6, height: 28 }
        });
        document = transformBody(document, {
          name: 'Place cylinder',
          targetBodyId: document.bodyOrder.at(-1)!,
          translation: {
            x: (index % 8) * 20,
            y: Math.floor(index / 8) * 20,
            z: 0
          }
        }).document;
      }
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
    });
  }
  await page.goto('/');
  await page.getByLabel('Project name').fill('Viewer performance QA');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  if (count === 2) {
    await createPrimitiveInPlace(page, 'box');
    await createPrimitiveInPlace(page, 'cylinder', { at: { x: 30 } });
  }
  await expectBodyCount(page, count);
  await page.keyboard.press('Escape');
  const canvas = page.locator('.viewer-host canvas').first();
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1500);
  const client = await page.context().newCDPSession(page);
  const browser = await client.send('Browser.getVersion');
  const gpu = await canvas.evaluate((element) => {
    const gl = (element as HTMLCanvasElement).getContext('webgl2')!;
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: extension
        ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER)),
      dpr: devicePixelRatio
    };
  });
  const results: {
    name: string;
    intervals: ReturnType<typeof stats>;
    cpu: ReturnType<typeof stats>;
    render: ReturnType<typeof stats>;
    overlays: ReturnType<typeof stats>;
  }[] = [];
  async function record(name: string, action: () => Promise<unknown>) {
    await page.evaluate(() => performance.clearMarks('oz:viewer.frame'));
    await client.send('Profiler.enable');
    await client.send('Profiler.start');
    await action();
    const { profile } = await client.send('Profiler.stop');
    const frames = await page.evaluate(() =>
      performance.getEntriesByName('oz:viewer.frame').map(
        (entry) =>
          (entry as PerformanceMark).detail as {
            frameMs: number | null;
            cpuMs: number;
            renderMs: number;
            overlayMs: number;
            drawCalls: number;
            triangles: number;
          }
      )
    );
    // The first mark may follow a resting viewer: do not call its idle gap a
    // slow frame. Keep all subsequent intervals, including genuine hitches.
    const summary = {
      name,
      intervals: stats(
        frames
          .slice(1)
          .flatMap((frame) => (frame.frameMs === null ? [] : [frame.frameMs]))
      ),
      cpu: stats(frames.map((frame) => frame.cpuMs)),
      render: stats(frames.map((frame) => frame.renderMs)),
      overlays: stats(frames.map((frame) => frame.overlayMs))
    };
    results.push(summary);
    writeFileSync(
      join(folder, `${name}.json`),
      JSON.stringify({ frames, profile, summary })
    );
  }
  const box = (await canvas.boundingBox())!;
  const orbit = async () => {
    await page.mouse.move(box.x + 150, box.y + box.height - 180);
    await page.keyboard.down('Shift');
    await page.mouse.down();
    for (let index = 0; index < 180; index++)
      await page.mouse.move(
        box.x + 150 + 150 * Math.sin(index * 0.035),
        box.y + box.height - 180 - 100 * Math.sin(index * 0.06)
      );
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForTimeout(700);
  };
  await record('idle', () => page.waitForTimeout(3000));
  await record('hover', async () => {
    for (let index = 0; index < 180; index++)
      await page.mouse.move(
        box.x + box.width * (0.25 + (0.5 * (index % 60)) / 60),
        box.y + box.height * (0.4 + 0.2 * Math.sin(index * 0.12))
      );
  });
  await record('orbit', orbit);
  await record('zoom', async () => {
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    for (let index = 0; index < 60; index++) {
      await page.mouse.wheel(0, index < 30 ? 12 : -12);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(700);
  });
  await page
    .getByRole('button', { name: 'Open settings', exact: true })
    .click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'Frame rate overlay', exact: true })
    .check();
  await page
    .getByRole('button', { name: /Back to workspace|Close settings/ })
    .click();
  await record('diagnostics-orbit', orbit);
  await page.screenshot({ path: join(folder, 'viewer.png') });
  writeFileSync(
    join(folder, 'summary.json'),
    JSON.stringify({ browser, gpu, count, errors, warnings, results }, null, 2)
  );
  expect(errors).toEqual([]);
  expect(
    results.find((result) => result.name === 'orbit')?.cpu.count
  ).toBeGreaterThan(10);
});
