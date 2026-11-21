import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  helicalSweepProfile,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import { findSketch, resolveParamValue } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY,
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M04: sweeps are exact. A sweep picked in place (a profile, then the path's
 * curves) is built in place from exact surfaces — an L path is two
 * cylinders mitred on an exact ellipse, at the area times the centre line —
 * and a faceted helix saved before exact coils existed is rebuilt exact
 * from its History edit (Build: Exact) and its height dragged.
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

/** Each command handle's grip on screen, with its value. */
async function commandHandles(
  canvas: Locator
): Promise<Record<string, { x: number; y: number; value: number }>> {
  return canvas.evaluate((element) =>
    element.dataset.e2eCommandHandles
      ? (JSON.parse(element.dataset.e2eCommandHandles) as Record<
          string,
          { x: number; y: number; value: number }
        >)
      : {}
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

/** The export carries no derived state; rebuild it exactly here. */
async function rebuilt(document: ProjectDocument) {
  const derived = await (
    await createExactKernelAdapter()
  ).syncDocument(document);
  expect(derived.warnings).toEqual([]);
  return derived;
}

function surfaces(derived: DerivedState, bodyId: BodyId): string[] {
  return (derived.bodyRepresentations[bodyId]?.topology?.faces ?? [])
    .map((face) => face.geometry?.surfaceType ?? 'unknown')
    .sort();
}

test('a picked sweep along an L path is exact and mitred', async ({ page }) => {
  test.setTimeout(150_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  let document = addPrimitiveFeature(
    createProjectDocument('Exact sweep', toUserId('user_e2e')),
    {
      name: 'Marker',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 2, depth: 2 }
    }
  );
  document = addSketchFeature(document, {
    name: 'Profile',
    plane: 'XY',
    offset: 0,
    object: { objectKind: 'circle', radius: 2, centerX: 30, centerY: 0 }
  }).document;
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
  await expect
    .poll(async () => {
      await pickProfile(canvas, 0);
      return bar.textContent();
    })
    .toContain('Pick the path');
  for (const [index, point] of (
    [
      [30, 0, -10],
      [37.5, 0, -20]
    ] as [number, number, number][]
  ).entries()) {
    await page
      .getByRole('button', { name: 'Fit view (F)', exact: true })
      .click();
    await waitForStillViewport(page);
    const on = await projected(canvas, point);
    await page.mouse.move(on.x, on.y);
    await page.mouse.click(on.x, on.y);
    await expect(bar).toContainText(`Path of ${index + 1}`);
  }
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 2);
  const saved = await exportedDocument(page);
  const sweep = listFeaturesInOrder(saved).find(
    (feature) => feature.data.featureKind === 'sweep'
  )!;
  if (sweep.data.featureKind !== 'sweep') throw new Error('Expected a sweep.');
  expect(sweep.data.construction).toBe('in-place');
  const derived = await rebuilt(saved);
  expect(surfaces(derived, sweep.bodyId!)).toEqual([
    'cylinder',
    'cylinder',
    'plane',
    'plane'
  ]);
  expect(derived.bodyRepresentations[sweep.bodyId!]!.volume).toBeCloseTo(
    Math.PI * 4 * 35,
    6
  );
});

test('a faceted helix rebuilds exact from its edit, its height dragged', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  const start = addSketchFeature(
    createProjectDocument('Exact coil', toUserId('user_e2e')),
    {
      name: 'Wire',
      plane: 'XZ',
      offset: 0,
      object: { objectKind: 'circle', radius: 1.5, centerX: 12, centerY: 0 }
    }
  );
  const sketch = findSketch(start.document, start.sketchId)!;
  const [profile] = computeSketchProfileAnalysis(
    sketch.objectIds.map((id) => {
      const node = start.document.nodes[id];
      if (node?.kind !== 'sketch-object')
        throw new Error('Expected an object.');
      return { id, data: node.data };
    }),
    (value) => resolveParamValue(value, {}, 'dimension')
  ).profiles;
  // Saved before exact coils existed: no construction, so faceted.
  const document = helicalSweepProfile(start.document, {
    name: 'Spring',
    profile: {
      sketchId: start.sketchId,
      profile: {
        profileId: profile!.profileId,
        regionFingerprint: profile!.regionFingerprint,
        samplePoint: profile!.samplePoint,
        sourceArea: profile!.area,
        sourceEntityIds: profile!.sourceEntityIds
      }
    },
    axisOrigin: { x: 0, y: 0, z: 0 },
    axisDirection: { x: 0, y: 0, z: 1 },
    radius: 12,
    pitch: 5,
    turns: 2
  }).document;
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row', { hasText: 'Spring' })
    .locator('.feature-row-main')
    .click();
  const bar = page.getByRole('group', { name: 'Edit Spring command' });
  await expect(bar).toBeVisible();
  // Build: Exact, behind Options while the helix is still faceted.
  await bar.locator('summary').click();
  await bar.getByRole('radio', { name: 'Exact' }).click();
  await bar.locator('summary').click();
  // The height arrow, dragged up from 10 along the axis.
  await expect
    .poll(async () => (await commandHandles(canvas)).height !== undefined)
    .toBe(true);
  const grip = (await commandHandles(canvas)).height!;
  const [from, to] = await Promise.all([
    projected(canvas, [0, 0, 10]),
    projected(canvas, [0, 0, 14])
  ]);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + to.x - from.x, grip.y + to.y - from.y, {
    steps: 12
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await commandHandles(canvas)).height?.value ?? 0)
    .toBeGreaterThan(11);
  const height = (await commandHandles(canvas)).height!.value;
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0);
  const saved = await exportedDocument(page);
  const helix = listFeaturesInOrder(saved).find(
    (feature) => feature.data.featureKind === 'helical-sweep'
  )!;
  if (helix.data.featureKind !== 'helical-sweep')
    throw new Error('Expected a helix.');
  expect(helix.data.construction).toBe('in-place');
  const derived = await rebuilt(saved);
  // Wound exact: two caps and one round side, not hundreds of facets.
  expect(surfaces(derived, helix.bodyId!).length).toBeLessThan(6);
  const turns = Number(helix.data.turns);
  expect(Number(helix.data.pitch) * turns).toBeCloseTo(height, 6);
  // Pappus: π r² · 2π R · turns.
  expect(derived.bodyRepresentations[helix.bodyId!]!.volume).toBeCloseTo(
    Math.PI * 2.25 * 2 * Math.PI * 12 * turns,
    3
  );
});

test('a picked straight sweep takes a typed twist and end scale, exactly (M04, v132)', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  let document = addPrimitiveFeature(
    createProjectDocument('Twisted sweep', toUserId('user_e2e')),
    {
      name: 'Marker',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 2, depth: 2 }
    }
  );
  document = addSketchFeature(document, {
    name: 'Profile',
    plane: 'XY',
    offset: 0,
    object: {
      objectKind: 'rectangle',
      width: 4,
      height: 4,
      centerX: 30,
      centerY: 0
    }
  }).document;
  document = addSketchFeature(document, {
    name: 'Path',
    plane: 'XZ',
    offset: 0,
    object: { objectKind: 'line', x1: 30, y1: 0, x2: 30, y2: 20 }
  }).document;
  const { canvas, bar } = await startTool(page, document, /^Sweep\b/);
  await expect
    .poll(async () => {
      await pickProfile(canvas, 0);
      return bar.textContent();
    })
    .toContain('Pick the path');
  await page.getByRole('button', { name: 'Fit view (F)', exact: true }).click();
  await waitForStillViewport(page);
  const on = await projected(canvas, [30, 0, -10]);
  await page.mouse.move(on.x, on.y);
  await page.mouse.click(on.x, on.y);
  await expect(bar).toContainText('Path of 1');

  // Each chip opens the keypad; the values are typed exactly.
  const keypad = page.locator('.numeric-keypad');
  for (const [valueId, typed] of [
    ['twist', '90'],
    ['endScale', '0.5']
  ] as const) {
    const chip = page.getByTestId(`command-handle-${valueId}`);
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(keypad).toBeVisible();
    await keypad.locator('input').fill(typed);
    await keypad.locator('input').press('Enter');
    await expect(keypad).toHaveCount(0);
  }
  await expect(page.getByTestId('command-handle-twist')).toHaveText(/90/);
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 2);

  const saved = await exportedDocument(page);
  const sweep = listFeaturesInOrder(saved).find(
    (feature) => feature.data.featureKind === 'sweep'
  )!;
  if (sweep.data.featureKind !== 'sweep') throw new Error('Expected a sweep.');
  expect(sweep.data).toMatchObject({
    construction: 'in-place',
    twistDeg: 90,
    endScale: 0.5
  });
  const derived = await rebuilt(saved);
  // Two flat caps and four twisted walls; Cavalieri: A·L·(1 + σ + σ²)/3.
  expect(
    surfaces(derived, sweep.bodyId!).filter((type) => type === 'plane')
  ).toHaveLength(2);
  expect(derived.bodyRepresentations[sweep.bodyId!]!.volume).toBeCloseTo(
    (16 * 20 * (1 + 0.5 + 0.25)) / 3,
    4
  );
});
