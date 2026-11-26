import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  finishInPlaceCommand,
  pickObjectsBody,
  pressTool,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M11 slice 5c (owner decision D4): Mirror takes several bodies about one
 * plane. The first block is picked in Objects, the second by a Shift-click on
 * it, then a plain click on the first block's end face is the plane. Done
 * adds one Mirror feature per body as one step: one Undo takes both back,
 * one Redo restores them under the same ids. The blocks are invented.
 */

async function openBlocks(
  page: Page
): Promise<{ left: BodyId; right: BodyId; name: string }> {
  let document: ProjectDocument = createProjectDocument(
    'Mirror several bodies',
    toUserId('user_e2e')
  );
  const box = (name: string) => {
    document = addPrimitiveFeature(document, {
      name,
      bodyName: name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    return document.bodyOrder.at(-1)!;
  };
  const left = box('Left block');
  const right = box('Right block');
  document = transformBody(document, {
    name: 'Place Right block',
    targetBodyId: right,
    translation: { x: 30, y: 0, z: 0 }
  }).document;
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
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  return { left, right, name: document.name };
}

/** A click on `bodyId`'s flat face with `normal`; Shift when `additive`. */
async function clickFace(
  page: Page,
  bodyId: BodyId,
  normal: { x: number; y: number; z: number },
  additive = false
): Promise<boolean> {
  return page.locator('.viewer-host canvas').evaluate(
    (element, { bodyId: id, normal: faceNormal, additive: shift }) =>
      new Promise<boolean>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: {
              bodyId: id,
              normal: faceNormal,
              select: true,
              additive: shift,
              resolve: (face: unknown) => resolve(face !== null)
            }
          })
        );
      }),
    { bodyId, normal, additive }
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

function mirrors(document: ProjectDocument) {
  return listFeaturesInOrder(document)
    .filter((feature) => feature.data.featureKind === 'mirror')
    .map((feature) => ({
      featureId: feature.featureId,
      bodyId: feature.bodyId,
      name: feature.name,
      target: (feature.data as { targetBodyId: BodyId }).targetBodyId
    }));
}

test(
  'Mirror takes two bodies about a face of one, as two features in one undo step',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page);
    const { left, right } = await openBlocks(page);

    await pressTool(page, /^Mirror — /);
    const bar = page.getByRole('group', { name: 'Mirror command' });
    await expect(bar).toBeVisible();
    await pickObjectsBody(page, 'Left block');
    await expect(bar).toContainText('Pick a plane or flat face');
    // Shift adds the clicked body rather than taking its face as the plane.
    await expect
      .poll(() => clickFace(page, right, { x: 0, y: 0, z: 1 }, true))
      .toBe(true);
    await expect(bar).toContainText('2 bodies · Pick a plane or flat face');
    // A plain click on a flat face of a picked body is the plane.
    await expect
      .poll(() => clickFace(page, left, { x: -1, y: 0, z: 0 }))
      .toBe(true);
    await expect(bar).toContainText('2 bodies · Slide the plane');
    // Both copies preview: four bodies drawn.
    await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
      'data-e2e-rendered-bodies',
      '4',
      { timeout: 30_000 }
    );
    await finishInPlaceCommand(page, 'Mirror');
    await expectBodyCount(page, 4);
    const rows = page.locator('.feature-row-main', { hasText: /^Mirror/ });
    await expect(rows).toHaveCount(2);

    const committed = mirrors(await exportedDocument(page));
    expect(committed.map(({ name, target }) => ({ name, target }))).toEqual([
      { name: 'Mirror', target: left },
      { name: 'Mirror 2', target: right }
    ]);

    // One Undo takes both back; one Redo restores both, same ids.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectBodyCount(page, 2);
    await expect(rows).toHaveCount(0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectBodyCount(page, 4);
    await expect(rows).toHaveCount(2);
    expect(mirrors(await exportedDocument(page))).toEqual(committed);
  }
);
