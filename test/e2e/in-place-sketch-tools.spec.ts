import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U09 phase 2: Loft, Sweep and Helical sweep run in place. No card opens;
 * profiles are region clicks, a sweep's path is clicks on sketch curves, a
 * helix's axis is a click on a drawn axis line, and its numbers are handles
 * and chips. Nothing here types into a form field except the keypad.
 */

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

async function pickProfile(canvas: Locator, index: number) {
  await canvas.evaluate(
    (element, detail) =>
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-profile', { detail })
      ),
    { index, additive: false }
  );
}

async function projected(
  canvas: Locator,
  point: [number, number, number]
): Promise<{ x: number; y: number }> {
  return canvas.evaluate(
    (element, points) =>
      new Promise<{ x: number; y: number }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points[0]!)
            }
          })
        );
      }),
    [point]
  );
}

async function exportedDocument(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download', { timeout: 15_000 });
  await menu.getByRole('button', { name: /Export project/ }).click();
  const download = await pending;
  if ((await menu.getAttribute('open')) !== null) {
    await menu.locator('summary').click();
  }
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

/** A marker body, so the viewer has something rendered before the tool. */
function withMarker(name: string): ProjectDocument {
  return addPrimitiveFeature(createProjectDocument(name, toUserId('user_e2e')), {
    name: 'Marker',
    primitiveKind: 'box',
    dimensions: { width: 2, height: 2, depth: 2 }
  });
}

/** Opens `document`, fits it, folds the extra tools away, starts `tool`. */
async function startTool(
  page: Page,
  document: ProjectDocument,
  tool: RegExp
): Promise<{ canvas: Locator; bar: Locator }> {
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: tool }).click();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  return { canvas, bar: page.locator('.in-place-command') };
}

test('Loft runs in place: two section clicks, then Done', async ({ page }) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  let document = withMarker('In-place loft');
  document = addSketchFeature(document, {
    name: 'Base',
    plane: 'XY',
    offset: 0,
    object: { objectKind: 'rectangle', width: 20, height: 20, centerX: 30, centerY: 0 }
  }).document;
  document = addSketchFeature(document, {
    name: 'Top',
    plane: 'XY',
    offset: 20,
    object: { objectKind: 'circle', radius: 6, centerX: 30, centerY: 0 }
  }).document;
  const { canvas, bar } = await startTool(page, document, /^Loft\b/);
  await expect(bar).toContainText('Loft');
  await expect(page.locator('form.feature-form')).toHaveCount(0);
  await expect
    .poll(async () => {
      await pickProfile(canvas, 0);
      return bar.textContent();
    })
    .toContain('next section');
  await pickProfile(canvas, 1);
  await expect(bar).toContainText('2 sections');
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 2);
  const saved = await exportedDocument(page);
  const lofts = listFeaturesInOrder(saved).flatMap((feature) =>
    feature.data.featureKind === 'loft' ? [feature.data] : []
  );
  expect(lofts).toHaveLength(1);
  expect(lofts[0]!.sections).toHaveLength(2);
});

test('a picked region offers Loft, which takes it as the first section', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  let document = withMarker('Region verbs');
  document = addSketchFeature(document, {
    name: 'Base',
    plane: 'XY',
    offset: 0,
    object: { objectKind: 'rectangle', width: 20, height: 20, centerX: 30, centerY: 0 }
  }).document;
  document = addSketchFeature(document, {
    name: 'Top',
    plane: 'XY',
    offset: 20,
    object: { objectKind: 'circle', radius: 6, centerX: 30, centerY: 0 }
  }).document;
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  // A region pick arms Extrude; its card offers the other profile tools.
  const card = page.getByRole('region', { name: 'Extrude operation' });
  await expect
    .poll(async () => {
      await pickProfile(canvas, 0);
      return card.count();
    })
    .toBe(1);
  await expect(card.getByRole('button', { name: 'Selection: Revolve' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Selection: Sweep' })).toBeVisible();
  await card.getByRole('button', { name: 'Selection: Loft' }).click();
  await expect(card).toHaveCount(0);
  const bar = page.locator('.in-place-command');
  await expect(bar).toContainText('next section');
  await pickProfile(canvas, 1);
  await expect(bar).toContainText('2 sections');
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expectBodyCount(page, 2);
});

test('Sweep runs in place: profile, path curve clicks, Done', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  let document = withMarker('In-place sweep');
  document = addSketchFeature(document, {
    name: 'Profile',
    plane: 'XY',
    offset: 0,
    object: { objectKind: 'circle', radius: 2, centerX: 30, centerY: 0 }
  }).document;
  // An L-shaped path rising from the profile's centre on Front (XZ).
  document = addSketchFeature(document, {
    name: 'Path',
    plane: 'XZ',
    offset: 0,
    objects: [
      { objectKind: 'line', x1: 30, y1: 0, x2: 30, y2: 20 },
      { objectKind: 'line', x1: 30, y1: 20, x2: 45, y2: 20 }
    ]
  }).document;
  const { canvas, bar } = await startTool(page, document, /^Sweep\b/);
  await expect(page.locator('form.feature-form')).toHaveCount(0);
  await expect
    .poll(async () => {
      await pickProfile(canvas, 0);
      return bar.textContent();
    })
    .toContain('Pick the path');
  // Click each path line at its middle. Front's sketch v runs along world
  // −Z, so the path's rise in sketch coordinates is a drop in the world.
  for (const point of [
    [30, 0, -10],
    [37.5, 0, -20]
  ] as [number, number, number][]) {
    const on = await projected(canvas, point);
    await page.mouse.move(on.x, on.y);
    await page.mouse.click(on.x, on.y);
  }
  await expect(bar).toContainText('Path of 2');
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 2);
  const saved = await exportedDocument(page);
  const sweeps = listFeaturesInOrder(saved).flatMap((feature) =>
    feature.data.featureKind === 'sweep' ? [feature.data] : []
  );
  expect(sweeps).toHaveLength(1);
  expect(sweeps[0]!.path.entityIds).toHaveLength(2);
});

test('Helical sweep runs in place: profile, axis, turns from the keypad', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  let document = withMarker('In-place helix');
  document = addSketchFeature(document, {
    name: 'Coil',
    plane: 'XZ',
    offset: 0,
    object: { objectKind: 'circle', radius: 1, centerX: 10, centerY: 0 }
  }).document;
  const { canvas, bar } = await startTool(page, document, /^Helical sweep\b/);
  await expect
    .poll(async () => {
      await pickProfile(canvas, 0);
      return bar.textContent();
    })
    .toContain('helix axis');
  const onAxis = await projected(canvas, [0, 0, 6]);
  await page.mouse.move(onAxis.x, onAxis.y);
  await page.mouse.click(onAxis.x, onAxis.y);
  await expect(bar).toContainText('Drag radius and pitch');
  await expect(page.getByTestId('command-handle-radius')).toContainText('10');
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });

  const turns = page.getByTestId('command-handle-turns');
  await expect(turns).toHaveText('3 turns');
  await turns.click();
  const keypad = page.locator('.numeric-keypad');
  await expect(keypad).toBeVisible();
  await keypad.locator('input').fill('5');
  await keypad.locator('input').press('Enter');
  await expect(turns).toHaveText('5 turns');
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 2);
  const saved = await exportedDocument(page);
  const helices = listFeaturesInOrder(saved).flatMap((feature) =>
    feature.data.featureKind === 'helical-sweep' ? [feature.data] : []
  );
  expect(helices).toHaveLength(1);
  expect(helices[0]!.turns).toBe(5);
  expect(Number(helices[0]!.radius)).toBeCloseTo(10, 6);
});
