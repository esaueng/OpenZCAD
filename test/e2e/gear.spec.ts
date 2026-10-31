import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  type PrimitiveInput
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
 * M14: a gear is an in-place command. Gear stands a new gear on a plane;
 * Gear teeth cuts them along a picked cylinder. Each spec reads what the
 * export stored.
 */

async function openPart(
  page: Page,
  name: string,
  primitiveKind: PrimitiveInput['primitiveKind'],
  dimensions: PrimitiveInput['dimensions']
): Promise<Locator> {
  const document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_e2e')),
    { name: 'Blank', primitiveKind, dimensions }
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

async function startTool(page: Page, tool: RegExp, title: string) {
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: tool }).click();
  await expect(
    page.getByRole('group', { name: `${title} command` })
  ).toBeVisible();
}

async function gearData(page: Page) {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download', { timeout: 15_000 });
  await menu.getByRole('button', { name: /Export project/ }).click();
  const download = await pending;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const saved = (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
  return listFeaturesInOrder(saved)
    .map((feature) => feature.data)
    .filter((data) => data.featureKind === 'gear');
}

test(
  'Gear in place: a spur gear stands on a picked face',
  {
    tag: '@ci-smoke'
  },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const canvas = await openPart(page, 'In-place gear', 'box', {
      width: 40,
      height: 30,
      depth: 20
    });
    await startTool(page, /^Gear(?! teeth)/, 'Gear');
    const bar = page.getByRole('group', { name: 'Gear command' });
    await expect(bar).toContainText('Pick where the gear stands');
    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }))
      .not.toBeNull();
    await expect(bar).toContainText('Drag the face width');
    await enterCommandValue(page, 'teeth', '24');
    await enterCommandValue(page, 'faceWidth', '6');
    await finishInPlaceCommand(page, 'Gear');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
      timeout: 30_000
    });
    const [gear] = await gearData(page);
    expect(gear).toMatchObject({
      gearType: 'external',
      sizing: 'module',
      pitch: 2,
      teeth: 24,
      faceWidth: 6,
      axis: { x: 0, y: 0, z: 1 }
    });
    expect(gear).not.toHaveProperty('targetBodyId');
  }
);

test('Gear teeth in place: teeth cut along a picked cylinder keep its diameter', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  const canvas = await openPart(page, 'In-place gear teeth', 'cylinder', {
    radius: 11,
    height: 6
  });
  await startTool(page, /^Gear teeth/, 'Gear teeth');
  const bar = page.getByRole('group', { name: 'Gear teeth command' });
  await expect(bar).toContainText('Pick a cylindrical face');
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          new Promise<unknown>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-cylinder', {
                detail: { surface: 'wall', select: true, resolve }
              })
            );
          })
      )
    )
    .not.toBeNull();
  await expect(bar).toContainText('the teeth run the whole face');
  await enterCommandValue(page, 'teeth', '20');
  await finishInPlaceCommand(page, 'Gear teeth');
  const [teeth] = await gearData(page);
  expect(teeth).toMatchObject({ gearType: 'external', teeth: 20 });
  expect(teeth).toHaveProperty('targetBodyId');
  // Keep-diameter is the default: no module stored, none needed.
  expect(teeth).not.toHaveProperty('pitch');
  expect(teeth).not.toHaveProperty('fit');
});

test('Gear parameters: typed in place, in their own units, only where they apply', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openPart(page, 'Gear parameters', 'box', {
    width: 40,
    height: 30,
    depth: 20
  });
  await startTool(page, /^Gear(?! teeth)/, 'Gear');
  const bar = page.getByRole('group', { name: 'Gear command' });
  await expect
    .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }))
    .not.toBeNull();
  await bar.locator('details.in-place-command-options summary').click();
  const panel = bar.locator('.in-place-command-options-panel');
  // An angle reads in degrees and a shift in modules, never in mm.
  await panel.getByText('Tooth form').click();
  const pressure = panel.getByRole('textbox', { name: 'Pressure angle' });
  await expect(pressure).toHaveValue('20');
  await expect(pressure.locator('..')).toContainText('°');
  await expect(
    panel.getByRole('textbox', { name: 'Profile shift' }).locator('..')
  ).toContainText('× m');
  // A spur gear has no hand until its teeth twist.
  await expect(panel.getByRole('radiogroup', { name: 'Hand' })).toHaveCount(0);
  const helix = panel.getByRole('textbox', { name: 'Helix angle' });
  await helix.fill('15');
  await helix.press('Enter');
  await expect(panel.getByRole('radiogroup', { name: 'Hand' })).toBeVisible();
  // Another sizing keeps the tooth: module 2 is 12.7 teeth per inch.
  await panel
    .getByRole('radiogroup', { name: 'Size by' })
    .getByRole('radio', { name: 'Diametral pitch' })
    .click();
  const diametral = panel.getByRole('textbox', { name: 'Diametral pitch' });
  await expect(diametral).toHaveValue('12.7');
  await expect(panel.getByRole('textbox', { name: 'Module' })).toHaveCount(0);
  const teeth = panel.getByRole('textbox', { name: 'Teeth' });
  await teeth.fill('24');
  await teeth.press('Enter');
  await expect(page.getByTestId('command-handle-teeth')).toContainText('24');
  await bar.locator('details.in-place-command-options summary').click();
  await finishInPlaceCommand(page, 'Gear');
  const [gear] = await gearData(page);
  expect(gear).toMatchObject({
    gearType: 'external',
    sizing: 'diametral-pitch',
    teeth: 24,
    helixAngleDeg: 15
  });
  expect((gear as { pitch: number }).pitch).toBeCloseTo(12.7);
});
