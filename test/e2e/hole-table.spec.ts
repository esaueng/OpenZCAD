import {
  addPrimitiveFeature,
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
  finishInPlaceCommand,
  MODEL_ONLY,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M01 hole tables on drawing sheets: a hole drilled in place at the middle
 * of a block's top face, then in Draw the Hole table tool takes the top
 * view with one click and its place on the paper with another. The table
 * lists the bore, tagged A1 in the view, at its distance from the view's
 * lower-left corner. Nothing is typed.
 */

const BLOCK = { x: 40, y: 30, z: 20 };
const ENTRY: [number, number, number] = [20, 15, BLOCK.z];

async function openBlock(page: Page): Promise<Locator> {
  const document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument('Hole table', toUserId('user_e2e')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: BLOCK.x, height: BLOCK.y, depth: BLOCK.z }
    }
  );
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
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  return canvas;
}

/** Clicks the block's top face at the middle, as the viewport's pick does. */
async function pickTop(canvas: Locator): Promise<boolean> {
  return canvas.evaluate(
    (element, point) =>
      new Promise<boolean>((resolve) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: {
              normal: { x: 0, y: 0, z: 1 },
              point: { x: point[0], y: point[1], z: point[2] },
              select: true,
              resolve: (selection: unknown) => resolve(selection !== null)
            }
          })
        )
      ),
    ENTRY
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

function mode(page: Page, name: 'Build' | 'Draw') {
  return page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name, exact: true });
}

test(
  'a Hole table lists the top view’s bore and tags it in the view',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const canvas = await openBlock(page);

    const moreTools = page.getByRole('button', { name: /^More tools/ });
    if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
      await moreTools.click();
    }
    await page.getByRole('button', { name: /^Hole/ }).click();
    const bar = page.getByRole('group', { name: 'Hole command' });
    await expect(bar).toBeVisible();
    if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
      await moreTools.click();
    }
    await expect.poll(() => pickTop(canvas), { timeout: 60_000 }).toBe(true);
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 60_000
    });
    await finishInPlaceCommand(page, 'Hole');
    await expectBodyCount(page, 1);
    await waitForStillViewport(page);

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const sheet = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(sheet.locator('.drawing-view.is-placeholder')).toHaveCount(0, {
      timeout: 30_000
    });
    const hit = sheet.locator('[data-view="top"] .drawing-view-hit');
    const box = (await hit.boundingBox())!;
    const pxPerMm = box.width / Number(await hit.getAttribute('width'));

    // One click takes the top view, the next places the table below it.
    await drawings
      .getByRole('button', { name: 'Hole table', exact: true })
      .click();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x, box.y + box.height + 15 * pxPerMm);
    const table = sheet.getByRole('button', { name: /^Hole table/ });
    await expect(table).toBeVisible();
    // The bore's row: its tag, and its place from the view's lower-left
    // corner, the block's middle.
    await expect(sheet.locator('text', { hasText: /^A1$/ })).toHaveCount(2);
    await expect(sheet.locator('text', { hasText: /^20$/ })).not.toHaveCount(0);
    await expect(sheet.locator('text', { hasText: /^15$/ })).not.toHaveCount(0);

    const saved = await exportedDocument(page);
    const annotations = saved.drawings?.sheets[0]?.annotations ?? [];
    const stored = annotations.find(
      (annotation) => annotation.kind === 'hole-table'
    );
    const top = saved.drawings?.sheets[0]?.views.find(
      (view) => view.orientation === 'top'
    );
    expect(stored).toMatchObject({ kind: 'hole-table', viewId: top?.viewId });
    expect(
      listFeaturesInOrder(saved).some(
        (feature) => feature.data.featureKind === 'hole'
      )
    ).toBe(true);
  }
);
