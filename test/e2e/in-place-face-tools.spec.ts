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
  revealModelPanel,
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
  await expect(
    page.getByRole('group', { name: `${title} command` })
  ).toBeVisible();
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

test('Hole in place: a counterbore follows the bore until its chips size it', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openBox(page, 'In-place counterbore');
  await startTool(page, /^Hole/, 'Hole');
  await expect.poll(() => pickPlanarFace(page, TOP)).not.toBeNull();
  const bar = page.getByRole('group', { name: 'Hole command' });
  await bar.locator('summary').click();
  await bar.getByRole('radio', { name: 'Counterbore' }).click();
  await bar.locator('summary').click();
  // The step's chips appear with sizes derived from the 6 mm bore.
  await expect(
    page.getByTestId('command-handle-counterboreDiameter')
  ).toHaveText('Counterbore ⌀ 10.8 mm');
  await expect(page.getByTestId('command-handle-counterboreDepth')).toHaveText(
    'Counterbore depth 3 mm'
  );
  await enterCommandValue(page, 'diameter', '4');
  // An unset step still follows the bore; a typed one is kept.
  await expect(
    page.getByTestId('command-handle-counterboreDiameter')
  ).toHaveText('Counterbore ⌀ 7.2 mm');
  await enterCommandValue(page, 'counterboreDepth', '2.5');
  await enterCommandValue(page, 'counterboreDiameter', '9');
  await finishInPlaceCommand(page, 'Hole');
  const [hole] = await featureData(page, 'hole');
  expect(hole).toMatchObject({
    style: 'counterbore',
    diameter: 4,
    counterboreDiameter: 9,
    counterboreDepth: 2.5
  });
});

test('Hole in place: a countersink takes its angle from a chip', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openBox(page, 'In-place countersink');
  await startTool(page, /^Hole/, 'Hole');
  await expect.poll(() => pickPlanarFace(page, TOP)).not.toBeNull();
  const bar = page.getByRole('group', { name: 'Hole command' });
  await bar.locator('summary').click();
  await bar.getByRole('radio', { name: 'Countersink' }).click();
  await bar.locator('summary').click();
  await expect(
    page.getByTestId('command-handle-countersinkAngleDeg')
  ).toHaveText('90°');
  await enterCommandValue(page, 'countersinkAngleDeg', '82');
  await enterCommandValue(page, 'countersinkDiameter', '11');
  await finishInPlaceCommand(page, 'Hole');
  const [hole] = await featureData(page, 'hole');
  expect(hole).toMatchObject({
    style: 'countersink',
    diameter: 6,
    countersinkDiameter: 11,
    countersinkAngleDeg: 82
  });
});

test('Enter on a focused command-bar control acts for that control, not Done', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openBox(page, 'Bar keyboard');
  await startTool(page, /^Shell/, 'Shell');
  const bar = page.getByRole('group', { name: 'Shell command' });
  await expect.poll(() => pickPlanarFace(page, TOP)).not.toBeNull();
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  // Cancel, reached by keyboard: Enter cancels rather than finishing.
  await bar.getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await expect(bar).toHaveCount(0);
  expect(await featureData(page, 'shell')).toHaveLength(0);
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

test('a face card keeps its four verbs and folds the rest behind More', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openBox(page, 'Face card verbs');
  await expect.poll(() => pickPlanarFace(page, TOP)).not.toBeNull();
  const card = page.locator('.selection-card');
  for (const verb of ['Resize', 'Offset', 'Sketch', 'Hole']) {
    await expect(
      card.getByRole('button', { name: `Selection: ${verb}` })
    ).toBeVisible();
  }
  await expect(card.getByRole('button', { name: 'Selection: Shell' })).toHaveCount(0);
  await card.getByRole('button', { name: 'More selection verbs' }).click();
  for (const verb of ['Draft', 'Thicken', 'Plane']) {
    await expect(
      card.getByRole('button', { name: `Selection: ${verb}` })
    ).toBeEnabled();
  }
  // The picked face is the shell's first opening.
  await card.getByRole('button', { name: 'Selection: Shell' }).click();
  const bar = page.getByRole('group', { name: 'Shell command' });
  await expect(bar).toContainText('1 open');
  await finishInPlaceCommand(page, 'Shell');
  const [shell] = await featureData(page, 'shell');
  expect(
    (shell as { openingFaceHashes: number[] }).openingFaceHashes
  ).toHaveLength(1);
});

test("a body card's Solid offset takes that body", async ({ page }) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openBox(page, 'Body card offset');
  await revealModelPanel(page, 'Objects');
  await page
    .getByRole('list', { name: 'Objects' })
    .getByRole('button', { name: /^Block/ })
    .click();
  const card = page.locator('.selection-card');
  await card.getByRole('button', { name: 'More selection verbs' }).click();
  await card.getByRole('button', { name: 'Selection: Solid offset' }).click();
  const bar = page.getByRole('group', { name: 'Solid offset command' });
  // The body is in hand: no face to click first.
  await expect(bar).toContainText('Drag the offset');
  await enterCommandValue(page, 'distance', '2');
  await finishInPlaceCommand(page, 'Solid offset');
  const [offset] = await featureData(page, 'solid-offset');
  expect(offset).toMatchObject({ distance: 2 });
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

/** Where `point` is drawn, in page pixels. */
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

/** A command handle's ball on screen, and the value it stands at. */
async function commandHandle(
  canvas: Locator,
  valueId: string
): Promise<{ x: number; y: number; value: number } | null> {
  return canvas.evaluate(
    (element, id) =>
      element.dataset.e2eCommandHandles
        ? ((
            JSON.parse(element.dataset.e2eCommandHandles) as Record<
              string,
              { x: number; y: number; value: number }
            >
          )[id] ?? null)
        : null,
    valueId
  );
}

test('Draft in place: the angle turns the face on its hinge at the base', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  const canvas = await openBox(page, 'Draft hinge');
  await startTool(page, /^Draft/, 'Draft');
  // The Block runs 0–40 × 0–30 × 0–20: its front wall stands on y = 0 and
  // its hinge, at the default base, is the wall's bottom edge.
  await expect.poll(() => pickPlanarFace(page, FRONT)).not.toBeNull();
  const bar = page.getByRole('group', { name: 'Draft command' });
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  const chip = page.getByTestId('command-handle-angle');
  await expect(chip).toHaveText('3°');
  await expect.poll(() => commandHandle(canvas, 'angle')).not.toBeNull();

  // The arm runs up the wall from the hinge to its middle, 10 mm: drag its
  // ball out of the body, to 20° off the wall. Out is a positive draft.
  const handle = (await commandHandle(canvas, 'angle'))!;
  const lean = (20 * Math.PI) / 180;
  const out = await projected(canvas, [
    20,
    -10 * Math.sin(lean),
    10 * Math.cos(lean)
  ]);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(out.x, out.y, { steps: 16 });
  await page.mouse.up();
  await expect
    .poll(async () => (await commandHandle(canvas, 'angle'))?.value ?? 0)
    .toBeGreaterThan(10);
  expect((await commandHandle(canvas, 'angle'))!.value).toBeLessThan(30);
  await expect(chip).not.toHaveText('3°');

  // The chip still takes an exact angle from the keypad.
  await enterCommandValue(page, 'angle', '7');
  await expect(chip).toHaveText('7°');
  await finishInPlaceCommand(page, 'Draft');
  const [draft] = await featureData(page, 'draft');
  expect(draft).toMatchObject({
    angleDeg: 7,
    pullDirection: { x: 0, y: 0, z: 1 },
    neutralPoint: { z: 0 }
  });
});
