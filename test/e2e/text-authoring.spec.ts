import type { Locator, Page } from '@playwright/test';
import type { SketchObjectData } from '@openzcad/shared';
import {
  createProject,
  expect,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * Type-first text: `T` opens the text card at once, the outline of what is
 * typed follows the pointer over the plane, and a click places exactly that
 * string — the document never holds a placeholder.
 */

interface LiveSketchState {
  objects: { id: string; data: SketchObjectData }[];
  textPreview: { loops: number; origin: { x: number; y: number } } | null;
}

async function readLiveSketch(canvas: Locator): Promise<LiveSketchState> {
  return canvas.evaluate(
    (element) =>
      new Promise<LiveSketchState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: { resolve }
          })
        );
      })
  );
}

const textObjects = (state: LiveSketchState) =>
  state.objects.flatMap(({ data }) =>
    data.objectKind === 'text' ? [data] : []
  );

async function startTopSketch(page: Page) {
  await stubApi(page);
  await createProject(page, 'Lettering');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  // The grid readout is written by the render loop: once it shows, a frame
  // of the sketch has been drawn and the canvas hooks answer. That frame can
  // still be the start of the entry glide, and a click made while the camera
  // travels lands nowhere: wait for the view to come to rest.
  await expect(page.locator('.viewport-dock-grid')).toBeVisible();
  await waitForStillViewport(page);
  const canvas = page.locator('.viewer-host canvas');
  const bounds = (await canvas.boundingBox())!;
  return { canvas, bounds };
}

test('T opens the text card, the outline follows the typing, and a click places it', async ({
  page
}) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const { canvas, bounds } = await startTopSketch(page);

  await page.keyboard.press('t');
  const card = page.getByRole('form', { name: 'Place text' });
  await expect(card).toBeVisible();
  const field = card.getByLabel('Text', { exact: true });
  await expect(field).toBeFocused();
  await expect(card.getByRole('button', { name: 'Place' })).toBeDisabled();
  await expect(card.getByLabel('Size (em)')).toHaveValue('10');
  expect((await readLiveSketch(canvas)).textPreview).toBeNull();

  // Every keystroke lays the outline out again; nothing is written yet.
  await page.keyboard.type('B');
  await expect
    .poll(async () => (await readLiveSketch(canvas)).textPreview?.loops ?? 0)
    .toBeGreaterThan(0);
  const oneLetter = (await readLiveSketch(canvas)).textPreview!.loops;
  await page.keyboard.type('oa');
  await expect(field).toHaveValue('Boa');
  await expect
    .poll(async () => (await readLiveSketch(canvas)).textPreview?.loops ?? 0)
    .toBeGreaterThan(oneLetter);
  // Enter is not placement.
  await page.keyboard.press('Enter');
  await expect(card).toBeVisible();
  expect(textObjects(await readLiveSketch(canvas))).toEqual([]);
  await expect(card.getByRole('button', { name: 'Place' })).toBeEnabled();

  // The outline rides the pointer over the plane.
  const target = {
    x: bounds.x + bounds.width * 0.55,
    y: bounds.y + bounds.height * 0.6
  };
  await page.mouse.move(target.x - 60, target.y + 40);
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect
    .poll(async () => (await readLiveSketch(canvas)).textPreview?.origin)
    .not.toEqual({ x: 0, y: 0 });
  const preview = (await readLiveSketch(canvas)).textPreview!;
  await page.screenshot({
    path: test.info().outputPath('text-card-live-outline.png')
  });

  await page.mouse.click(target.x, target.y);
  await expect(card).toHaveCount(0);
  await expect
    .poll(async () => textObjects(await readLiveSketch(canvas)).length)
    .toBe(1);
  const [placed] = textObjects(await readLiveSketch(canvas));
  expect(placed).toMatchObject({
    text: 'Boa',
    fontFamily: 'open-sans',
    fontStyle: 'regular',
    size: 10
  });
  // Placed exactly where the outline was showing.
  expect(Number(placed!.x)).toBeCloseTo(preview.origin.x, 6);
  expect(Number(placed!.y)).toBeCloseTo(preview.origin.y, 6);
  expect((await readLiveSketch(canvas)).textPreview).toBeNull();

  // Back on Select with the object selected: the entity editor owns it now.
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(rail.getByRole('button', { name: 'Select' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  const editor = page.getByRole('form', { name: 'Edit text' });
  await expect(editor.getByLabel('Text', { exact: true })).toHaveValue('Boa');
  await expect(editor.getByLabel('Size (em)')).toHaveValue('10');
  await editor.getByLabel('Text', { exact: true }).fill('Bob');
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect
    .poll(async () => textObjects(await readLiveSketch(canvas))[0]?.text)
    .toBe('Bob');
  expect(
    textObjects(await readLiveSketch(canvas)).map(({ text }) => text)
  ).not.toContain('Text');
  expect(pageErrors).toEqual([]);
});

test('E while composing does not extrude or drop the draft', async ({
  page
}) => {
  test.setTimeout(60_000);
  const { canvas, bounds } = await startTopSketch(page);
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  // A closed profile, so E would otherwise start an extrude.
  const corner = {
    x: bounds.x + bounds.width * 0.3,
    y: bounds.y + bounds.height * 0.7
  };
  const rectangle = rail.getByRole('button', {
    name: 'Rectangle',
    exact: true
  });
  await rectangle.click();
  await expect(rectangle).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(corner.x, corner.y);
  await page.mouse.move(corner.x + 80, corner.y - 50, { steps: 4 });
  await page.mouse.click(corner.x + 80, corner.y - 50);
  await expect
    .poll(async () => (await readLiveSketch(canvas)).objects.length)
    .toBe(1);

  await page.keyboard.press('t');
  const card = page.getByRole('form', { name: 'Place text' });
  await expect(card.getByLabel('Text', { exact: true })).toBeFocused();
  await page.keyboard.type('Boa');
  // Focus moves to a card button, out of the text field.
  await card.getByRole('button', { name: 'B', exact: true }).click();
  await page.keyboard.press('e');
  await page.keyboard.press('l');
  await expect(card).toBeVisible();
  await expect(card.getByLabel('Text', { exact: true })).toHaveValue('Boa');
  await expect(rail).toBeVisible();
  await expect(
    rail.getByRole('button', { name: 'Text', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
});

test('the rail tile opens the same card, and Escape while composing leaves nothing', async ({
  page
}) => {
  test.setTimeout(60_000);
  const { canvas, bounds } = await startTopSketch(page);
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });

  await rail.getByRole('button', { name: 'Text', exact: true }).click();
  const card = page.getByRole('form', { name: 'Place text' });
  await expect(card).toBeVisible();
  await expect(card.getByLabel('Text', { exact: true })).toBeFocused();

  // A click on the plane with nothing typed places nothing.
  await page.mouse.click(
    bounds.x + bounds.width * 0.55,
    bounds.y + bounds.height * 0.6
  );
  await expect(card).toBeVisible();
  expect(textObjects(await readLiveSketch(canvas))).toEqual([]);
  // Focus is off the field now; a tool letter must not switch tools and
  // discard the composition.
  await page.keyboard.press('l');
  await expect(card).toBeVisible();
  await expect(
    rail.getByRole('button', { name: 'Text', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');

  await card.getByLabel('Text', { exact: true }).focus();
  await page.keyboard.type('Boa');
  await expect
    .poll(async () => (await readLiveSketch(canvas)).textPreview?.loops ?? 0)
    .toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect
    .poll(async () => (await readLiveSketch(canvas)).textPreview)
    .toBeNull();
  expect(textObjects(await readLiveSketch(canvas))).toEqual([]);
  // Still sketching, now on Select.
  await expect(rail.getByRole('button', { name: 'Select' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );

  // The next T starts from an empty string, not the abandoned one.
  await page.keyboard.press('t');
  await expect(
    page
      .getByRole('form', { name: 'Place text' })
      .getByLabel('Text', { exact: true })
  ).toHaveValue('');
});
