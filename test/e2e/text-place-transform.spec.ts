import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  createProject,
  expect,
  expectBodyCount,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';
import {
  OPEN_SANS_AREA_AT_10,
  OPEN_SANS_B_STEM_AT_10,
  textFramePoint
} from './textGlyphs';

/**
 * Place, then transform (plan Phase 2.3–2.4): the placing click is the only
 * step that writes a text object, and it hands over to Select with the
 * object selected, its move handle and rotation ring showing at once. From
 * then on — straight after placement or on re-entering the sketch — the
 * entity editor owns the object's values; the handles write through the
 * same commit path, and Escape mid-drag puts the stored values back.
 */

type TextData = Extract<SketchObjectData, { objectKind: 'text' }>;

interface LiveSketchState {
  objects: { id: string; data: SketchObjectData }[];
  textPreview: { loops: number; origin: { x: number; y: number } } | null;
  screen: { x: number; y: number }[];
}

/** The rig's sketch objects, and `project` plane points in client pixels. */
async function readLiveSketch(
  canvas: Locator,
  project: { x: number; y: number }[] = []
): Promise<LiveSketchState> {
  return canvas.evaluate(
    (element, points) =>
      new Promise<LiveSketchState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: { project: points, resolve }
          })
        );
      }),
    project
  );
}

async function onlyText(canvas: Locator): Promise<TextData> {
  const texts = (await readLiveSketch(canvas)).objects.flatMap(({ data }) =>
    data.objectKind === 'text' ? [data] : []
  );
  expect(texts).toHaveLength(1);
  return texts[0]!;
}

/** Where the selected object's grab dot is drawn, once the view is still. */
async function grabHandleCenter(page: Page) {
  const handle = page.locator('.sketch-grab-handle');
  await expect(handle).toBeVisible();
  await waitForStillViewport(page);
  const box = (await handle.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The move or turn readout the drag writes beside the pointer. */
async function dragReadout(page: Page): Promise<string> {
  return (await page.locator('.sketch-dim-label').textContent()) ?? '';
}

async function startTopSketch(page: Page, name: string) {
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await createProject(page, name);
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await expect(page.locator('.viewport-dock-grid')).toBeVisible();
  await waitForStillViewport(page);
  const canvas = page.locator('.viewer-host canvas');
  return { canvas, bounds: (await canvas.boundingBox())! };
}

test('the placed text shows its handles at once, and they move and turn it', async ({
  page
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { canvas, bounds } = await startTopSketch(page, 'Place Transform');

  await page.keyboard.press('t');
  const card = page.getByRole('form', { name: 'Place text' });
  await expect(card.getByLabel('Text', { exact: true })).toBeFocused();
  await page.keyboard.type('Boa');
  const target = {
    x: bounds.x + bounds.width * 0.45,
    y: bounds.y + bounds.height * 0.6
  };
  await page.mouse.move(target.x - 40, target.y + 30);
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await page.mouse.click(target.x, target.y);
  await expect(card).toHaveCount(0);

  // One click placed it, and that click is all it takes: the selection, the
  // editor and both handles are there without a second click on the object.
  const editor = page.getByRole('form', { name: 'Edit text' });
  await expect(editor).toBeVisible();
  await expect(page.locator('.sketch-grab-handle')).toBeVisible();
  await expect(page.locator('.sketch-rotate-ring')).toBeVisible();
  await expect(
    page
      .getByRole('toolbar', { name: 'Sketch tools' })
      .getByRole('button', { name: 'Select' })
  ).toHaveAttribute('aria-pressed', 'true');
  const field = (label: string) => editor.getByLabel(label, { exact: true });
  const placed = {
    x: await field('X').inputValue(),
    y: await field('Y').inputValue()
  };
  await page.screenshot({
    path: test.info().outputPath('placed-text-handles.png')
  });

  // Escape mid-drag puts the stored origin back and keeps the selection.
  let origin = await grabHandleCenter(page);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 90, origin.y - 40, { steps: 10 });
  const grab = page.locator('.sketch-grab-handle');
  await expect(grab).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(grab).toHaveAttribute('data-active', 'false');
  await expect(editor).toBeVisible();
  await expect(field('X')).toHaveValue(placed.x);
  await expect(field('Y')).toHaveValue(placed.y);
  await expect(page.getByRole('contentinfo')).not.toContainText('Moved text.');
  expect(await onlyText(canvas)).toMatchObject({
    x: Number(placed.x),
    y: Number(placed.y)
  });

  // A drag moves it: the stored origin is the one the readout showed at
  // release, snaps included.
  origin = await grabHandleCenter(page);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 120, origin.y - 70, { steps: 12 });
  const moveReadout = /X (-?[\d.]+) · Y (-?[\d.]+)/.exec(
    await dragReadout(page)
  );
  expect(moveReadout).not.toBeNull();
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText('Moved text.');
  await expect(field('X')).toHaveValue(moveReadout![1]!);
  await expect(field('Y')).toHaveValue(moveReadout![2]!);
  expect(`${moveReadout![1]},${moveReadout![2]}`).not.toBe(
    `${placed.x},${placed.y}`
  );

  // The ring turns it about the origin; the stored turn is the readout's.
  const ring = page.locator('.sketch-rotate-ring');
  await expect(ring).toBeVisible();
  await waitForStillViewport(page);
  const ringBox = (await ring.boundingBox())!;
  const center = {
    x: ringBox.x + ringBox.width / 2,
    y: ringBox.y + ringBox.height / 2
  };
  const radius = ringBox.width / 2 - 1;
  await page.mouse.move(center.x + radius, center.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    const angle = (step / 10) * (Math.PI / 3);
    await page.mouse.move(
      center.x + radius * Math.cos(angle),
      center.y - radius * Math.sin(angle)
    );
  }
  const turnReadout = /(-?[\d.]+)°/.exec(await dragReadout(page));
  expect(turnReadout).not.toBeNull();
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText('Rotated text.');
  await expect(field('Rotation')).toHaveValue(turnReadout![1]!);
  expect(Math.abs(Number(turnReadout![1]))).toBeGreaterThan(30);
  // Turning is not moving.
  await expect(field('X')).toHaveValue(moveReadout![1]!);
  await expect(field('Y')).toHaveValue(moveReadout![2]!);
  expect(await onlyText(canvas)).toMatchObject({
    text: 'Boa',
    x: Number(moveReadout![1]),
    y: Number(moveReadout![2]),
    rotation: Number(turnReadout![1])
  });
  expect(errors).toEqual([]);
});

test('T, type, Place with the keyboard alone puts the text on the sketch origin', async ({
  page
}) => {
  test.setTimeout(60_000);
  const { canvas } = await startTopSketch(page, 'Keyboard Place');
  // The pointer never reaches the plane in this test.
  await page.keyboard.press('t');
  const card = page.getByRole('form', { name: 'Place text' });
  await expect(card.getByLabel('Text', { exact: true })).toBeFocused();
  await page.keyboard.type('Hi');
  await expect
    .poll(async () => (await readLiveSketch(canvas)).textPreview?.origin)
    .toEqual({ x: 0, y: 0 });

  const place = card.getByRole('button', { name: 'Place' });
  await expect(place).toBeEnabled();
  await place.focus();
  await page.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
  expect(await onlyText(canvas)).toMatchObject({ text: 'Hi', x: 0, y: 0 });
  const editor = page.getByRole('form', { name: 'Edit text' });
  await expect(editor.getByLabel('X', { exact: true })).toHaveValue('0');
  await expect(editor.getByLabel('Y', { exact: true })).toHaveValue('0');
  await expect(page.locator('.sketch-grab-handle')).toBeVisible();
  await expect(page.locator('.sketch-rotate-ring')).toBeVisible();
});

/** Serves `document` as the project the start screen's Create returns. */
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
  await page.getByRole('button', { name: 'Create project' }).click();
}

/** The exported project document, which is what a save would write. */
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

/** The plate's volume as the inspector reads it out. */
async function plateVolume(page: Page): Promise<number> {
  const bodies = page.getByRole('button', { name: /^Bodies \d/ });
  if ((await bodies.getAttribute('aria-expanded')) === 'false') {
    await bodies.click();
  }
  await page.locator('.body-row:not(.consumed) .body-row-main').last().click();
  const readout = page
    .getByRole('region', { name: 'Feature inspector' })
    .getByText(/mm³/)
    .first();
  await expect(readout).toBeVisible();
  return Number(((await readout.textContent()) ?? '').replace(/[^\d.]/g, ''));
}

interface RegionHandle {
  x: number;
  y: number;
  dx: number;
  dy: number;
  pixelsPerUnit: number;
}

test('text placed on a face engraves exactly, and a re-entry edit rebuilds it', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const SLAB = { width: 62, height: 50, depth: 10 } as const;
  const document = addPrimitiveFeature(
    createProjectDocument('Engraved plate', toUserId('user_e2e')),
    { name: 'Plate', primitiveKind: 'box', dimensions: { ...SLAB } }
  );
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });

  // Sketch on the plate's top face.
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            new Promise<{ lineageName?: string } | null>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-planar-face', {
                  detail: {
                    normal: { x: 0, y: 0, z: 1 },
                    select: true,
                    resolve
                  }
                })
              );
            })
        ),
      { timeout: 20_000 }
    )
    .toMatchObject({ lineageName: 'primitive.box.face.z-max' });
  await page.getByRole('button', { name: 'Selection: Sketch' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(sketchTools).toBeVisible();
  await expect(page.locator('.viewport-dock-grid')).toBeVisible();
  await waitForStillViewport(page);

  // T, type, click: placed where it fits on the face whichever way the
  // face's axes run on screen.
  await page.keyboard.press('t');
  const card = page.getByRole('form', { name: 'Place text' });
  await expect(card.getByLabel('Text', { exact: true })).toBeFocused();
  await page.keyboard.type('Boa');
  const [spot] = (await readLiveSketch(canvas, [{ x: -14, y: -3 }])).screen;
  await page.mouse.move(spot!.x + 30, spot!.y + 30);
  await page.mouse.move(spot!.x, spot!.y, { steps: 6 });
  await page.mouse.click(spot!.x, spot!.y);
  await expect(card).toHaveCount(0);
  const editor = page.getByRole('form', { name: 'Edit text' });
  await expect(editor).toBeVisible();
  await expect(page.locator('.sketch-grab-handle')).toBeVisible();
  await page.getByRole('button', { name: 'Finish Sketch' }).click();
  await expect(sketchTools).toBeHidden();

  // A glyph pick takes the whole word; one drag into the plate engraves it.
  await canvas.evaluate((element) =>
    element.dispatchEvent(
      new CustomEvent('openzcad:e2e-select-profile', {
        detail: { index: 0, additive: false }
      })
    )
  );
  const extrude = page.getByRole('form', { name: 'Extrude settings' });
  await expect(extrude).toContainText('3 selected profiles');
  await expect
    .poll(
      async () =>
        (
          await canvas.evaluate(
            (element) =>
              JSON.parse(
                element.dataset.e2eRegionHandles ?? '[]'
              ) as RegionHandle[]
          )
        ).length
    )
    .toBeGreaterThan(0);
  const [arrow] = await canvas.evaluate(
    (element) =>
      JSON.parse(element.dataset.e2eRegionHandles ?? '[]') as RegionHandle[]
  );
  const bounds = (await canvas.boundingBox())!;
  const start = { x: bounds.x + arrow!.x, y: bounds.y + arrow!.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x - arrow!.dx * arrow!.pixelsPerUnit * 2,
    start.y - arrow!.dy * arrow!.pixelsPerUnit * 2,
    { steps: 10 }
  );
  await expect(page.getByTestId('direct-manipulation-value')).toHaveText(/-\d/);
  await page.mouse.up();
  await extrude.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    /Extruded region by -[\d.]+ mm \(cut\)\./,
    { timeout: 60_000 }
  );
  await expectBodyCount(page, 1);
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).not.toContainText('Saving');
  const stored = listFeaturesInOrder(await exportedDocument(page)).flatMap(
    (feature) => (feature.data.featureKind === 'extrude' ? [feature.data] : [])
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]!.operation).toBe('cut');
  const depth = Math.abs(Number(stored[0]!.distance));
  expect(depth).toBeGreaterThan(0);
  expect(depth).toBeLessThan(SLAB.depth);
  const slab = SLAB.width * SLAB.height * SLAB.depth;
  // Exact: the slab less the word's glyph area, counters and all, times the
  // stored depth. A word cut without its counters, or the kernel's refusal
  // leaving the bare slab, misses this by far more than the readout's 0.01.
  expect(await plateVolume(page)).toBeCloseTo(
    slab - OPEN_SANS_AREA_AT_10.Boa * depth,
    1
  );

  // Back into the sketch: the existing text selects to the same handles and
  // the same editor.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Edit Sketch', exact: true }).click();
  await expect(sketchTools).toBeVisible();
  await sketchTools.getByRole('button', { name: 'Select' }).click();
  await waitForStillViewport(page);
  const before = await onlyText(canvas);
  const [onOutline] = (
    await readLiveSketch(canvas, [
      textFramePoint(before, OPEN_SANS_B_STEM_AT_10)
    ])
  ).screen;
  await page.mouse.click(onOutline!.x, onOutline!.y);
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Text', { exact: true })).toHaveValue('Boa');
  await expect(page.locator('.sketch-grab-handle')).toBeVisible();
  await expect(page.locator('.sketch-rotate-ring')).toBeVisible();
  const field = (label: string) => editor.getByLabel(label, { exact: true });
  const storedX = await field('X').inputValue();
  const storedY = await field('Y').inputValue();

  // Escape during a re-entry drag restores the stored values; nothing is
  // deleted or written.
  let origin = await grabHandleCenter(page);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 40, origin.y + 25, { steps: 8 });
  await expect(page.locator('.sketch-grab-handle')).toHaveAttribute(
    'data-active',
    'true'
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.sketch-grab-handle')).toHaveAttribute(
    'data-active',
    'false'
  );
  await expect(field('X')).toHaveValue(storedX);
  await expect(field('Y')).toHaveValue(storedY);
  expect(await onlyText(canvas)).toEqual(before);

  // One owner: a string typed into the editor survives a handle drag, which
  // lands in X and Y; Apply then writes both through the same path.
  await field('Text').fill('Boat');
  origin = await grabHandleCenter(page);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 12, origin.y + 12, { steps: 6 });
  const moved = /X (-?[\d.]+) · Y (-?[\d.]+)/.exec(await dragReadout(page));
  expect(moved).not.toBeNull();
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText('Moved text.', {
    timeout: 60_000
  });
  await expect(field('X')).toHaveValue(moved![1]!);
  await expect(field('Y')).toHaveValue(moved![2]!);
  await expect(field('Text')).toHaveValue('Boat');
  expect((await onlyText(canvas)).text).toBe('Boa');
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Updated text geometry.',
    { timeout: 60_000 }
  );
  expect(await onlyText(canvas)).toMatchObject({
    text: 'Boat',
    x: Number(moved![1]),
    y: Number(moved![2])
  });

  // The engrave follows the new string, still exact.
  await page.getByRole('button', { name: 'Finish Sketch' }).click();
  await expect(sketchTools).toBeHidden();
  await expect
    .poll(() => plateVolume(page), { timeout: 60_000 })
    .toBeCloseTo(slab - OPEN_SANS_AREA_AT_10.Boat * depth, 1);
  expect(errors).toEqual([]);
});
