import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type FeatureData,
  type ProjectDocument
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  enterCommandValue,
  expectBodyCount,
  finishInPlaceCommand,
  MODEL_ONLY,
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M01 close-out, the U01 contract for Hole handles: what the handles, chips,
 * keypad and Options show is what Done commits; Escape leaves the stored
 * hole exactly as it was; Undo and Redo step between the committed holes.
 *
 * The block's top face is anchored at its outer centroid (20, 15). On a top
 * face U runs along −Y and V along +X, and the default 1 mm snap rounds a
 * click at (23.4, 16.6) to U −2, V 3: the bore is drilled at (23, 17).
 */

const BLOCK = { x: 40, y: 30, z: 20 };
const CLICK: [number, number, number] = [23.4, 16.6, BLOCK.z];
const BORE: [number, number, number] = [23, 17, BLOCK.z];

async function openBlock(
  page: Page,
  shown?: ProjectDocument['displayUnits']
): Promise<Locator> {
  const block: ProjectDocument = addPrimitiveFeature(
    createProjectDocument('Hole contract', toUserId('user_e2e')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: BLOCK.x, height: BLOCK.y, depth: BLOCK.z }
    }
  );
  const document: ProjectDocument = shown
    ? { ...block, displayUnits: shown }
    : block;
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

/** Clicks the block's top face at `point`, as the viewport's pick does. */
async function pickTop(
  canvas: Locator,
  point: [number, number, number]
): Promise<boolean> {
  return canvas.evaluate(
    (element, at) =>
      new Promise<boolean>((resolve) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: {
              normal: { x: 0, y: 0, z: 1 },
              point: { x: at[0], y: at[1], z: at[2] },
              select: true,
              resolve: (selection: unknown) => resolve(selection !== null)
            }
          })
        )
      ),
    point
  );
}

/** Choose an Options choice, shown as segments or, when crowded, a menu. */
async function choose(bar: Locator, label: string, choice: string) {
  const segments = bar.getByRole('radiogroup', { name: label });
  if ((await segments.count()) > 0) {
    await segments.getByRole('radio', { name: choice, exact: true }).click();
    return;
  }
  await bar
    .getByRole('combobox', { name: label })
    .selectOption({ label: choice });
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

/** The one Hole's stored data in the exported document. */
async function storedHole(
  page: Page
): Promise<Extract<FeatureData, { featureKind: 'hole' }>> {
  const holes = listFeaturesInOrder(await exportedDocument(page)).filter(
    (feature) => feature.data.featureKind === 'hole'
  );
  expect(holes).toHaveLength(1);
  return holes[0]!.data as Extract<FeatureData, { featureKind: 'hole' }>;
}

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

function holeRow(page: Page) {
  return page
    .locator('.feature-row', { hasText: /^Hole/ })
    .locator('.feature-row-main');
}

async function openHoleTool(page: Page) {
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
  return bar;
}

test(
  'Hole handles: displayed values are committed; Escape and undo restore the stored hole',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(240_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const canvas = await openBlock(page);
    const bar = await openHoleTool(page);
    await expect
      .poll(() => pickTop(canvas, CLICK), { timeout: 60_000 })
      .toBe(true);
    await expect(bar).toContainText('drag the diameter');

    // The diameter's ball stands on the rim of the bore the preview cuts,
    // at the snapped (23, 17), 3 mm along U (−Y): not on the raw click.
    await expect.poll(() => commandHandle(canvas, 'diameter')).not.toBeNull();
    const ball = (await commandHandle(canvas, 'diameter'))!;
    expect(ball.value).toBe(6);
    const rim = await projected(canvas, [BORE[0], BORE[1] - 3, BORE[2]]);
    expect(Math.hypot(ball.x - rim.x, ball.y - rim.y)).toBeLessThan(1.5);

    // Drag the ball out to about Ø9: the chip and the committed bore agree.
    const entry = await projected(canvas, BORE);
    await page.mouse.move(ball.x, ball.y);
    await page.mouse.down();
    await page.mouse.move(
      entry.x + (ball.x - entry.x) * 1.5,
      entry.y + (ball.y - entry.y) * 1.5,
      { steps: 16 }
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandle(canvas, 'diameter'))?.value ?? 0)
      .toBeGreaterThan(7.5);
    const dragged = (await commandHandle(canvas, 'diameter'))!.value;
    expect(dragged).toBeLessThan(10.5);
    await expect(page.getByTestId('command-handle-diameter')).toHaveText(
      `⌀ ${Math.round(dragged * 100) / 100} mm`
    );

    // Typed, the clicked hole stays where it stands: U and V read the
    // position it was drilled at.
    await bar.locator('summary').click();
    await choose(bar, 'Position', 'Typed');
    await bar.locator('summary').click();
    await expect
      .poll(async () => (await commandHandle(canvas, 'positionU'))?.value)
      .toBe(-2);
    expect((await commandHandle(canvas, 'positionV'))?.value).toBe(3);
    await finishInPlaceCommand(page, 'Hole');
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
      timeout: 30_000
    });
    const created = await storedHole(page);
    expect(created).toMatchObject({
      depthMode: 'through',
      position: { u: -2, v: 3 }
    });
    expect(Number(created.diameter)).toBeCloseTo(dragged, 6);

    // Re-armed from History, the chip reads the stored size; a value typed
    // on its keypad is the one committed.
    await revealModelPanel(page, 'History');
    await holeRow(page).click();
    const edit = page.getByRole('group', { name: 'Edit Hole command' });
    await expect(edit).toBeVisible();
    await expect(page.getByTestId('command-handle-diameter')).toHaveText(
      `⌀ ${Math.round(dragged * 100) / 100} mm`
    );
    await enterCommandValue(page, 'diameter', '8');
    await finishInPlaceCommand(page, 'Edit Hole');
    const keyed = await storedHole(page);
    expect(keyed).toMatchObject({
      diameter: 8,
      depthMode: 'through',
      position: { u: -2, v: 3 }
    });

    // The Options panel is the same value's owner: a blind depth typed
    // there is the depth the arrow shows and the hole stores.
    await holeRow(page).click();
    await expect(edit).toBeVisible();
    await edit.locator('summary').click();
    await choose(edit, 'Depth', 'Blind');
    const depthField = edit.getByRole('textbox', { name: 'Depth' });
    await depthField.fill('7');
    await depthField.press('Enter');
    await edit.locator('summary').click();
    await expect
      .poll(async () => (await commandHandle(canvas, 'depth'))?.value)
      .toBe(7);
    await finishInPlaceCommand(page, 'Edit Hole');
    const blind = await storedHole(page);
    expect(blind).toMatchObject({
      diameter: 8,
      depthMode: 'blind',
      depth: 7,
      position: { u: -2, v: 3 }
    });
    const history = page.getByRole('heading', { name: /^History \d+/ });
    const steps = await history.textContent();

    // Escape after a typed size and a drag leaves the stored hole exactly
    // as it was, and History gains nothing.
    await holeRow(page).click();
    await expect(edit).toBeVisible();
    await enterCommandValue(page, 'diameter', '3');
    await expect.poll(() => commandHandle(canvas, 'depth')).not.toBeNull();
    const depthBall = (await commandHandle(canvas, 'depth'))!;
    const bore = await projected(canvas, BORE);
    await page.mouse.move(depthBall.x, depthBall.y);
    await page.mouse.down();
    await page.mouse.move(
      bore.x + (depthBall.x - bore.x) * 1.6,
      bore.y + (depthBall.y - bore.y) * 1.6,
      { steps: 12 }
    );
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await expect(edit).toHaveCount(0);
    expect(await storedHole(page)).toEqual(blind);
    await expect(history).toHaveText(steps!);

    // Undo steps back to the keyed hole exactly, Redo to the blind one.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(async () => (await storedHole(page)).depthMode)
      .toBe('through');
    expect(await storedHole(page)).toEqual(keyed);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect
      .poll(async () => (await storedHole(page)).depthMode)
      .toBe('blind');
    expect(await storedHole(page)).toEqual(blind);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  }
);

test('a refused Hole step keeps its last preview, names the input, and Escape commits nothing', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  const canvas = await openBlock(page);
  const bar = await openHoleTool(page);
  await expect
    .poll(() => pickTop(canvas, CLICK), { timeout: 60_000 })
    .toBe(true);
  await bar.locator('summary').click();
  await choose(bar, 'Style', 'Counterbore');
  await bar.locator('summary').click();
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 60_000
  });
  // A counterbore narrower than the Ø6 bore is refused by name, and the
  // counterbore that built stays on screen meanwhile.
  await enterCommandValue(page, 'counterboreDiameter', '4');
  await expect(bar).toContainText('Counterbore ⌀:', { timeout: 30_000 });
  await expect(bar.getByRole('button', { name: /Done/ })).toBeDisabled();
  await expect
    .poll(async () => (await commandHandle(canvas, 'diameter'))?.value)
    .toBe(6);
  // The step's chip stays on the kept Ø10.8 counterbore's rim (5.4 mm
  // along V, +X), not on the refused Ø4 one's.
  const keptRim = await projected(canvas, [BORE[0] + 5.4, BORE[1], BORE[2]]);
  await expect
    .poll(async () => {
      const chip = await commandHandle(canvas, 'counterboreDiameter');
      return chip ? Math.hypot(chip.x - keptRim.x, chip.y - keptRim.y) : 1e9;
    })
    .toBeLessThan(2);
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  const document = await exportedDocument(page);
  expect(
    listFeaturesInOrder(document).filter(
      (feature) => feature.data.featureKind === 'hole'
    )
  ).toHaveLength(0);
});

test('a Hole in a millimetre document shown in inches reads and takes inches, and stores millimetres', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  const canvas = await openBlock(page, 'inch');
  const bar = await openHoleTool(page);
  await expect
    .poll(() => pickTop(canvas, CLICK), { timeout: 60_000 })
    .toBe(true);
  // The Ø6 mm default reads 0.236 in on its chip; 0.25 typed on the keypad
  // is a quarter inch, stored as 6.35 mm.
  const chip = page.getByTestId('command-handle-diameter');
  await expect(chip).toHaveText('⌀ 0.236 in');
  await enterCommandValue(page, 'diameter', '0.25');
  await expect(chip).toHaveText('⌀ 0.25 in');
  // A standard's table size reads in inches in the hint as in Options.
  await bar.locator('summary').click();
  await choose(bar, 'Standard', 'ISO metric');
  await choose(bar, 'Screw', 'M8');
  await bar.locator('summary').click();
  await expect(bar).toContainText('⌀ 0.354 in');
  await bar.locator('summary').click();
  await choose(bar, 'Standard', 'Any');
  await bar.locator('summary').click();
  await expect(chip).toHaveText('⌀ 0.25 in');
  await finishInPlaceCommand(page, 'Hole');
  await expectBodyCount(page, 1);
  const stored = await storedHole(page);
  expect(Number(stored.diameter)).toBeCloseTo(6.35, 9);
  expect(stored).not.toHaveProperty('standard');
});
