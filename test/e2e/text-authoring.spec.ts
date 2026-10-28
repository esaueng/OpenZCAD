import type { Locator, Page } from '@playwright/test';
import type { SketchObjectData, UnitSystem } from '@openzcad/shared';
import {
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

async function startTopSketch(
  page: Page,
  {
    name = 'Lettering',
    units = 'mm'
  }: { name?: string; units?: UnitSystem } = {}
) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByLabel('Units').selectOption(units);
  await page.getByRole('button', { name: 'Create project' }).click();
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

test('T opens the text card, the outline follows the typing, and a click places it', { tag: '@ci-smoke' }, async ({
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
  // A rectangle is four sides held as one shape.
  await expect
    .poll(async () => (await readLiveSketch(canvas)).objects.length)
    .toBe(4);

  await page.keyboard.press('t');
  const card = page.getByRole('form', { name: 'Place text' });
  await expect(card.getByLabel('Text', { exact: true })).toBeFocused();
  await page.keyboard.type('Boa');
  // Focus moves to a card button, out of the text field.
  await card.getByRole('button', { name: 'Bold', exact: true }).click();
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

for (const [units, mmPerUnit] of [
  ['mm', 1],
  ['cm', 10],
  ['inch', 25.4]
] as const satisfies readonly (readonly [UnitSystem, number])[]) {
  test(`unit-bearing typed text previews, places and reopens in ${units}`, async ({
    page
  }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { canvas, bounds } = await startTopSketch(page, {
      name: `QA typed text units ${units}`,
      units
    });
    await expect(page).toHaveTitle('OpenZCAD');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.keyboard.press('t');
    const card = page.getByRole('form', { name: 'Place text' });
    const size = card.getByLabel('Size (em)');
    const place = card.getByRole('button', { name: 'Place', exact: true });
    await card.getByLabel('Text', { exact: true }).fill('Boa');
    const target = {
      x: bounds.x + bounds.width * 0.55,
      y: bounds.y + bounds.height * 0.6
    };

    // The card and the canvas must both refuse an angle in a length field.
    // A click cannot sneak an invalid draft past the disabled Place button.
    await size.fill('30 deg');
    await expect(size).toHaveAttribute('aria-invalid', 'true');
    await expect(place).toBeDisabled();
    await expect
      .poll(async () => (await readLiveSketch(canvas)).textPreview)
      .toBeNull();
    await size.press('Enter');
    await page.mouse.click(target.x, target.y);
    await expect(card).toBeVisible();
    expect(textObjects(await readLiveSketch(canvas))).toEqual([]);

    // This is the same physical em size in all three documents. The outline
    // exists before any object does, then the card and the plane use the
    // same original expression when placing it.
    await size.fill('1 in');
    await expect(size).not.toHaveAttribute('aria-invalid');
    await expect(size).toHaveAccessibleDescription(`= ${25.4 / mmPerUnit}`);
    await expect(place).toBeEnabled();
    await page.mouse.move(target.x - 40, target.y + 20);
    await page.mouse.move(target.x, target.y, { steps: 4 });
    await expect
      .poll(async () => (await readLiveSketch(canvas)).textPreview?.loops ?? 0)
      .toBeGreaterThan(0);
    const preview = (await readLiveSketch(canvas)).textPreview!;
    expect(textObjects(await readLiveSketch(canvas))).toEqual([]);
    await testInfo.attach(`${units}-typed-text-preview`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`${units}-text-preview.png`)
      }),
      contentType: 'image/png'
    });
    // Exercise both actual entry points, not only their enabled appearance.
    if (units === 'cm') await place.click();
    else await page.mouse.click(target.x, target.y);
    await expect(card).toHaveCount(0);
    await expect
      .poll(async () => textObjects(await readLiveSketch(canvas)).length)
      .toBe(1);
    const placed = textObjects(await readLiveSketch(canvas))[0]!;
    expect(placed).toMatchObject({ text: 'Boa', size: '1 in' });
    expect(Number(placed.x)).toBeCloseTo(preview.origin.x, 6);
    expect(Number(placed.y)).toBeCloseTo(preview.origin.y, 6);
    expect((await readLiveSketch(canvas)).textPreview).toBeNull();
    const editor = page.getByRole('form', { name: 'Edit text' });
    await expect(editor.getByLabel('Size (em)')).toHaveValue('1 in');
    await expect(editor.getByLabel('Size (em)')).toHaveAccessibleDescription(
      `= ${25.4 / mmPerUnit}`
    );
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();

    // Wait for a completed device write, then reopen the authored sketch.
    // Reopening the stubbed project presents the saved device copy as local.
    await expect(page.locator('.save-state')).toHaveClass(
      /\bis-(?:local|synced)(?:\s|$)/
    );
    await page.reload();
    await expect(page.locator('.feature-row-main')).toHaveCount(1);
    await page.locator('.feature-row-main').click();
    await page
      .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
      .click();
    const palette = page.getByRole('button', {
      name: 'Sketch palette',
      exact: true
    });
    await expect(palette).toBeVisible();
    if ((await palette.getAttribute('aria-expanded')) !== 'true')
      await palette.click();
    const overview = page.getByRole('region', { name: 'Sketch overview' });
    await expect(overview).toBeVisible();
    await expect
      .poll(async () => textObjects(await readLiveSketch(canvas)).length)
      .toBe(1);
    const object = (await readLiveSketch(canvas)).objects[0]!;
    expect(object.data).toMatchObject({ text: 'Boa', size: '1 in' });
    await overview.getByLabel('Selected geometry').selectOption(object.id);
    await expect(editor.getByLabel('Text', { exact: true })).toHaveValue('Boa');
    await expect(editor.getByLabel('Size (em)')).toHaveValue('1 in');
    await expect(editor.getByLabel('Size (em)')).not.toHaveAttribute(
      'aria-invalid'
    );
    await expect(editor.getByLabel('Size (em)')).toHaveAccessibleDescription(
      `= ${25.4 / mmPerUnit}`
    );
    await testInfo.attach(`${units}-typed-text-reopened`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`${units}-text-reopened.png`)
      }),
      contentType: 'image/png'
    });
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    expect(errors).toEqual([]);
  });
}
