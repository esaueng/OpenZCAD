import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M12 (schema v111): Wrap in place. A label region is clicked, then the
 * post's cylindrical face; the depth is dragged out of the face, and Done
 * embosses the wrapped label onto the post as one body.
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

async function projected(
  canvas: Locator,
  points: [number, number, number][]
): Promise<{ x: number; y: number }[]> {
  return canvas.evaluate(
    (element, list) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: list,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    points
  );
}

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

/** A radius-10 post and a 6 × 4 label sketched on its tangent plane. */
function postDocument(): ProjectDocument {
  let document = createProjectDocument('Wrap post', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Post',
    primitiveKind: 'cylinder',
    dimensions: { radius: 10, height: 20 }
  });
  return addSketchFeature(document, {
    name: 'Label',
    plane: 'YZ',
    offset: 10,
    object: {
      objectKind: 'rectangle',
      width: 6,
      height: 4,
      centerX: 0,
      centerY: 10
    }
  }).document;
}

test('Wrap runs in place: region and face clicks, depth drag, Done', async ({
  page
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openDocument(page, postDocument());
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
  await page.getByRole('button', { name: /^Wrap\b/ }).click();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  const bar = page.locator('.in-place-command');
  await expect(bar).toContainText('Click the sketch regions to wrap');

  // The label's region.
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-profile', {
            detail: { index: 0, additive: false }
          })
        )
      );
      return bar.textContent();
    })
    .toContain('click the cylinder');

  // Seen from the front, the side's normal runs across the screen rather
  // than at the camera, so the depth, turn and slide grips stand apart.
  await page.getByRole('button', { name: 'Front view', exact: true }).click();
  await waitForStillViewport(page);
  // The post's side, below and beside the label.
  const angle = -0.6;
  const [side] = await projected(canvas, [
    [10 * Math.cos(angle), 10 * Math.sin(angle), 4]
  ]);
  await page.mouse.move(side!.x, side!.y);
  await page.mouse.click(side!.x, side!.y);
  await expect(bar).toContainText('Drag the depth');

  // The depth arrow, dragged outward from 1 to about 2.
  await expect
    .poll(async () => (await commandHandles(canvas)).depth !== undefined)
    .toBe(true);
  const grip = (await commandHandles(canvas)).depth!;
  const radial = { x: Math.cos(angle), y: Math.sin(angle) };
  const [from, to] = await projected(canvas, [
    [10 * radial.x, 10 * radial.y, 4],
    [11.2 * radial.x, 11.2 * radial.y, 4]
  ]);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + to!.x - from!.x, grip.y + to!.y - from!.y, {
    steps: 12
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await commandHandles(canvas)).depth?.value ?? 0)
    .toBeGreaterThan(1.5);
  const depth = (await commandHandles(canvas)).depth!.value;

  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');

  const saved = await exportedDocument(page);
  const wraps = listFeaturesInOrder(saved).flatMap((feature) =>
    feature.data.featureKind === 'wrap' ? [feature] : []
  );
  expect(wraps).toHaveLength(1);
  const wrap = wraps[0]!;
  if (wrap.data.featureKind !== 'wrap') throw new Error('Expected a wrap.');
  expect(wrap.data.mode).toBe('emboss');
  expect(Number(wrap.data.depth)).toBeCloseTo(depth, 6);
  // The export carries no derived state; rebuild it exactly here.
  const derived = await (await createExactKernelAdapter()).syncDocument(saved);
  expect(derived.warnings).toEqual([]);
  const body = derived.bodyRepresentations[wrap.bodyId!];
  // One body: the post and its label, 24 · ((10 + d)² − 10²) / 20 more.
  expect(body?.volume).toBeCloseTo(
    Math.PI * 100 * 20 + (24 * ((10 + depth) ** 2 - 100)) / 20,
    3
  );
  expect(errors).toEqual([]);
});

/** A frustum (apex at z = 40) and the same label on the plane x = 7.5. */
function cupDocument(): ProjectDocument {
  let document = createProjectDocument('Wrap cup', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Cup',
    primitiveKind: 'cone',
    dimensions: { bottomRadius: 10, topRadius: 5, height: 20 }
  });
  return addSketchFeature(document, {
    name: 'Label',
    plane: 'YZ',
    offset: 7.5,
    object: {
      objectKind: 'rectangle',
      width: 6,
      height: 4,
      centerX: 0,
      centerY: 10
    }
  }).document;
}

test('Wrap embosses onto a cone in place: region and face clicks, depth drag, one body', async ({
  page
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page, { panelLayout: MODEL_ONLY });
  const start = cupDocument();
  await openDocument(page, start);
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
  await page.getByRole('button', { name: /^Wrap\b/ }).click();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  const bar = page.locator('.in-place-command');
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-profile', {
            detail: { index: 0, additive: false }
          })
        )
      );
      return bar.textContent();
    })
    .toContain('click the cylinder or cone');

  // Seen from the front, the side's normal runs across the screen.
  await page.getByRole('button', { name: 'Front view', exact: true }).click();
  await waitForStillViewport(page);
  // The cup's side at height 4 (radius 9 there), below and beside the label.
  const angle = -0.6;
  const radial = { x: Math.cos(angle), y: Math.sin(angle) };
  const at: [number, number, number] = [9 * radial.x, 9 * radial.y, 4];
  const [side] = await projected(canvas, [at]);
  await page.mouse.move(side!.x, side!.y);
  await page.mouse.click(side!.x, side!.y);
  await expect(bar).toContainText('Drag the depth');

  // The depth arrow, dragged out along the cone's normal (radial and up).
  await expect
    .poll(async () => (await commandHandles(canvas)).depth !== undefined)
    .toBe(true);
  const grip = (await commandHandles(canvas)).depth!;
  const beta = Math.atan2(40, 10);
  const normal = [
    Math.sin(beta) * radial.x,
    Math.sin(beta) * radial.y,
    Math.cos(beta)
  ];
  const [from, to] = await projected(canvas, [
    at,
    [at[0] + 1.2 * normal[0]!, at[1] + 1.2 * normal[1]!, at[2] + 1.2 * normal[2]!]
  ]);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + to!.x - from!.x, grip.y + to!.y - from!.y, {
    steps: 12
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await commandHandles(canvas)).depth?.value ?? 0)
    .toBeGreaterThan(1.5);
  const depth = (await commandHandles(canvas)).depth!.value;

  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');

  const saved = await exportedDocument(page);
  const wrap = listFeaturesInOrder(saved).find(
    (feature) => feature.data.featureKind === 'wrap'
  );
  if (wrap?.data.featureKind !== 'wrap') throw new Error('Expected a wrap.');
  expect(Number(wrap.data.depth)).toBeCloseTo(depth, 6);
  const adapter = await createExactKernelAdapter();
  const before = await adapter.syncDocument(start);
  const derived = await adapter.syncDocument(saved);
  expect(derived.warnings).toEqual([]);
  const body = derived.bodyRepresentations[wrap.bodyId!]!;
  const cones = body.topology!.faces.filter(
    (face) => face.geometry?.surfaceType === 'cone'
  );
  expect(cones.length).toBeGreaterThanOrEqual(2);
  // One body, grown by the label: about 24 · depth, a little more for the
  // cone's widening outward.
  const cup = before.bodyRepresentations[start.bodyOrder[0]!]!.volume;
  const added = body.volume - cup;
  expect(added).toBeGreaterThan(24 * depth);
  expect(added).toBeLessThan(24 * depth * 1.2);
  expect(errors).toEqual([]);
});
