import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  enterCommandValue,
  expectBodyCount,
  finishInPlaceCommand,
  setInPlaceOptionValues,
  setSelectionFilter,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U09 phase 6: the primitives run in place. A press-drag on the ground or a
 * flat face draws the footprint, the height is an arrow with a chip, and no
 * card opens. Each spec ends by reading what the export stored.
 */

async function openProject(page: Page, seeded: ProjectDocument | null) {
  const document =
    seeded ?? createProjectDocument('Drawn primitive', toUserId('user_e2e'));
  // The stub first: the routes below answer the project itself on top of it.
  await stubApi(page, { panelLayout: MODEL_ONLY });
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
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  if (seeded) {
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
      timeout: 30_000
    });
  }
}

function seededBox(name: string): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_e2e')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 20 }
    }
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

/** Where world points are drawn on the page, through the live camera. */
async function screenPoints(
  page: Page,
  points: [number, number, number][]
): Promise<{ x: number; y: number }[]> {
  return page.locator('.viewer-host canvas').evaluate(
    (element, at) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: at,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    points
  );
}

/** A press at one world point, dragged to another, released. */
async function dragFootprint(
  page: Page,
  from: [number, number, number],
  to: [number, number, number]
) {
  await waitForStillViewport(page);
  const [start, end] = await screenPoints(page, [from, to]);
  await page.mouse.move(start!.x, start!.y);
  await page.mouse.down();
  await page.mouse.move(end!.x, end!.y, { steps: 12 });
  await page.mouse.up();
}

/** The feature after the primitive: its placement Move, if it has one. */
function placementOf(document: ProjectDocument, name: string) {
  const features = listFeaturesInOrder(document);
  const index = features.findIndex((feature) => feature.name === name);
  const primitive = features[index]!;
  const next = features[index + 1];
  return {
    primitive: primitive.data,
    move:
      next?.data.featureKind === 'transform' ? next.data.transform : undefined
  };
}

const round = (value: unknown) => Math.round(Number(value) * 10) / 10;

test('a box is drawn corner to corner on the ground, then given its height', { tag: '@ci-smoke' }, async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, null);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const bar = page.getByRole('group', { name: 'Box command' });
  await expect(bar).toContainText('Drag a footprint on the ground or a face');
  await expect(page.locator('form.feature-form')).toHaveCount(0);

  await dragFootprint(page, [5, 5, 0], [25, 15, 0]);
  await expect(bar).toContainText('Drag the arrows');
  await expect(page.getByTestId('command-handle-width')).toContainText(
    /Width 20(\.0)? mm/
  );
  await expect(page.getByTestId('command-handle-depth')).toContainText(
    /Depth 10(\.0)? mm/
  );
  await enterCommandValue(page, 'height', '7');
  await finishInPlaceCommand(page, 'Box');

  const { primitive, move } = placementOf(await exportedDocument(page), 'Box');
  expect(primitive).toMatchObject({ featureKind: 'primitive' });
  const dimensions =
    primitive.featureKind === 'primitive' ? primitive.dimensions : {};
  expect([dimensions.width, dimensions.height, dimensions.depth].map(round)).toEqual(
    [20, 10, 7]
  );
  expect(
    [move?.translation.x, move?.translation.y, move?.translation.z].map(round)
  ).toEqual([5, 5, 0]);
  expect(move?.rotationDeg).toEqual({ x: 0, y: 0, z: 0 });
});

test('a box drawn right to left names its real lowest corner', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, null);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await dragFootprint(page, [25, 15, 0], [5, 5, 0]);
  await expect(page.getByTestId('command-handle-width')).toContainText(
    /Width 20(\.0)? mm/
  );
  // Options show where the box starts, and a typed corner moves it there.
  const bar = page.getByRole('group', { name: 'Box command' });
  await bar.locator('summary').click();
  await expect(
    bar.getByRole('button', { name: 'Corner X', exact: true })
  ).toHaveText(/^5(\.0)? mm$/);
  await bar.locator('summary').click();
  await setInPlaceOptionValues(page, 'Box', { 'Corner X': '2' });
  await finishInPlaceCommand(page, 'Box');

  const { move } = placementOf(await exportedDocument(page), 'Box');
  expect(
    [move?.translation.x, move?.translation.y, move?.translation.z].map(round)
  ).toEqual([2, 5, 0]);
});

test('a cylinder drawn on a top face stands on it, whatever the filter', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, seededBox('Cylinder on a face'));
  // A Body filter turns face picks into bodies; the footprint still finds
  // the face it is drawn on (Codex review on #889).
  await setSelectionFilter(page, 'Body');
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await expect(page.getByRole('group', { name: 'Cylinder command' })).toBeVisible();
  await dragFootprint(page, [20, 15, 20], [26, 15, 20]);
  await expect(page.getByTestId('command-handle-radius')).toContainText(
    /Radius 6(\.0)? mm/
  );
  await finishInPlaceCommand(page, 'Cylinder');

  const { primitive, move } = placementOf(
    await exportedDocument(page),
    'Cylinder'
  );
  expect(primitive).toMatchObject({
    featureKind: 'primitive',
    primitiveKind: 'cylinder'
  });
  const dimensions =
    primitive.featureKind === 'primitive' ? primitive.dimensions : {};
  expect(round(dimensions.radius)).toBe(6);
  expect(dimensions.height).toBe(28);
  expect(
    [move?.translation.x, move?.translation.y, move?.translation.z].map(round)
  ).toEqual([20, 15, 20]);
  expect(move?.rotationDeg).toEqual({ x: 0, y: 0, z: 0 });
});

test('a cone drawn on a side face turns to stand out of it', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, seededBox('Cone on a side'));
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: /^Cone/ }).click();
  await expect(page.getByRole('group', { name: 'Cone command' })).toBeVisible();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  // The front face (normal −Y) of the 40 × 30 × 20 block.
  await dragFootprint(page, [20, 0, 10], [25, 0, 10]);
  await expect(page.getByTestId('command-handle-bottomRadius')).toContainText(
    /Bottom radius 5(\.0)? mm/
  );
  await finishInPlaceCommand(page, 'Cone');

  const { primitive, move } = placementOf(await exportedDocument(page), 'Cone');
  expect(primitive).toMatchObject({
    featureKind: 'primitive',
    primitiveKind: 'cone'
  });
  expect(
    [move?.translation.x, move?.translation.y, move?.translation.z].map(round)
  ).toEqual([20, 0, 10]);
  // Its axis, the kernel's +Z, turned onto the face's −Y normal.
  expect(move?.rotationDeg).toEqual({ x: 90, y: 0, z: 0 });
});

test('Escape leaves nothing behind, and Enter alone makes the default box', { tag: '@ci-smoke' }, async ({
  page
}) => {
  await openProject(page, null);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const bar = page.getByRole('group', { name: 'Box command' });
  await dragFootprint(page, [0, 0, 0], [10, 10, 0]);
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Box canceled; nothing was added.'
  );
  await expectBodyCount(page, 0);

  await page.keyboard.press('b');
  await expect(
    bar.getByRole('button', { name: 'Done', exact: true })
  ).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 1);
  const { primitive, move } = placementOf(await exportedDocument(page), 'Box');
  expect(primitive).toMatchObject({
    primitiveKind: 'box',
    dimensions: { width: 30, height: 18, depth: 24 }
  });
  expect(move).toBeUndefined();
});
