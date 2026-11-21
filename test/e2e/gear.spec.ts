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
  waitForStillViewport,
  clickWorldPoint,
  setSelectionFilter,
  revealModelPanel
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

/** Where a world point lands on the canvas. */
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

/** Presses a handle's grip and drags it through world points. */
async function dragHandle(
  page: Page,
  canvas: Locator,
  valueId: string,
  through: [number, number, number][]
) {
  await waitForStillViewport(page);
  const grip = (await commandHandles(canvas))[valueId]!;
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (const point of through) {
    const at = await projected(canvas, point);
    await page.mouse.move(at.x, at.y, { steps: 2 });
  }
  await page.mouse.up();
}

test(
  'Gear in place: pick a face, drag teeth on and the face width down, edit it back unchanged',
  {
    tag: '@ci-smoke'
  },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    // A box from the origin: its top face's centre, where the gear stands,
    // is (20, 15, 20).
    const canvas = await openPart(page, 'In-place gear', 'box', {
      width: 40,
      height: 30,
      depth: 20
    });
    await startTool(page, /^Gear(?! teeth)/, 'Gear');
    const bar = page.getByRole('group', { name: 'Gear command' });
    await expect(bar).toContainText('Pick a plane or flat face');
    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }))
      .not.toBeNull();
    await expect(bar).toContainText('Drag the teeth arrow to add teeth');
    const teeth = page.getByTestId('command-handle-teeth');
    await expect(teeth).toHaveText('20 teeth');
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 60_000
    });

    // The teeth arrow's head stands on the Ø40 pitch circle of 20 module-2
    // teeth, out along +X from the gear's centre.
    await waitForStillViewport(page);
    const grip = (await commandHandles(canvas)).teeth!;
    const pitch = await projected(canvas, [40, 15, 20]);
    expect(Math.hypot(grip.x - pitch.x, grip.y - pitch.y)).toBeLessThan(4);

    // Dragged out to the Ø48 circle: four more teeth at the same module.
    await dragHandle(page, canvas, 'teeth', [
      [41, 15, 20],
      [42, 15, 20],
      [43, 15, 20],
      [44, 15, 20]
    ]);
    await expect(teeth).toHaveText('24 teeth');
    // The face width's arrow down from 10 to 6.
    await dragHandle(page, canvas, 'faceWidth', [
      [20, 15, 29],
      [20, 15, 28],
      [20, 15, 27],
      [20, 15, 26]
    ]);
    await expect
      .poll(async () => (await commandHandles(canvas)).faceWidth?.value ?? 0)
      .toBeLessThan(7);
    const width = (await commandHandles(canvas)).faceWidth!.value;
    expect(width).toBeGreaterThan(5);
    // Options reads out what the drag decided.
    await bar.locator('details.in-place-command-options summary').click();
    await expect(bar).toContainText('Module 2 mm · Pitch Ø 48 mm');
    await bar.locator('details.in-place-command-options summary').click();
    await finishInPlaceCommand(page, 'Gear');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
      timeout: 30_000
    });
    const [gear, ...others] = await gearData(page);
    expect(others).toHaveLength(0);
    expect(gear).toMatchObject({
      gearType: 'external',
      sizing: 'module',
      pitch: 2,
      teeth: 24,
      axis: { x: 0, y: 0, z: 1 }
    });
    expect(Number((gear as { faceWidth: number }).faceWidth)).toBeCloseTo(
      width,
      6
    );
    expect(gear).not.toHaveProperty('targetBodyId');

    // Re-armed from History and finished untouched, it is stored as it was.
    await revealModelPanel(page, 'History');
    await page
      .locator('.feature-row', { hasText: 'Gear' })
      .locator('.feature-row-main')
      .click();
    const edit = page.getByRole('group', { name: 'Edit Gear command' });
    await expect(edit).toBeVisible();
    await expect(page.getByTestId('command-handle-teeth')).toHaveText(
      '24 teeth'
    );
    await expect(edit.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 60_000
    });
    await edit.getByRole('button', { name: /Done/ }).click();
    await expect(edit).toHaveCount(0, { timeout: 60_000 });
    expect(await gearData(page)).toEqual([gear]);
  }
);

test('Gear teeth in place: one pick sizes the teeth, the arrow stops them short', async ({
  page
}) => {
  test.setTimeout(300_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  const canvas = await openPart(page, 'In-place gear teeth', 'cylinder', {
    radius: 11,
    height: 6
  });
  await startTool(page, /^Gear teeth/, 'Gear teeth');
  const bar = page.getByRole('group', { name: 'Gear teeth command' });
  await expect(bar).toContainText('Pick a boss or bore');
  // The boss's side, near its top: the teeth run down from there.
  await setSelectionFilter(page, 'Face');
  await clickWorldPoint(page, [0, -11, 5]);
  await expect(bar).toContainText('Tap the teeth to type');
  await expect(page.getByTestId('command-handle-faceWidth')).toHaveText(
    'Length 6 mm'
  );
  // Options reads out what the face decides: its diameter and its length.
  const options = bar.locator('details.in-place-command-options summary');
  await options.click();
  await expect(bar).toContainText(
    'Sized from the Ø22 mm face · Teeth run the full 6 mm'
  );
  await options.click();
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 120_000
  });
  // The arrow, at the bottom, dragged up to 2 above it: 4 of the 6 toothed.
  await dragHandle(page, canvas, 'faceWidth', [
    [0, -11, 0.5],
    [0, -11, 1],
    [0, -11, 1.5],
    [0, -11, 2]
  ]);
  await expect
    .poll(async () => (await commandHandles(canvas)).faceWidth?.value ?? 6)
    .toBeLessThan(4.5);
  const dragged = (await commandHandles(canvas)).faceWidth!.value;
  expect(dragged).toBeGreaterThan(3.5);
  await options.click();
  await expect(bar).toContainText(/Teeth run [\d.]+ of 6 mm/);
  await options.click();
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 120_000
  });
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0, { timeout: 120_000 });
  await setSelectionFilter(page, 'Any');
  const [teeth] = await gearData(page);
  expect(teeth).toMatchObject({
    gearType: 'external',
    teeth: 20,
    anchor: 'end'
  });
  expect(Number((teeth as { faceWidth: number }).faceWidth)).toBeCloseTo(
    dragged,
    6
  );
  expect(teeth).toHaveProperty('targetBodyId');
  // Keep-diameter is the default: no module stored, none needed.
  expect(teeth).not.toHaveProperty('pitch');
  expect(teeth).not.toHaveProperty('fit');
});

test('Gear teeth over part of a cylinder: from the end picked nearer, edited back unchanged', async ({
  page
}) => {
  test.setTimeout(300_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openPart(page, 'Partial gear teeth', 'cylinder', {
    radius: 11,
    height: 12
  });
  await startTool(page, /^Gear teeth/, 'Gear teeth');
  const bar = page.getByRole('group', { name: 'Gear teeth command' });
  await expect(bar).toContainText('Pick a boss or bore');
  // The boss's side, near its top: the teeth run down from there.
  await setSelectionFilter(page, 'Face');
  await clickWorldPoint(page, [0, -11, 10]);
  const length = page.getByTestId('command-handle-faceWidth');
  await expect(length).toHaveText('Length 12 mm');
  await enterCommandValue(page, 'faceWidth', '6');
  await bar.locator('summary').click();
  const offset = bar.getByRole('textbox', { name: 'Offset', exact: true });
  await offset.fill('2');
  await offset.press('Enter');
  await bar.locator('summary').click();
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 120_000
  });
  // Cutting and checking a 12-long toothed band outlasts the helper's wait.
  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0, { timeout: 120_000 });
  await setSelectionFilter(page, 'Any');
  const [created, ...others] = await gearData(page);
  expect(others).toHaveLength(0);
  expect(created).toMatchObject({
    gearType: 'external',
    teeth: 20,
    faceWidth: 6,
    offset: 2,
    anchor: 'end'
  });

  // Re-armed from History and finished untouched, it is stored as it was.
  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row', { hasText: 'Gear' })
    .locator('.feature-row-main')
    .click();
  const edit = page.getByRole('group', { name: 'Edit Gear teeth command' });
  await expect(edit).toBeVisible();
  await expect(page.getByTestId('command-handle-faceWidth')).toBeVisible();
  await expect(edit.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 120_000
  });
  await edit.getByRole('button', { name: /Done/ }).click();
  await expect(edit).toHaveCount(0, { timeout: 120_000 });
  expect(await gearData(page)).toEqual([created]);
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
  await panel.getByRole('button', { name: 'More' }).click();
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
    .getByRole('radio', { name: 'Diametral' })
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
