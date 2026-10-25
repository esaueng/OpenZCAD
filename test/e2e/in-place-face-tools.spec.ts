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
  MODEL_ONLY,
  pickPlanarFace,
  enterCommandValue,
  finishInPlaceCommand,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U09 phase 3: the face tools run in place. No card opens; faces are clicks
 * on the model, numbers are handles and chips, and rare choices sit behind
 * the bar's Options menu. Each spec ends by reading what the export stored.
 */

async function openBox(page: Page, name: string): Promise<Locator> {
  const document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_e2e')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 20 }
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
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  return canvas;
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

async function startTool(page: Page, tool: RegExp, title: string) {
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: tool }).click();
  await expect(page.getByRole('group', { name: `${title} command` })).toBeVisible();
  await expect(page.locator('form.feature-form')).toHaveCount(0);
}

const TOP = { x: 0, y: 0, z: 1 };
const FRONT = { x: 0, y: -1, z: 0 };
const BOTTOM = { x: 0, y: 0, z: -1 };

async function featureData(page: Page, kind: string) {
  const saved = await exportedDocument(page);
  return listFeaturesInOrder(saved)
    .map((feature) => feature.data)
    .filter((data) => data.featureKind === kind);
}

test('Hole in place: blind depth from Options, diameter from the keypad', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openBox(page, 'In-place hole');
  await startTool(page, /^Hole/, 'Hole');
  await expect.poll(() => pickPlanarFace(page, TOP)).not.toBeNull();
  const bar = page.getByRole('group', { name: 'Hole command' });
  await expect(bar).toContainText('drag the diameter');
  // Blind depth is a rare choice: it lives behind Options, and adds a
  // depth handle when chosen.
  await bar.locator('summary').click();
  await bar.getByRole('radio', { name: 'Blind' }).click();
  await expect(page.getByTestId('command-handle-depth')).toBeVisible();
  await enterCommandValue(page, 'diameter', '4');
  await enterCommandValue(page, 'depth', '8');
  await finishInPlaceCommand(page, 'Hole');
  const [hole] = await featureData(page, 'hole');
  expect(hole).toMatchObject({ diameter: 4, depthMode: 'blind', depth: 8 });
});

test('Shell in place: two openings, wall from the keypad', async ({ page }) => {
  // Opposite faces: the kernel refuses two adjacent openings (a free loop
  // lies in neither plane), which the bar reports as a refusal.
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openBox(page, 'In-place shell');
  await startTool(page, /^Shell/, 'Shell');
  const bar = page.getByRole('group', { name: 'Shell command' });
  await expect.poll(() => pickPlanarFace(page, TOP)).not.toBeNull();
  await expect(bar).toContainText('1 open');
  await pickPlanarFace(page, BOTTOM);
  await expect(bar).toContainText('2 open');
  await enterCommandValue(page, 'thickness', '1.5');
  await finishInPlaceCommand(page, 'Shell');
  const [shell] = await featureData(page, 'shell');
  expect(shell).toMatchObject({ thickness: 1.5 });
  expect(
    (shell as { openingFaceHashes: number[] }).openingFaceHashes
  ).toHaveLength(2);
});

test('Thicken in place: one face, signed thickness from the keypad', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openBox(page, 'In-place thicken');
  await startTool(page, /^Thicken/, 'Thicken');
  await expect.poll(() => pickPlanarFace(page, TOP)).not.toBeNull();
  await enterCommandValue(page, 'thickness', '3');
  await finishInPlaceCommand(page, 'Thicken');
  const [thicken] = await featureData(page, 'thicken');
  expect(thicken).toMatchObject({ thickness: 3 });
});

test('Solid offset in place: any face names the body', async ({ page }) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openBox(page, 'In-place offset');
  await startTool(page, /^Solid offset/, 'Solid offset');
  await expect.poll(() => pickPlanarFace(page, TOP)).not.toBeNull();
  await enterCommandValue(page, 'distance', '2');
  await finishInPlaceCommand(page, 'Solid offset');
  const [offset] = await featureData(page, 'solid-offset');
  expect(offset).toMatchObject({ distance: 2 });
});

test('Draft in place: a side face, the angle from its chip', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openBox(page, 'In-place draft');
  await startTool(page, /^Draft/, 'Draft');
  await expect.poll(() => pickPlanarFace(page, FRONT)).not.toBeNull();
  await expect(page.getByTestId('command-handle-angle')).toHaveText('3°');
  await enterCommandValue(page, 'angle', '5');
  await finishInPlaceCommand(page, 'Draft');
  const [draft] = await featureData(page, 'draft');
  expect(draft).toMatchObject({ angleDeg: 5 });
});
