import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
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
 * M06 (schema v101): Rib in place. The gusset line is a click on its sketch
 * curve, the bracket a click on the body; the thickness is dragged on its
 * arrow, and Done unites the exact rib with the bracket as one body.
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

/** The bracket and a gusset line across its inside corner at z 10. */
function bracketDocument(): ProjectDocument {
  let document = createProjectDocument('Rib bracket', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Base',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 5, depth: 20 }
  });
  const base = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Wall',
    primitiveKind: 'box',
    dimensions: { width: 5, height: 40, depth: 20 }
  });
  const wall = document.bodyOrder.at(-1)!;
  document = booleanBodies(document, {
    name: 'Bracket',
    operation: 'union',
    targetBodyIds: [base, wall]
  }).document;
  return addSketchFeature(document, {
    name: 'Gusset',
    plane: 'XY',
    offset: 10,
    object: { objectKind: 'line', x1: 5, y1: 30, x2: 30, y2: 5 }
  }).document;
}

test('Rib runs in place: a profile click, the lone body taken, thickness drag, Done', async ({
  page
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openDocument(page, bracketDocument());
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
  await page.getByRole('button', { name: /^Rib\b/ }).click();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  const bar = page.locator('.in-place-command');
  await expect(bar).toContainText('Pick the rib profile curves');

  // The gusset line, clicked at its middle.
  const [line] = await projected(canvas, [[17.5, 17.5, 10]]);
  await page.mouse.move(line!.x, line!.y);
  await page.mouse.click(line!.x, line!.y);
  // The bracket is the only body, so the rib takes it without a click.
  await expect(bar).toContainText('drag the thickness');

  // The thickness arrow, dragged from 2 to about 4 along +Z.
  await expect
    .poll(async () => (await commandHandles(canvas)).thickness !== undefined)
    .toBe(true);
  const grip = (await commandHandles(canvas)).thickness!;
  const [from, to] = await projected(canvas, [
    [17.5, 17.5, 10],
    [17.5, 17.5, 12]
  ]);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + to!.x - from!.x, grip.y + to!.y - from!.y, {
    steps: 12
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await commandHandles(canvas)).thickness?.value ?? 0)
    .toBeGreaterThan(3);
  const thickness = (await commandHandles(canvas)).thickness!.value;

  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');

  const saved = await exportedDocument(page);
  const ribs = listFeaturesInOrder(saved).flatMap((feature) =>
    feature.data.featureKind === 'rib' ? [feature] : []
  );
  expect(ribs).toHaveLength(1);
  const rib = ribs[0]!;
  if (rib.data.featureKind !== 'rib') throw new Error('Expected a rib.');
  expect(rib.data.direction).toBe('parallel');
  expect(Number(rib.data.thickness)).toBeCloseTo(thickness, 6);
  // One body: the bracket and its gusset, 7 500 + 312.5 × thickness mm³.
  // The export carries no derived state; rebuild it exactly here.
  const adapter = await createExactKernelAdapter();
  const derived = await adapter.syncDocument(saved);
  expect(derived.warnings).toEqual([]);
  const body = derived.bodyRepresentations[rib.bodyId!];
  expect(body?.volume).toBeCloseTo(7500 + 312.5 * thickness, 3);
  expect(errors).toEqual([]);
});
