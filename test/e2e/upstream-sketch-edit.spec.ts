import { appendFileSync } from 'node:fs';
import { hostSnapshot, perfBrowserArgs } from '../../scripts/perf-host.mjs';
import { CommandManager } from '@openzcad/command-system';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import type { GeometryWorkerRequest } from '../../apps/web/src/worker/geometryWorker';
import {
  loftedHollowDuct,
  upperDuctSectionEdit
} from '../fixtures/lofted-hollow-duct';
import {
  expect,
  test,
  stubApi,
  bodyCardFromHistory
} from './openzcad-fixtures';

if (process.env.OZ_PERF_ANGLE)
  test.use({ launchOptions: { args: perfBrowserArgs() } });

/**
 * Production QA CAD-002 (2026-10-11): narrowing a shelled loft's upper section
 * from History committed, the shell lost its top opening, and the solid loft
 * was drawn, saved and exported to STEP as the design. The edit must now be
 * refused with the last valid model kept, and a document already in that
 * failed state must not offer the stand-in body for export.
 */
async function importProject(page: Page, document: ProjectDocument) {
  await page.getByLabel('Import project backup').setInputFiles({
    name: `${document.name}.openzcad`,
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
  ).toContainText(document.name);
}

async function createProject(page: Page, name: string) {
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(name);
  // Importing over a project that is still being created races its save.
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
}

/** The card of the body the last History row built. */
async function bodyReadout(page: Page) {
  const inspector = await bodyCardFromHistory(page);
  await expect(inspector.getByText(/mm³/).first()).toBeVisible();
  return inspector;
}

async function openFileMenu(page: Page) {
  const menu = page.locator('details.file-menu');
  if ((await menu.getAttribute('open')) === null)
    await menu.locator('summary').click();
  return menu;
}

function plateWithHole(independentBoxes: number): ProjectDocument {
  const rectangle = (
    document: ProjectDocument,
    name: string,
    width: number,
    height: number
  ) =>
    addSketchFeature(document, {
      name,
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'rectangle', width, height, centerX: 0, centerY: 0 }
      ]
    });
  const base = createProjectDocument('Plate with a hole', toUserId('local'));
  const profile = rectangle(base, 'Plate profile', 20, 10);
  let model = profile.document;
  for (let i = 0; i < independentBoxes; i++) {
    model = addPrimitiveFeature(model, {
      name: `Independent ${i}`,
      primitiveKind: 'box',
      dimensions: { width: 5, height: 4, depth: 3 }
    });
  }
  const plate = extrudeSketch(model, {
    name: 'Plate',
    sketchId: profile.sketchId,
    distance: 4
  });
  const hole = rectangle(plate.document, 'Hole profile', 2, 2);
  const tool = extrudeSketch(hole.document, {
    name: 'Tool',
    sketchId: hole.sketchId,
    distance: 4
  });
  return booleanBodies(tool.document, {
    name: 'Pocketed plate',
    operation: 'subtract',
    targetBodyIds: [plate.bodyId, tool.bodyId]
  }).document;
}

async function openPlate(page: Page, independentBoxes: number) {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, options?) {
      const request = message as GeometryWorkerRequest | null;
      if (request?.type === 'sync') {
        performance.mark('sketch-history:sync', {
          detail: {
            projectId: request.document.projectId,
            version: request.document.version,
            checked: !!request.requestId
          }
        });
      }
      post.call(this, message, options as StructuredSerializeOptions);
    };
  });
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await createProject(page, 'History edit');
  await importProject(page, plateWithHole(independentBoxes));
  await expect(await bodyReadout(page)).toContainText('784 mm³');
}

async function changePlateWidth(page: Page, width: number) {
  await page.keyboard.press('Escape');
  await page.locator('.feature-row-main', { hasText: 'Plate profile' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Width', { exact: true }).fill(String(width));
  const apply = inspector.getByRole('button', { name: 'Apply', exact: true });
  await apply.evaluate((button) => {
    performance.clearMeasures('oz:edit.analysis-ready');
    performance.clearMarks('sketch-history:apply');
    performance.clearMarks('sketch-history:sync');
    button.addEventListener(
      'click',
      () => performance.mark('sketch-history:apply'),
      { once: true, capture: true }
    );
  });
  await apply.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          performance.getEntriesByName('oz:edit.analysis-ready', 'measure')
            .length
      )
    )
    .toBeGreaterThan(0);
  const volume = width * 10 * 4 - 2 * 2 * 4;
  await expect(await bodyReadout(page)).toContainText(`${volume} mm³`);
  const result = await page.evaluate(() => {
    const start = performance.getEntriesByName(
      'sketch-history:apply',
      'mark'
    )[0]!.startTime;
    const requests = performance
      .getEntriesByName('sketch-history:sync', 'mark')
      .filter((entry) => entry.startTime >= start)
      .map((entry) => ({
        at: entry.startTime,
        ...((entry as PerformanceMark).detail as {
          projectId: string;
          version: number;
          checked: boolean;
        })
      }));
    const check = requests.find((request) => request.checked);
    if (!check) throw new Error('Missing sketch validation request');
    const completions = performance
      .getEntriesByName('oz:edit.analysis-ready', 'measure')
      .map((entry) => ({
        end: entry.startTime + entry.duration,
        ...((entry as PerformanceMeasure).detail as {
          projectId: string;
          version: number;
          adopted?: number;
        })
      }))
      .filter(
        (entry) =>
          entry.end >= check.at &&
          entry.projectId === check.projectId &&
          entry.version >= check.version
      )
      .sort((a, b) => a.end - b.end);
    const last = completions.at(-1);
    if (!last)
      throw new Error('Missing committed geometry for the sketch edit');
    const syncs = requests.filter(
      (request) =>
        request.projectId === check.projectId &&
        request.version >= check.version &&
        request.at <= last.end
    ).length;
    return { exactMs: last.end - start, adopted: last.adopted === 1, syncs };
  });
  return { width, volume, ...result };
}

test(
  'adopts the checked History sketch edit for the downstream cut',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await openPlate(page, 0);
    expect(await changePlateWidth(page, 22)).toMatchObject({
      adopted: true,
      syncs: 1
    });
  }
);

test.describe('History sketch performance', () => {
  test('measures Apply through committed Boolean geometry', async ({
    page
  }, testInfo) => {
    test.skip(!process.env.OZ_PERF, 'Opt-in geometry benchmark');
    const load = hostSnapshot();
    await openPlate(page, 30);
    const samples = [];
    for (const width of [22, 23, 24])
      samples.push(await changePlateWidth(page, width));
    const report = { load, angle: process.env.OZ_PERF_ANGLE ?? null, samples };
    const json = JSON.stringify(report);
    await testInfo.attach('sketch-history-performance.json', {
      contentType: 'application/json',
      body: json
    });
    if (process.env.OZ_SKETCH_HISTORY_OUT)
      appendFileSync(process.env.OZ_SKETCH_HISTORY_OUT, json + '\n');
  });
});

test('refuses an upstream section edit that strands a dependent shell, and keeps the hollow duct', async ({
  page
}, testInfo) => {
  test.setTimeout(150_000);
  const adapter = await createExactKernelAdapter();
  let hollow: ProjectDocument;
  try {
    hollow = (await loftedHollowDuct(adapter, { name: 'QA hollow duct' }))
      .document;
  } finally {
    adapter.dispose();
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await createProject(page, 'Upstream edit');
  await importProject(page, hollow);
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('warnings0', { timeout: 30_000 });

  let inspector = await bodyReadout(page);
  await expect(inspector).toContainText('12630.86 mm³');

  // History: the upper section's Width 40 → 30, then Apply.
  await page
    .locator('.feature-row-main', { hasText: 'Upper duct section' })
    .click();
  inspector = page.getByRole('region', { name: 'Feature inspector' });
  const width = inspector.getByLabel('Width', { exact: true });
  await expect(width).toHaveValue('40');
  await width.fill('30');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();

  // Refused, naming the feature that cannot rebuild; the card stays open
  // with the typed value so the user can change it.
  await expect(inspector.getByRole('alert')).toContainText(
    '“Open-ended duct wall” can no longer find an edge or face',
    { timeout: 60_000 }
  );
  await expect(width).toHaveValue('30');
  await testInfo.attach('refused-section-edit', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  await expect(status).toContainText('warnings0');
  // History names the feature that could not rebuild and offers to open it.
  const details = page.getByRole('region', { name: 'History details' });
  await expect(details.getByRole('alert')).toContainText(
    'The previous model is intact'
  );
  await expect(
    details.getByRole('button', { name: 'Edit Open-ended duct wall' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  inspector = await bodyReadout(page);
  await expect(inspector).toContainText('12630.86 mm³');
  await expect(inspector).toContainText(/faces\s*10/);

  // Nothing reached history: a reload reopens the hollow duct.
  await page.reload();
  await expect(status).toContainText('warnings0', { timeout: 30_000 });
  inspector = await bodyReadout(page);
  await expect(inspector).toContainText('12630.86 mm³');

  // The hollow body exports; the STEP holds its ten faces, not six.
  const menu = await openFileMenu(page);
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await menu.getByRole('button', { name: /Export STEP/ }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const step = Buffer.concat(chunks).toString('utf8');
  expect(step.match(/ADVANCED_FACE\(/g)).toHaveLength(10);
  expect(errors).toEqual([]);
});

test('does not export the stand-in body of a shell that already failed', async ({
  page
}) => {
  test.setTimeout(150_000);
  const adapter = await createExactKernelAdapter();
  let failed: ProjectDocument;
  try {
    const hollow = (
      await loftedHollowDuct(adapter, { name: 'QA failed shell' })
    ).document;
    // A document saved in the failed state, as the QA run's was.
    const manager = new CommandManager(hollow);
    manager.runTransaction(
      'Edit Upper duct section',
      upperDuctSectionEdit(hollow, 30)
    );
    failed = manager.document;
  } finally {
    adapter.dispose();
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await createProject(page, 'Failed shell');
  await importProject(page, failed);
  await expect(page.getByRole('contentinfo')).toContainText('warnings1', {
    timeout: 30_000
  });

  const menu = await openFileMenu(page);
  const note = menu.getByRole('note');
  await expect(note).toContainText('not exported');
  await expect(note).toContainText('“Open-ended duct wall” failed to rebuild');
  await expect(
    menu.getByRole('button', { name: /Export STEP/ })
  ).toBeDisabled();
  await expect(
    menu.getByRole('button', { name: /Export mesh/ })
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
